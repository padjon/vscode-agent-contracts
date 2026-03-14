import * as path from "path";
import * as vscode from "vscode";
import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";

import {
  contractUriForFolder,
  defaultContract,
  detectRecommendedVerification,
  readContract,
  writeContract
} from "./contracts";
import { analyzeWorkspace } from "./analyzer";
import { getChangedFiles } from "./git";
import { buildGuideMarkdown } from "./guide";
import { CONTRACT_PRESETS } from "./presets";
import { buildMarkdownReport } from "./report";
import { AnalysisReport, AgentContract, Finding } from "./types";

type TreeNode = GroupItem | FindingsItem;

class GroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly children: TreeNode[],
    description?: string
  ) {
    super(
      label,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.description = description;
  }
}

class FindingsItem extends vscode.TreeItem {
  constructor(label: string, description?: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.command = command;
  }
}

class FindingsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private latestReport: AnalysisReport | undefined;

  async refresh(showNotification = false, scope: "workspace" | "changes" = "workspace"): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const changedFiles = scope === "changes" && folder ? await getChangedFiles(folder).catch(() => []) : [];
    this.latestReport = await analyzeWorkspace({ scope, changedFiles });
    this.onDidChangeTreeDataEmitter.fire(undefined);

    if (showNotification) {
      void vscode.window.showInformationMessage(this.latestReport.summary);
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    if (element instanceof GroupItem) {
      return Promise.resolve(element.children);
    }

    if (!this.latestReport) {
      return Promise.resolve([
        new FindingsItem("Analyze workspace", "Run the first scan", {
          command: "agentContracts.analyzeWorkspace",
          title: "Analyze Workspace"
        })
      ]);
    }

    const report = this.latestReport;
    const summaryItems: TreeNode[] = [
      new FindingsItem(`Trust Score ${report.trustScore}/100`, `${report.scope} scan`, {
        command: "agentContracts.openReport",
        title: "Open Report"
      }),
      new FindingsItem("How It Works", "Open the built-in guide", {
        command: "agentContracts.openGuide",
        title: "How It Works"
      }),
      new FindingsItem("Open Report", `${report.findings.length} findings`, {
        command: "agentContracts.openReport",
        title: "Open Report"
      }),
      new FindingsItem("Analyze Changed Files", `${report.changedFiles.length} changed file(s)`, {
        command: "agentContracts.analyzeChangedFiles",
        title: "Analyze Changed Files"
      })
    ];

    if (!report.contractExists) {
      summaryItems.push(
        new FindingsItem("Initialize Contract", report.contractPath, {
          command: "agentContracts.initializeContract",
          title: "Initialize Contract"
        })
      );
    }

    if (report.recommendedVerification.length > 0) {
      summaryItems.push(
        new FindingsItem("Add Recommended Verification", `${report.recommendedVerification.length} command(s) available`, {
          command: "agentContracts.addRecommendedVerification",
          title: "Add Recommended Verification"
        })
      );
    }

    if (report.sensitiveFiles.length > 0) {
      summaryItems.push(
        new FindingsItem("Protect Sensitive Paths", `${report.sensitiveFiles.length} sensitive file(s) seen`, {
          command: "agentContracts.protectSensitivePaths",
          title: "Protect Sensitive Paths"
        })
      );
    }

    summaryItems.push(
      new FindingsItem("Apply Preset", "Node, Python, or Terraform", {
        command: "agentContracts.applyPreset",
        title: "Apply Preset"
      })
    );

    const groups = buildFindingGroups(report.findings);
    const items: TreeNode[] = [
      new GroupItem("Workspace", summaryItems, `${report.findings.length} findings`)
    ];

    for (const group of groups) {
      items.push(group);
    }

    return Promise.resolve(items);
  }

  getLatestReport(): AnalysisReport | undefined {
    return this.latestReport;
  }
}

function buildFindingGroups(findings: Finding[]): GroupItem[] {
  const groupSpecs: Array<{ label: string; severity: Finding["severity"] }> = [
    { label: "Critical", severity: "critical" },
    { label: "High", severity: "high" },
    { label: "Medium", severity: "medium" },
    { label: "Low", severity: "low" }
  ];

  return groupSpecs
    .map(({ label, severity }) => {
      const children = findings
        .filter((finding) => finding.severity === severity)
        .slice(0, 12)
        .map(toFindingItem);
      return new GroupItem(label, children, children.length > 0 ? `${children.length}` : "0");
    })
    .filter((group) => group.children.length > 0);
}

function toFindingItem(finding: Finding): FindingsItem {
  const item = new FindingsItem(finding.title, finding.severity.toUpperCase());
  item.tooltip = `${finding.description}${finding.recommendation ? `\n\nRecommendation: ${finding.recommendation}` : ""}`;
  item.contextValue = finding.severity;

  switch (finding.severity) {
    case "critical":
      item.iconPath = new vscode.ThemeIcon("error");
      break;
    case "high":
      item.iconPath = new vscode.ThemeIcon("warning");
      break;
    case "medium":
      item.iconPath = new vscode.ThemeIcon("alert");
      break;
    default:
      item.iconPath = new vscode.ThemeIcon("info");
      break;
  }

  return item;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new FindingsProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection("agentContracts");

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentContracts.findings", provider),
    diagnostics,
    vscode.languages.registerCodeActionsProvider(
      [{ language: "json" }, { language: "jsonc" }],
      new AgentContractsCodeActionProvider(provider),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.analyzeWorkspace", async () => {
      await provider.refresh(true, "workspace");
      publishDiagnostics(diagnostics, provider.getLatestReport());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.analyzeChangedFiles", async () => {
      await provider.refresh(true, "changes");
      publishDiagnostics(diagnostics, provider.getLatestReport());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.initializeContract", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage("Open a workspace folder before initializing a contract.");
        return;
      }

      const uri = contractUriForFolder(folder);
      const recommendedVerification = await detectRecommendedVerification(folder);
      await writeContract(uri, defaultContract(recommendedVerification));

      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      await provider.refresh(true, "workspace");
      publishDiagnostics(diagnostics, provider.getLatestReport());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.openReport", async () => {
      if (!provider.getLatestReport()) {
        await provider.refresh(false);
      }

      const report = provider.getLatestReport();
      if (!report) {
        return;
      }

      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: buildMarkdownReport(report)
      });
      await vscode.window.showTextDocument(document, { preview: false });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.openGuide", async () => {
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: buildGuideMarkdown()
      });
      await vscode.window.showTextDocument(document, { preview: false });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.addRecommendedVerification", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return;
      }

      const report = provider.getLatestReport() ?? await analyzeWorkspace();
      const uri = contractUriForFolder(folder);
      const contract = await ensureContract(folder);
      const merged = unique([...contract.requiredVerification, ...report.recommendedVerification]);
      await writeContract(uri, { ...contract, requiredVerification: merged });
      await provider.refresh(true, report.scope);
      publishDiagnostics(diagnostics, provider.getLatestReport());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.protectSensitivePaths", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return;
      }

      const report = provider.getLatestReport() ?? await analyzeWorkspace();
      const uri = contractUriForFolder(folder);
      const contract = await ensureContract(folder);
      const merged = unique([...contract.protectedPaths, ...report.sensitiveFiles]);
      await writeContract(uri, { ...contract, protectedPaths: merged });
      await provider.refresh(true, report.scope);
      publishDiagnostics(diagnostics, provider.getLatestReport());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.applyPreset", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return;
      }

      const selection = await vscode.window.showQuickPick(
        CONTRACT_PRESETS.map((preset) => ({
          label: preset.label,
          description: preset.description,
          preset
        })),
        {
          title: "Apply contract preset"
        }
      );

      if (!selection) {
        return;
      }

      const uri = contractUriForFolder(folder);
      const existing = await readContract(uri);
      const merged = existing ? mergeContracts(existing, selection.preset.contract) : selection.preset.contract;
      await writeContract(uri, merged);

      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      await provider.refresh(true, "workspace");
      publishDiagnostics(diagnostics, provider.getLatestReport());
    })
  );

  const autoRefresh = vscode.workspace
    .getConfiguration("agentContracts")
    .get<boolean>("autoRefresh", true);

  if (autoRefresh) {
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(async (document) => {
        const fileName = document.uri.path;
        if (
          fileName.endsWith("/mcp.json") ||
          fileName.endsWith(".agent-contract.json") ||
          fileName.endsWith("/package.json")
        ) {
          await provider.refresh(false, "workspace");
          publishDiagnostics(diagnostics, provider.getLatestReport());
        }
      })
    );
  }

  void provider.refresh(false, "workspace").then(() => {
    publishDiagnostics(diagnostics, provider.getLatestReport());
  });
}

export function deactivate(): void {}

async function ensureContract(folder: vscode.WorkspaceFolder): Promise<AgentContract> {
  const uri = contractUriForFolder(folder);
  const existing = await readContract(uri);
  if (existing) {
    return existing;
  }

  const recommendedVerification = await detectRecommendedVerification(folder);
  const contract = defaultContract(recommendedVerification);
  await writeContract(uri, contract);
  return contract;
}

function publishDiagnostics(
  diagnostics: vscode.DiagnosticCollection,
  report: AnalysisReport | undefined
): void {
  diagnostics.clear();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !report) {
    return;
  }

  const grouped = new Map<string, vscode.Diagnostic[]>();
  for (const finding of report.findings) {
    if (!finding.location || finding.location.includes(",")) {
      continue;
    }

    const uri = vscode.Uri.joinPath(folder.uri, ...finding.location.split("/"));
    const range = toDiagnosticRange(finding, uri);
    const diagnostic = new vscode.Diagnostic(
      range,
      finding.recommendation ? `${finding.title}: ${finding.recommendation}` : finding.title,
      toDiagnosticSeverity(finding)
    );
    diagnostic.source = "Agent Contracts";
    diagnostic.code = finding.id;

    const current = grouped.get(uri.toString()) ?? [];
    current.push(diagnostic);
    grouped.set(uri.toString(), current);
  }

  for (const [uriString, items] of grouped) {
    diagnostics.set(vscode.Uri.parse(uriString), items);
  }
}

function toDiagnosticSeverity(finding: Finding): vscode.DiagnosticSeverity {
  switch (finding.severity) {
    case "critical":
    case "high":
      return vscode.DiagnosticSeverity.Warning;
    case "medium":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function toDiagnosticRange(finding: Finding, uri: vscode.Uri): vscode.Range {
  const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
  if (!document) {
    return new vscode.Range(0, 0, 0, 1);
  }

  const range = finding.range ?? findJsonPathRange(document.getText(), finding.jsonPath);
  if (!range) {
    return new vscode.Range(0, 0, 0, 1);
  }

  const start = document.positionAt(range.offset);
  const end = document.positionAt(range.offset + Math.max(range.length, 1));
  return new vscode.Range(start, end);
}

class AgentContractsCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly provider: FindingsProvider) {}

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const report = this.provider.getLatestReport();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!report || !folder) {
      return [];
    }

    const relativePath = path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join("/");
    return report.findings
      .filter((finding) => finding.location === relativePath && finding.fix)
      .filter((finding) => range.intersection(rangeFromFinding(document, finding)) !== undefined)
      .map((finding) => createQuickFix(document, finding))
      .filter((action): action is vscode.CodeAction => action !== undefined);
  }
}

function createQuickFix(document: vscode.TextDocument, finding: Finding): vscode.CodeAction | undefined {
  if (!finding.fix) {
    return undefined;
  }

  try {
    const updated = applyFindingFix(document.getText(), finding);
    const action = new vscode.CodeAction(finding.fix.title, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    action.edit.replace(document.uri, fullRange, updated);
    action.diagnostics = [
      new vscode.Diagnostic(
        rangeFromFinding(document, finding),
        finding.title,
        toDiagnosticSeverity(finding)
      )
    ];
    return action;
  } catch {
    return undefined;
  }
}

function applyFindingFix(text: string, finding: Finding): string {
  if (!finding.fix) {
    return text;
  }

  if (finding.fix.kind === "append-unique") {
    const current = JSON.parse(text) as unknown;
    const existing = getValueAtPath(current, finding.fix.path);
    const merged = Array.isArray(existing)
      ? [...new Set([...existing, ...(Array.isArray(finding.fix.value) ? finding.fix.value : [])])]
      : Array.isArray(finding.fix.value)
        ? [...new Set(finding.fix.value)]
        : [];
    const edits = modify(text, finding.fix.path, merged, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2
      }
    });
    return applyEdits(text, edits);
  }

  const edits = modify(
    text,
    finding.fix.path,
    finding.fix.kind === "remove-property" ? undefined : finding.fix.value,
    {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2
      }
    }
  );
  return applyEdits(text, edits);
}

function rangeFromFinding(document: vscode.TextDocument, finding: Finding): vscode.Range {
  const range = finding.range ?? findJsonPathRange(document.getText(), finding.jsonPath);
  if (!range) {
    return new vscode.Range(0, 0, 0, 1);
  }

  const start = document.positionAt(range.offset);
  const end = document.positionAt(range.offset + Math.max(range.length, 1));
  return new vscode.Range(start, end);
}

function getValueAtPath(root: unknown, pathSegments: Array<string | number>): unknown {
  let current = root;
  for (const segment of pathSegments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[String(segment)];
  }

  return current;
}

function mergeContracts(base: AgentContract, incoming: AgentContract): AgentContract {
  return {
    protectedPaths: unique([...base.protectedPaths, ...incoming.protectedPaths]),
    requiredVerification: unique([...base.requiredVerification, ...incoming.requiredVerification]),
    blockedCommands: unique([...base.blockedCommands, ...incoming.blockedCommands]),
    blockedMcpServers: unique([...base.blockedMcpServers, ...incoming.blockedMcpServers]),
    notes: base.notes ?? incoming.notes
  };
}

function findJsonPathRange(
  text: string,
  jsonPath: Array<string | number> | undefined
): { offset: number; length: number } | undefined {
  if (!jsonPath) {
    return undefined;
  }

  const root = parseTree(text);
  const node = root ? findNodeAtLocation(root, jsonPath) : undefined;
  if (!node) {
    return undefined;
  }

  return {
    offset: node.offset,
    length: node.length
  };
}

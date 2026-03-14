import * as vscode from "vscode";

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
import { buildMarkdownReport } from "./report";
import { AnalysisReport, AgentContract, Finding } from "./types";

class FindingsItem extends vscode.TreeItem {
  constructor(label: string, description?: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.command = command;
  }
}

class FindingsProvider implements vscode.TreeDataProvider<FindingsItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FindingsItem | undefined>();
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

  getTreeItem(element: FindingsItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<FindingsItem[]> {
    if (!this.latestReport) {
      return Promise.resolve([
        new FindingsItem("Analyze workspace", "Run the first scan", {
          command: "agentContracts.analyzeWorkspace",
          title: "Analyze Workspace"
        })
      ]);
    }

    const report = this.latestReport;
    const items: FindingsItem[] = [
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
      items.push(
        new FindingsItem("Initialize Contract", report.contractPath, {
          command: "agentContracts.initializeContract",
          title: "Initialize Contract"
        })
      );
    }

    if (report.recommendedVerification.length > 0) {
      items.push(
        new FindingsItem("Add Recommended Verification", `${report.recommendedVerification.length} command(s) available`, {
          command: "agentContracts.addRecommendedVerification",
          title: "Add Recommended Verification"
        })
      );
    }

    if (report.sensitiveFiles.length > 0) {
      items.push(
        new FindingsItem("Protect Sensitive Paths", `${report.sensitiveFiles.length} sensitive file(s) seen`, {
          command: "agentContracts.protectSensitivePaths",
          title: "Protect Sensitive Paths"
        })
      );
    }

    for (const finding of report.findings.slice(0, 12)) {
      items.push(toFindingItem(finding));
    }

    return Promise.resolve(items);
  }

  getLatestReport(): AnalysisReport | undefined {
    return this.latestReport;
  }
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
    diagnostics
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
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      finding.recommendation ? `${finding.title}: ${finding.recommendation}` : finding.title,
      toDiagnosticSeverity(finding)
    );
    diagnostic.source = "Agent Contracts";

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

import * as vscode from "vscode";

import {
  contractUriForFolder,
  defaultContract,
  detectRecommendedVerification,
  writeContract
} from "./contracts";
import { analyzeWorkspace } from "./analyzer";
import { buildMarkdownReport } from "./report";
import { AnalysisReport, Finding } from "./types";

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

  async refresh(showNotification = false): Promise<void> {
    this.latestReport = await analyzeWorkspace();
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
      new FindingsItem(`Trust Score ${report.trustScore}/100`, report.contractExists ? "Contract loaded" : "Contract missing", {
        command: "agentContracts.openReport",
        title: "Open Report"
      }),
      new FindingsItem("Open Report", `${report.findings.length} findings`, {
        command: "agentContracts.openReport",
        title: "Open Report"
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

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentContracts.findings", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentContracts.analyzeWorkspace", async () => {
      await provider.refresh(true);
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
      await provider.refresh(true);
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
          await provider.refresh(false);
        }
      })
    );
  }

  void provider.refresh(false);
}

export function deactivate(): void {}

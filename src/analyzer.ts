import * as path from "path";
import * as vscode from "vscode";

import {
  contractUriForFolder,
  detectRecommendedVerification,
  readContract
} from "./contracts";
import {
  analyzeMcpConfigDocument,
  calculateTrustScore,
  collectMcpPolicySignalsDocument,
  collectSensitiveCoverageFindings,
  collectVerificationFindings
} from "./analyzer-core";
import { AgentContract, AnalysisReport, ChangedFileDetail, Finding, Severity } from "./types";

const textDecoder = new TextDecoder();

export interface AnalyzeWorkspaceOptions {
  scope?: "workspace" | "changes";
  changedFiles?: string[];
  changedFileDetails?: Array<Omit<ChangedFileDetail, "findingCount" | "highestSeverity">>;
}

export async function analyzeWorkspace(options: AnalyzeWorkspaceOptions = {}): Promise<AnalysisReport> {
  const scope = options.scope ?? "workspace";
  const changedFileDetails = uniqueChangedFileDetails(options.changedFileDetails ?? []);
  const changedFiles = uniqueSorted([
    ...options.changedFiles ?? [],
    ...changedFileDetails.map((detail) => detail.path)
  ]);
  const changedFileSet = new Set(changedFiles);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return {
      workspaceName: "No workspace",
      generatedAt: new Date().toISOString(),
      scope,
      contractPath: ".agent-contract.json",
      contractExists: false,
      trustScore: 0,
      findings: [
        {
          id: "no-workspace",
          severity: "critical",
          title: "Open a folder to analyze",
          description: "Agent Contracts needs an active workspace folder before it can inspect MCP configs or sensitive paths.",
          source: "workspace",
          recommendation: "Open a repository folder in VS Code and run the analysis again."
        }
      ],
      mcpConfigs: [],
      sensitiveFiles: [],
      changedFiles,
      changedFileDetails: [],
      observedMcpHosts: [],
      observedMcpRunnerTargets: [],
      recommendedVerification: [],
      summary: "No workspace folder is open."
    };
  }

  const contractUri = contractUriForFolder(folder);
  const contractPath = toRelative(folder, contractUri);
  const contract = await readContract(contractUri);
  const findings: Finding[] = [];

  if (!contract) {
    findings.push({
      id: "missing-contract",
      severity: "high",
      title: "No agent contract file found",
      description: `The workspace does not define ${contractPath}, so there is no explicit trust policy for agents, MCP servers, or verification steps.`,
      source: "contract",
      location: contractPath,
      recommendation: "Initialize a contract and review the defaults before enabling agent workflows broadly."
    });
  }

  const recommendedVerification = await detectRecommendedVerification(folder);
  collectVerificationFindings(findings, contract, recommendedVerification, contractPath);

  const allSensitiveFiles = await findSensitiveFiles(folder);
  const sensitiveFiles = scope === "changes"
    ? allSensitiveFiles.filter((file) => changedFileSet.has(file))
    : allSensitiveFiles;
  collectSensitiveCoverageFindings(findings, contract, sensitiveFiles, contractPath);

  const allMcpConfigs = await findMcpConfigs(folder);
  const mcpConfigs = scope === "changes"
    ? allMcpConfigs.filter((uri) => changedFileSet.has(toRelative(folder, uri)))
    : allMcpConfigs;
  const observedMcpHosts = new Set<string>();
  const observedMcpRunnerTargets = new Set<string>();
  if (mcpConfigs.length === 0) {
    findings.push({
      id: "missing-mcp-config",
      severity: "low",
      title: scope === "changes" ? "No changed MCP config found" : "No MCP config found in the workspace",
      description: scope === "changes"
        ? "None of the changed files matched the configured MCP search globs."
        : "No files matched the configured MCP search globs. This is fine today, but the extension cannot assess server risk until MCP configs exist.",
      source: "mcp",
      recommendation: scope === "changes"
        ? "Run a full workspace scan if you want to inspect all MCP config files."
        : "Add a workspace MCP config when your team starts using agent-connected tools."
    });
  }

  for (const uri of mcpConfigs) {
    const { findings: configFindings, remoteHosts, runnerTargets } = await analyzeMcpConfig(folder, uri, contract);
    findings.push(...configFindings);
    for (const host of remoteHosts) {
      observedMcpHosts.add(host);
    }
    for (const target of runnerTargets) {
      observedMcpRunnerTargets.add(target);
    }
  }

  if (contract && contract.blockedCommands.length === 0) {
    findings.push({
      id: "empty-blocked-commands",
      severity: "low",
      title: "Blocked commands list is empty",
      description: "The contract exists but does not document any disallowed command patterns for agent usage.",
      source: "contract",
      location: contractPath,
      recommendation: "Add commands your team never wants agents to invoke without human review."
    });
  }

  const trustScore = calculateTrustScore(findings);
  const enrichedChangedFileDetails = buildChangedFileDetails(changedFileDetails, findings);
  const summary = buildSummary(
    findings,
    trustScore,
    contract !== undefined,
    mcpConfigs.length,
    scope,
    enrichedChangedFileDetails
  );

  return {
    workspaceName: folder.name,
    generatedAt: new Date().toISOString(),
    scope,
    contractPath,
    contractExists: contract !== undefined,
    trustScore,
    findings: sortFindings(findings),
    mcpConfigs: mcpConfigs.map((uri) => toRelative(folder, uri)),
    sensitiveFiles,
    changedFiles,
    changedFileDetails: enrichedChangedFileDetails,
    observedMcpHosts: [...observedMcpHosts].sort((left, right) => left.localeCompare(right)),
    observedMcpRunnerTargets: [...observedMcpRunnerTargets].sort((left, right) => left.localeCompare(right)),
    recommendedVerification,
    summary
  };
}

async function analyzeMcpConfig(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri,
  contract: AgentContract | undefined
): Promise<{ findings: Finding[]; remoteHosts: string[]; runnerTargets: string[] }> {
  const relativePath = toRelative(folder, uri);
  const raw = textDecoder.decode(await vscode.workspace.fs.readFile(uri));
  const findings = analyzeMcpConfigDocument(relativePath, raw, contract);
  const signals = collectMcpPolicySignalsDocument(raw);
  return {
    findings,
    remoteHosts: signals.remoteHosts,
    runnerTargets: signals.runnerTargets
  };
}

async function findSensitiveFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const globs = vscode.workspace
    .getConfiguration("agentContracts")
    .get<string[]>("sensitiveFileGlobs", []);

  return findUniqueRelativePaths(folder, globs);
}

async function findMcpConfigs(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
  const globs = vscode.workspace
    .getConfiguration("agentContracts")
    .get<string[]>("mcpConfigGlobs", [".vscode/mcp.json"]);

  const uris = await Promise.all(
    globs.map((glob) =>
      vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, glob),
        "**/{node_modules,.git,out,dist}/**",
        20
      )
    )
  );

  const seen = new Set<string>();
  const flattened: vscode.Uri[] = [];
  for (const list of uris) {
    for (const uri of list) {
      if (seen.has(uri.toString())) {
        continue;
      }
      seen.add(uri.toString());
      flattened.push(uri);
    }
  }

  return flattened;
}

async function findUniqueRelativePaths(
  folder: vscode.WorkspaceFolder,
  globs: string[]
): Promise<string[]> {
  const matches = await Promise.all(
    globs.map((glob) =>
      vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, glob),
        "**/{node_modules,.git,out,dist}/**",
        50
      )
    )
  );

  const relativePaths = new Set<string>();
  for (const group of matches) {
    for (const uri of group) {
      relativePaths.add(toRelative(folder, uri));
    }
  }

  return [...relativePaths].sort((left, right) => left.localeCompare(right));
}

function buildSummary(
  findings: Finding[],
  trustScore: number,
  hasContract: boolean,
  mcpConfigCount: number,
  scope: "workspace" | "changes",
  changedFileDetails: ChangedFileDetail[]
): string {
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const high = findings.filter((finding) => finding.severity === "high").length;

  const contractState = hasContract ? "Contract present." : "Contract missing.";
  const mcpState = mcpConfigCount > 0 ? `${mcpConfigCount} MCP config file(s) analyzed.` : "No MCP configs analyzed.";
  const changedState = scope === "changes"
    ? buildChangedScopeSummary(changedFileDetails)
    : "";
  return `Trust score ${trustScore}/100. ${critical} critical and ${high} high severity finding(s). ${contractState} ${mcpState}${changedState}`;
}

function sortFindings(findings: Finding[]): Finding[] {
  const rank: Record<Severity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3
  };

  return [...findings].sort((left, right) => {
    const severityDelta = rank[left.severity] - rank[right.severity];
    return severityDelta !== 0 ? severityDelta : left.title.localeCompare(right.title);
  });
}

function toRelative(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  return normalizePath(path.relative(folder.uri.fsPath, uri.fsPath));
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildChangedFileDetails(
  changedFiles: Array<Omit<ChangedFileDetail, "findingCount" | "highestSeverity">>,
  findings: Finding[]
): ChangedFileDetail[] {
  return [...changedFiles]
    .map((detail) => {
      const relatedFindings = findings.filter((finding) => finding.location === detail.path);
      const highestSeverity = relatedFindings
        .map((finding) => finding.severity)
        .sort((left, right) => severityRank(left) - severityRank(right))[0];

      return {
        ...detail,
        findingCount: relatedFindings.length,
        highestSeverity
      };
    })
    .sort((left, right) => {
      const severityDelta = severityRank(left.highestSeverity) - severityRank(right.highestSeverity);
      if (severityDelta !== 0) {
        return severityDelta;
      }

      const findingDelta = right.findingCount - left.findingCount;
      if (findingDelta !== 0) {
        return findingDelta;
      }

      const churnDelta = (right.addedLines + right.removedLines) - (left.addedLines + left.removedLines);
      return churnDelta !== 0 ? churnDelta : left.path.localeCompare(right.path);
    });
}

function buildChangedScopeSummary(changedFileDetails: ChangedFileDetail[]): string {
  if (changedFileDetails.length === 0) {
    return " No changed files detected.";
  }

  const riskyFiles = changedFileDetails.filter((detail) => detail.findingCount > 0).length;
  const topFile = changedFileDetails[0];
  if (!topFile) {
    return "";
  }

  const topLabel = topFile.findingCount > 0
    ? `${topFile.path} has ${topFile.findingCount} finding(s)`
    : `${topFile.path} was touched`;
  return ` ${riskyFiles} of ${changedFileDetails.length} changed file(s) have findings. Highest-priority review: ${topLabel}.`;
}

function uniqueChangedFileDetails(
  details: Array<Omit<ChangedFileDetail, "findingCount" | "highestSeverity">>
): Array<Omit<ChangedFileDetail, "findingCount" | "highestSeverity">> {
  const seen = new Set<string>();
  return details
    .filter((detail) => {
      if (seen.has(detail.path)) {
        return false;
      }

      seen.add(detail.path);
      return true;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function severityRank(severity: Severity | undefined): number {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

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
  collectSensitiveCoverageFindings,
  collectVerificationFindings
} from "./analyzer-core";
import { AgentContract, AnalysisReport, Finding, Severity } from "./types";

const textDecoder = new TextDecoder();

export interface AnalyzeWorkspaceOptions {
  scope?: "workspace" | "changes";
  changedFiles?: string[];
}

export async function analyzeWorkspace(options: AnalyzeWorkspaceOptions = {}): Promise<AnalysisReport> {
  const scope = options.scope ?? "workspace";
  const changedFiles = uniqueSorted(options.changedFiles ?? []);
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
    const configFindings = await analyzeMcpConfig(folder, uri, contract);
    findings.push(...configFindings);
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
  const summary = buildSummary(findings, trustScore, contract !== undefined, mcpConfigs.length);

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
    recommendedVerification,
    summary
  };
}

async function analyzeMcpConfig(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri,
  contract: AgentContract | undefined
): Promise<Finding[]> {
  const relativePath = toRelative(folder, uri);
  const raw = textDecoder.decode(await vscode.workspace.fs.readFile(uri));
  return analyzeMcpConfigDocument(relativePath, raw, contract);
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
  mcpConfigCount: number
): string {
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const high = findings.filter((finding) => finding.severity === "high").length;

  const contractState = hasContract ? "Contract present." : "Contract missing.";
  const mcpState = mcpConfigCount > 0 ? `${mcpConfigCount} MCP config file(s) analyzed.` : "No MCP configs analyzed.";
  return `Trust score ${trustScore}/100. ${critical} critical and ${high} high severity finding(s). ${contractState} ${mcpState}`;
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

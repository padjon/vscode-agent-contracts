import * as path from "path";
import * as vscode from "vscode";
import { parse } from "jsonc-parser";
import minimatch = require("minimatch");

import {
  contractUriForFolder,
  detectRecommendedVerification,
  readContract
} from "./contracts";
import { AgentContract, AnalysisReport, Finding, Severity } from "./types";

const textDecoder = new TextDecoder();

type McpConfig = {
  servers?: Record<string, Record<string, unknown>>;
  inputs?: unknown[];
};

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const SHELL_WRAPPER_PATTERN = /(^|\/)(bash|sh|zsh|fish|cmd|powershell|pwsh)(\.exe)?$/i;
const RISKY_RUNNER_PATTERN = /(^|\/)(npx|pnpx|pnpm|yarn|bunx|uvx|pipx|docker)(\.cmd|\.exe)?$/i;
const HTTP_URL_PATTERN = /^http:\/\//i;

export async function analyzeWorkspace(): Promise<AnalysisReport> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return {
      workspaceName: "No workspace",
      generatedAt: new Date().toISOString(),
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
  checkVerification(findings, contract, recommendedVerification);

  const sensitiveFiles = await findSensitiveFiles(folder);
  checkSensitiveCoverage(findings, contract, sensitiveFiles);

  const mcpConfigs = await findMcpConfigs(folder);
  if (mcpConfigs.length === 0) {
    findings.push({
      id: "missing-mcp-config",
      severity: "low",
      title: "No MCP config found in the workspace",
      description: "No files matched the configured MCP search globs. This is fine today, but the extension cannot assess server risk until MCP configs exist.",
      source: "mcp",
      recommendation: "Add a workspace MCP config when your team starts using agent-connected tools."
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
    contractPath,
    contractExists: contract !== undefined,
    trustScore,
    findings: sortFindings(findings),
    mcpConfigs: mcpConfigs.map((uri) => toRelative(folder, uri)),
    sensitiveFiles,
    recommendedVerification,
    summary
  };
}

async function analyzeMcpConfig(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri,
  contract: AgentContract | undefined
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const relativePath = toRelative(folder, uri);

  let parsed: McpConfig | undefined;
  try {
    const raw = textDecoder.decode(await vscode.workspace.fs.readFile(uri));
    parsed = parse(raw) as McpConfig;
  } catch {
    findings.push({
      id: `mcp-parse-${relativePath}`,
      severity: "high",
      title: "MCP config could not be parsed",
      description: `${relativePath} is not valid JSON/JSONC, so the workspace risk analysis is incomplete.`,
      source: "mcp",
      location: relativePath,
      recommendation: "Fix the config syntax so server definitions can be evaluated."
    });
    return findings;
  }

  const servers = parsed?.servers ?? {};
  const serverEntries = Object.entries(servers);
  if (serverEntries.length === 0) {
    findings.push({
      id: `mcp-empty-${relativePath}`,
      severity: "low",
      title: "MCP config has no servers",
      description: `${relativePath} exists but does not define any servers.`,
      source: "mcp",
      location: relativePath
    });
    return findings;
  }

  for (const [serverName, config] of serverEntries) {
    const command = stringValue(config.command);
    const url = stringValue(config.url);
    const args = arrayValue(config.args);
    const env = objectValue(config.env);
    const contractBlocksServer = contract?.blockedMcpServers.includes(serverName) ?? false;
    const commandLine = [command, ...args].filter(Boolean).join(" ").trim();

    if (contractBlocksServer) {
      findings.push({
        id: `mcp-blocked-${relativePath}-${serverName}`,
        severity: "critical",
        title: `Blocked MCP server is still configured: ${serverName}`,
        description: `The contract explicitly blocks ${serverName}, but it still appears in ${relativePath}.`,
        source: "mcp",
        location: relativePath,
        recommendation: "Remove the server from the MCP config or update the contract after review."
      });
    }

    if (command && SHELL_WRAPPER_PATTERN.test(command) && args.some((arg) => /^(-c|-lc|\/c|-Command)$/i.test(arg))) {
      findings.push({
        id: `mcp-shell-${relativePath}-${serverName}`,
        severity: "high",
        title: `Server ${serverName} runs through a shell wrapper`,
        description: `Shell wrappers make the executed command harder to audit because the real behavior is hidden behind ${commandLine}.`,
        source: "mcp",
        location: relativePath,
        recommendation: "Prefer a direct executable and explicit arguments."
      });
    }

    if (command && RISKY_RUNNER_PATTERN.test(command)) {
      findings.push({
        id: `mcp-runner-${relativePath}-${serverName}`,
        severity: "medium",
        title: `Server ${serverName} uses a package runner`,
        description: `${commandLine} relies on a package or container runner. That increases drift unless versions are pinned and reviewed.`,
        source: "mcp",
        location: relativePath,
        recommendation: "Pin exact versions and document why the runner is allowed in the contract."
      });
    }

    if (url && HTTP_URL_PATTERN.test(url)) {
      findings.push({
        id: `mcp-http-${relativePath}-${serverName}`,
        severity: "high",
        title: `Server ${serverName} uses insecure HTTP`,
        description: `The MCP server URL for ${serverName} uses plain HTTP.`,
        source: "mcp",
        location: relativePath,
        recommendation: "Use HTTPS or a local transport that does not expose the server over an unsecured network hop."
      });
    }

    for (const [key, value] of Object.entries(env)) {
      if (!SECRET_KEY_PATTERN.test(key)) {
        continue;
      }

      if (typeof value === "string" && !/\$\{.+\}/.test(value)) {
        findings.push({
          id: `mcp-secret-${relativePath}-${serverName}-${key}`,
          severity: "critical",
          title: `Server ${serverName} appears to inline a secret`,
          description: `The ${key} environment variable in ${relativePath} looks like a literal secret instead of a reference.`,
          source: "mcp",
          location: relativePath,
          recommendation: "Reference environment variables or secure inputs instead of storing secrets inline."
        });
      }
    }
  }

  return findings;
}

function checkVerification(
  findings: Finding[],
  contract: AgentContract | undefined,
  recommendedVerification: string[]
): void {
  if (!contract) {
    return;
  }

  if (contract.requiredVerification.length === 0 && recommendedVerification.length > 0) {
    findings.push({
      id: "missing-required-verification",
      severity: "high",
      title: "Required verification is empty",
      description: "The contract does not define any verification steps even though the workspace exposes runnable quality gates.",
      source: "contract",
      recommendation: `Add at least one verification command such as ${recommendedVerification.join(", ")}.`
    });
    return;
  }

  const missing = recommendedVerification.filter(
    (command) => !contract.requiredVerification.includes(command)
  );

  if (missing.length > 0) {
    findings.push({
      id: "missing-recommended-verification",
      severity: "medium",
      title: "Common verification steps are not covered by the contract",
      description: `The workspace appears to support ${missing.join(", ")}, but those commands are not listed in requiredVerification.`,
      source: "contract",
      recommendation: "Add the commands your team expects before merging agent-authored changes."
    });
  }
}

function checkSensitiveCoverage(
  findings: Finding[],
  contract: AgentContract | undefined,
  sensitiveFiles: string[]
): void {
  if (sensitiveFiles.length === 0) {
    return;
  }

  if (!contract) {
    findings.push({
      id: "sensitive-files-without-contract",
      severity: "high",
      title: "Sensitive-looking files exist without protected path rules",
      description: `The workspace contains ${sensitiveFiles.length} sensitive-looking file(s), but no contract exists to mark them as protected.`,
      source: "paths",
      recommendation: "Initialize a contract and add protected path globs before enabling broad agent access."
    });
    return;
  }

  const uncovered = sensitiveFiles.filter(
    (file) => !contract.protectedPaths.some((pattern) => matchesPattern(file, pattern))
  );

  if (uncovered.length === 0) {
    return;
  }

  findings.push({
    id: "uncovered-sensitive-files",
    severity: "high",
    title: "Sensitive-looking files are not covered by protected paths",
    description: `The contract does not protect ${uncovered.slice(0, 5).join(", ")}${uncovered.length > 5 ? " and more" : ""}.`,
    source: "paths",
    recommendation: "Expand protectedPaths so secrets, certificates, production configs, and migration files require review."
  });
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

function calculateTrustScore(findings: Finding[]): number {
  const weights: Record<Severity, number> = {
    critical: 30,
    high: 18,
    medium: 10,
    low: 4
  };

  const penalty = findings.reduce((total, finding) => total + weights[finding.severity], 0);
  return Math.max(0, 100 - penalty);
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

function matchesPattern(file: string, pattern: string): boolean {
  return minimatch(file, pattern, { dot: true });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

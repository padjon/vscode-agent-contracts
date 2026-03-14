import { parse } from "jsonc-parser";
import minimatch = require("minimatch");

import { AgentContract, Finding, Severity } from "./types";

type McpConfig = {
  servers?: Record<string, Record<string, unknown>>;
  inputs?: unknown[];
};

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const SHELL_WRAPPER_PATTERN = /(^|\/)(bash|sh|zsh|fish|cmd|powershell|pwsh)(\.exe)?$/i;
const RISKY_RUNNER_PATTERN = /(^|\/)(npx|pnpx|pnpm|yarn|bunx|uvx|pipx|docker)(\.cmd|\.exe)?$/i;
const HTTP_URL_PATTERN = /^http:\/\//i;

export function analyzeMcpConfigDocument(
  relativePath: string,
  raw: string,
  contract: AgentContract | undefined
): Finding[] {
  const findings: Finding[] = [];
  try {
    const parsed = parse(raw) as McpConfig;
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
  }

  return findings;
}

export function collectVerificationFindings(
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

export function collectSensitiveCoverageFindings(
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
    (file) => !contract.protectedPaths.some((pattern) => minimatch(file, pattern, { dot: true }))
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

export function calculateTrustScore(findings: Finding[]): number {
  const weights: Record<Severity, number> = {
    critical: 30,
    high: 18,
    medium: 10,
    low: 4
  };

  const penalty = findings.reduce((total, finding) => total + weights[finding.severity], 0);
  return Math.max(0, 100 - penalty);
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

import { findNodeAtLocation, parse, parseTree } from "jsonc-parser";
import minimatch = require("minimatch");

import { AgentContract, Finding, JsonPathSegment, Severity } from "./types";

type McpConfig = {
  servers?: Record<string, Record<string, unknown>>;
  inputs?: unknown[];
};

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const SHELL_WRAPPER_PATTERN = /(^|\/)(bash|sh|zsh|fish|cmd|powershell|pwsh)(\.exe)?$/i;
const RISKY_RUNNER_PATTERN = /(^|\/)(npx|pnpx|pnpm|yarn|bunx|uvx|pipx|docker)(\.cmd|\.exe)?$/i;
const HTTP_URL_PATTERN = /^http:\/\//i;
const DANGEROUS_SHELL_CHAIN_PATTERN = /(\|\s*(sh|bash|zsh|fish|pwsh|powershell)\b|&&|;|\$\(|`|Invoke-WebRequest|iwr\b|curl\b|wget\b)/i;

export interface McpPolicySignals {
  remoteHosts: string[];
  runnerTargets: string[];
}

export function analyzeMcpConfigDocument(
  relativePath: string,
  raw: string,
  contract: AgentContract | undefined
): Finding[] {
  const findings: Finding[] = [];
  try {
    const parsed = parse(raw) as McpConfig;
    const root = parseTree(raw);
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
      const serverPath: JsonPathSegment[] = ["servers", serverName];
      const command = stringValue(config.command);
      const url = stringValue(config.url);
      const args = arrayValue(config.args);
      const env = objectValue(config.env);
      const contractBlocksServer = contract?.blockedMcpServers.includes(serverName) ?? false;
      const commandLine = [command, ...args].filter(Boolean).join(" ").trim();
      const commandPath: JsonPathSegment[] = [...serverPath, "command"];
      const urlPath: JsonPathSegment[] = [...serverPath, "url"];
      const shellCommand = extractShellCommand(args);
      const runnerTarget = findRunnerTarget(command, args);
      const remoteHost = url ? getRemoteHost(url) : undefined;

      if (contractBlocksServer) {
        findings.push({
          id: `mcp-blocked-${relativePath}-${serverName}`,
          severity: "critical",
          title: `Blocked MCP server is still configured: ${serverName}`,
          description: `The contract explicitly blocks ${serverName}, but it still appears in ${relativePath}.`,
          source: "mcp",
          location: relativePath,
          jsonPath: serverPath,
          range: nodeRange(root, serverPath),
          fix: {
            kind: "remove-property",
            path: serverPath,
            title: `Remove blocked MCP server '${serverName}'`
          },
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
          jsonPath: commandPath,
          range: nodeRange(root, commandPath),
          recommendation: "Prefer a direct executable and explicit arguments."
        });
      }

      if (shellCommand && DANGEROUS_SHELL_CHAIN_PATTERN.test(shellCommand)) {
        findings.push({
          id: `mcp-shell-chain-${relativePath}-${serverName}`,
          severity: "critical",
          title: `Server ${serverName} shell command contains chained or downloaded execution`,
          description: `The shell command for ${serverName} includes a high-risk execution pattern: ${shellCommand}.`,
          source: "mcp",
          location: relativePath,
          jsonPath: [...serverPath, "args"],
          range: nodeRange(root, [...serverPath, "args"]),
          recommendation: "Replace chained shell execution with a direct reviewed command and remove downloaded install steps."
        });
      }

      if (command && RISKY_RUNNER_PATTERN.test(command)) {
        if (!matchesAllowPattern(runnerTarget, contract?.allowedMcpRunnerTargets)) {
          findings.push({
            id: `mcp-runner-${relativePath}-${serverName}`,
            severity: "medium",
            title: `Server ${serverName} uses a package runner`,
            description: runnerTarget
              ? `${commandLine} relies on a package or container runner, and ${runnerTarget} is not allowlisted in the contract.`
              : `${commandLine} relies on a package or container runner. That increases drift unless versions are pinned and reviewed.`,
            source: "mcp",
            location: relativePath,
            jsonPath: commandPath,
            range: nodeRange(root, commandPath),
            recommendation: runnerTarget
              ? "Approve the runner target in the contract only after reviewing the exact package or image."
              : "Pin exact versions and document why the runner is allowed in the contract."
          });
        }

        if (!hasPinnedRunnerTarget(command, args)) {
          findings.push({
            id: `mcp-runner-unpinned-${relativePath}-${serverName}`,
            severity: "high",
            title: `Server ${serverName} uses an unpinned package runner target`,
            description: `${commandLine} does not appear to pin an exact package or image version.`,
            source: "mcp",
            location: relativePath,
            jsonPath: [...serverPath, "args"],
            range: nodeRange(root, [...serverPath, "args"]),
            recommendation: "Pin an exact package or image version before trusting the server in shared workspaces."
          });
        }
      }

      if (url && HTTP_URL_PATTERN.test(url)) {
        findings.push({
          id: `mcp-http-${relativePath}-${serverName}`,
          severity: "high",
          title: `Server ${serverName} uses insecure HTTP`,
          description: `The MCP server URL for ${serverName} uses plain HTTP.`,
          source: "mcp",
          location: relativePath,
          jsonPath: urlPath,
          range: nodeRange(root, urlPath),
          fix: {
            kind: "set-value",
            path: urlPath,
            value: url.replace(/^http:\/\//i, "https://"),
            title: `Switch ${serverName} URL to HTTPS`
          },
          recommendation: "Use HTTPS or a local transport that does not expose the server over an unsecured network hop."
        });
      }

      if (remoteHost && !matchesAllowPattern(remoteHost, contract?.allowedMcpHosts)) {
        findings.push({
          id: `mcp-remote-${relativePath}-${serverName}`,
          severity: "medium",
          title: `Server ${serverName} connects to a remote MCP endpoint that is not approved`,
          description: `The MCP server URL for ${serverName} points to ${remoteHost}, which is not allowlisted in the contract.`,
          source: "mcp",
          location: relativePath,
          jsonPath: urlPath,
          range: nodeRange(root, urlPath),
          recommendation: "Review ownership, authentication, and transport guarantees before allowlisting the remote MCP host."
        });
      }

      for (const [key, value] of Object.entries(env)) {
        if (!SECRET_KEY_PATTERN.test(key)) {
          continue;
        }

        if (typeof value === "string" && !/\$\{.+\}/.test(value)) {
          const envPath: JsonPathSegment[] = [...serverPath, "env", key];
          findings.push({
            id: `mcp-secret-${relativePath}-${serverName}-${key}`,
            severity: "critical",
            title: `Server ${serverName} appears to inline a secret`,
            description: `The ${key} environment variable in ${relativePath} looks like a literal secret instead of a reference.`,
            source: "mcp",
            location: relativePath,
            jsonPath: envPath,
            range: nodeRange(root, envPath),
            fix: {
              kind: "set-value",
              path: envPath,
              value: `\${${key}}`,
              title: `Replace ${key} with an environment reference`
            },
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

export function collectMcpPolicySignalsDocument(raw: string): McpPolicySignals {
  try {
    const parsed = parse(raw) as McpConfig;
    const servers = parsed?.servers ?? {};
    const remoteHosts = new Set<string>();
    const runnerTargets = new Set<string>();

    for (const config of Object.values(servers)) {
      const command = stringValue(config.command);
      const args = arrayValue(config.args);
      const url = stringValue(config.url);
      const remoteHost = url ? getRemoteHost(url) : undefined;
      const runnerTarget = findRunnerTarget(command, args);

      if (remoteHost) {
        remoteHosts.add(remoteHost);
      }

      if (runnerTarget) {
        runnerTargets.add(runnerTarget);
      }
    }

    return {
      remoteHosts: [...remoteHosts].sort((left, right) => left.localeCompare(right)),
      runnerTargets: [...runnerTargets].sort((left, right) => left.localeCompare(right))
    };
  } catch {
    return {
      remoteHosts: [],
      runnerTargets: []
    };
  }
}

export function collectVerificationFindings(
  findings: Finding[],
  contract: AgentContract | undefined,
  recommendedVerification: string[],
  contractPath?: string
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
      location: contractPath,
      jsonPath: ["requiredVerification"],
      fix: {
        kind: "append-unique",
        path: ["requiredVerification"],
        value: recommendedVerification,
        title: "Add recommended verification commands"
      },
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
      location: contractPath,
      jsonPath: ["requiredVerification"],
      fix: {
        kind: "append-unique",
        path: ["requiredVerification"],
        value: missing,
        title: "Add missing verification commands"
      },
      recommendation: "Add the commands your team expects before merging agent-authored changes."
    });
  }
}

export function collectSensitiveCoverageFindings(
  findings: Finding[],
  contract: AgentContract | undefined,
  sensitiveFiles: string[],
  contractPath?: string
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
    location: contractPath,
    jsonPath: ["protectedPaths"],
    fix: {
      kind: "append-unique",
      path: ["protectedPaths"],
      value: uncovered,
      title: "Add uncovered sensitive paths"
    },
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

function nodeRange(root: ReturnType<typeof parseTree>, path: JsonPathSegment[]) {
  if (!root) {
    return undefined;
  }

  const node = findNodeAtLocation(root, path);
  if (!node) {
    return undefined;
  }

  return {
    offset: node.offset,
    length: node.length
  };
}

function extractShellCommand(args: string[]): string {
  const commandFlagIndex = args.findIndex((arg) => /^(-c|-lc|\/c|-Command)$/i.test(arg));
  if (commandFlagIndex < 0) {
    return "";
  }

  return args[commandFlagIndex + 1] ?? "";
}

function hasPinnedRunnerTarget(command: string, args: string[]): boolean {
  const target = findRunnerTarget(command, args);
  if (!target) {
    return false;
  }

  if (command.endsWith("docker") || command.endsWith("docker.exe")) {
    return /:[^:/@]+$|@sha256:/i.test(target);
  }

  return isPinnedPackageSpecifier(target);
}

function findDockerImageArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "run" || arg === "create") {
      for (let cursor = index + 1; cursor < args.length; cursor += 1) {
        const candidate = args[cursor];
        if (!candidate || candidate.startsWith("-")) {
          continue;
        }

        return candidate;
      }
    }
  }

  return undefined;
}

function findRunnerTarget(command: string, args: string[]): string | undefined {
  if (!command || !RISKY_RUNNER_PATTERN.test(command)) {
    return undefined;
  }

  if (command.endsWith("docker") || command.endsWith("docker.exe")) {
    return findDockerImageArg(args);
  }

  const filtered = args.filter((arg) => isRunnerTargetArg(arg));
  if (filtered.length === 0) {
    return undefined;
  }

  if (filtered[0] === "dlx" || filtered[0] === "exec" || filtered[0] === "run") {
    return filtered[1];
  }

  return filtered[0];
}

function isRunnerTargetArg(value: string): boolean {
  if (!value || value.startsWith("-")) {
    return false;
  }

  return !value.startsWith(".") && !value.startsWith("/") && !value.includes("=");
}

function isPinnedPackageSpecifier(value: string): boolean {
  if (/^https?:\/\//i.test(value)) {
    return false;
  }

  if (/^@[^/]+\/[^@]+@[^/]+$/i.test(value)) {
    return true;
  }

  if (/^[^@/][^@]*@[^/]+$/i.test(value)) {
    return true;
  }

  return false;
}

function getRemoteHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!/^https?:$/i.test(url.protocol)) {
      return undefined;
    }

    return isLocalHost(url.hostname) ? undefined : url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function matchesAllowPattern(value: string | undefined, patterns: string[] | undefined): boolean {
  if (!value || !patterns || patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => minimatch(value, pattern, { nocase: true }));
}

function isLocalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "0.0.0.0" ||
    lower === "::1" ||
    lower.endsWith(".local")
  ) {
    return true;
  }

  if (/^10\./.test(lower) || /^192\.168\./.test(lower)) {
    return true;
  }

  const private172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(lower);
  return private172;
}

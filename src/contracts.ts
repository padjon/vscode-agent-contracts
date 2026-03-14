import * as path from "path";
import * as vscode from "vscode";

import { AgentContract } from "./types";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const DEFAULT_PROTECTED_PATHS = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  ".github/workflows/**",
  "infra/**",
  "terraform/**",
  "migrations/**",
  "prod/**"
];

const DEFAULT_BLOCKED_COMMANDS = [
  "git push --force",
  "rm -rf /",
  "curl | sh"
];

export function defaultContract(requiredVerification: string[]): AgentContract {
  return {
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    requiredVerification,
    blockedCommands: DEFAULT_BLOCKED_COMMANDS,
    blockedMcpServers: [],
    allowedMcpHosts: [],
    allowedMcpRunnerTargets: [],
    notes: "List sensitive paths, required verification steps, blocked MCP servers, and any explicitly approved MCP hosts or runner targets."
  };
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function readContract(uri: vscode.Uri): Promise<AgentContract | undefined> {
  if (!(await fileExists(uri))) {
    return undefined;
  }

  const raw = textDecoder.decode(await vscode.workspace.fs.readFile(uri));
  const parsed = JSON.parse(raw) as Partial<AgentContract>;

  return {
    protectedPaths: Array.isArray(parsed.protectedPaths) ? parsed.protectedPaths : [],
    requiredVerification: Array.isArray(parsed.requiredVerification) ? parsed.requiredVerification : [],
    blockedCommands: Array.isArray(parsed.blockedCommands) ? parsed.blockedCommands : [],
    blockedMcpServers: Array.isArray(parsed.blockedMcpServers) ? parsed.blockedMcpServers : [],
    allowedMcpHosts: Array.isArray(parsed.allowedMcpHosts) ? parsed.allowedMcpHosts : [],
    allowedMcpRunnerTargets: Array.isArray(parsed.allowedMcpRunnerTargets) ? parsed.allowedMcpRunnerTargets : [],
    notes: typeof parsed.notes === "string" ? parsed.notes : undefined
  };
}

export async function writeContract(uri: vscode.Uri, contract: AgentContract): Promise<void> {
  const content = `${JSON.stringify(contract, null, 2)}\n`;
  await vscode.workspace.fs.writeFile(uri, textEncoder.encode(content));
}

export async function detectPackageManager(folder: vscode.WorkspaceFolder): Promise<string> {
  const candidates: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"]
  ];

  for (const [file, manager] of candidates) {
    if (await fileExists(vscode.Uri.joinPath(folder.uri, file))) {
      return manager;
    }
  }

  return "npm";
}

export async function detectRecommendedVerification(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const packageJsonUri = vscode.Uri.joinPath(folder.uri, "package.json");
  if (!(await fileExists(packageJsonUri))) {
    return [];
  }

  try {
    const raw = textDecoder.decode(await vscode.workspace.fs.readFile(packageJsonUri));
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    const manager = await detectPackageManager(folder);

    const scriptOrder = ["lint", "typecheck", "test", "build"];
    return scriptOrder
      .filter((name) => typeof scripts[name] === "string")
      .map((name) => `${manager} run ${name}`);
  } catch {
    return [];
  }
}

export function contractUriForFolder(folder: vscode.WorkspaceFolder): vscode.Uri {
  const fileName = vscode.workspace
    .getConfiguration("agentContracts")
    .get<string>("contractFileName", ".agent-contract.json");

  const cleanPath = fileName.replace(/^\/+/, "");
  return vscode.Uri.joinPath(folder.uri, ...cleanPath.split(path.posix.sep));
}

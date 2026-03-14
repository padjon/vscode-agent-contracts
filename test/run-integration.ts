import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runTests } from "@vscode/test-electron";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");
  const fixturePath = path.resolve(__dirname, "..", "..", "test", "fixtures", "workspace-basic");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-contracts-"));
  const workspacePath = path.join(tempRoot, "workspace-basic");

  await fs.cp(fixturePath, workspacePath, { recursive: true });
  await initializeGitRepo(workspacePath);

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, "--disable-extensions"]
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function initializeGitRepo(workspacePath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.name", "Agent Contracts Test"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.email", "agent-contracts@example.com"], { cwd: workspacePath });
  await execFileAsync("git", ["add", "."], { cwd: workspacePath });
  await execFileAsync("git", ["commit", "-m", "Initial fixture"], { cwd: workspacePath });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("Expected a workspace folder for integration tests.");
  }

  const mcpUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode", "mcp.json");
  const contractUri = vscode.Uri.joinPath(workspaceFolder.uri, ".agent-contract.json");

  await runStep("initializeContract creates a repo-local contract", async () => {
    await vscode.commands.executeCommand("agentContracts.initializeContract");

    const stat = await vscode.workspace.fs.stat(contractUri);
    assert.ok(stat.size > 0);

    const raw = Buffer.from(await vscode.workspace.fs.readFile(contractUri)).toString("utf8");
    assert.match(raw, /requiredVerification/);
    assert.match(raw, /npm run lint/);
  });

  await runStep("analyzeWorkspace produces MCP diagnostics and code actions", async () => {
    const mcpDocument = await vscode.workspace.openTextDocument(mcpUri);
    await vscode.window.showTextDocument(mcpDocument);

    await vscode.commands.executeCommand("agentContracts.analyzeWorkspace");
    await waitForDiagnostics(mcpUri);

    const diagnostics = vscode.languages.getDiagnostics(mcpUri);
    assert.ok(diagnostics.length >= 3);
    assert.ok(diagnostics.some((item) => item.message.includes("insecure HTTP")));

    const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
      "vscode.executeCodeActionProvider",
      mcpUri,
      diagnostics[0].range
    );

    const titles = (actions ?? []).map((item) => item.title);
    assert.ok(titles.some((title) => title.includes("HTTPS") || title.includes("Replace")));
  });

  await runStep("analyzeChangedFiles reports change scope after a file edit", async () => {
    const original = Buffer.from(await vscode.workspace.fs.readFile(mcpUri)).toString("utf8");
    const updated = original.replace("http://localhost:3456", "http://localhost:4567");
    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(updated, "utf8"));

    await vscode.commands.executeCommand("agentContracts.analyzeChangedFiles");
    await vscode.commands.executeCommand("agentContracts.openReport");

    const reportDocument = vscode.window.activeTextEditor?.document;
    assert.ok(reportDocument);
    assert.match(reportDocument?.getText() ?? "", /Scope: changes/);
    assert.match(reportDocument?.getText() ?? "", /Changed files considered: 1/);

    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(original, "utf8"));
    await execFileAsync("git", ["checkout", "--", ".vscode/mcp.json"], { cwd: workspaceFolder.uri.fsPath });
  });
}

async function runStep(name: string, callback: () => Promise<void>): Promise<void> {
  try {
    await callback();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function waitForDiagnostics(uri: vscode.Uri, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (vscode.languages.getDiagnostics(uri).length > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for diagnostics on ${uri.toString()}`);
}

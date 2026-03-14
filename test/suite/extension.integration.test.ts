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

    const actionGroups = await Promise.all(
      diagnostics.map((diagnostic) =>
        vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
          "vscode.executeCodeActionProvider",
          mcpUri,
          diagnostic.range
        )
      )
    );

    const titles = actionGroups.flatMap((actions) => (actions ?? []).map((item) => item.title));
    assert.ok(titles.some((title) => title.includes("HTTPS") || title.includes("Replace")));
  });

  await runStep("applySafeFixes updates MCP and contract files in one pass", async () => {
    const originalContract = Buffer.from(await vscode.workspace.fs.readFile(contractUri)).toString("utf8");
    const originalMcp = Buffer.from(await vscode.workspace.fs.readFile(mcpUri)).toString("utf8");
    const contractFixture = {
      protectedPaths: [".github/workflows/**"],
      requiredVerification: [],
      blockedCommands: ["git push --force"],
      blockedMcpServers: ["forbidden"],
      allowedMcpHosts: [],
      allowedMcpRunnerTargets: [],
      notes: "Fixture contract"
    };
    await vscode.workspace.fs.writeFile(
      contractUri,
      Buffer.from(`${JSON.stringify(contractFixture, null, 2)}\n`, "utf8")
    );

    await vscode.commands.executeCommand("agentContracts.analyzeWorkspace");
    await vscode.commands.executeCommand("agentContracts.applySafeFixes");

    const updatedContract = Buffer.from(await vscode.workspace.fs.readFile(contractUri)).toString("utf8");
    const updatedMcp = Buffer.from(await vscode.workspace.fs.readFile(mcpUri)).toString("utf8");

    assert.match(updatedContract, /npm run lint/);
    assert.match(updatedContract, /secrets\.prod\.json/);
    assert.doesNotMatch(updatedMcp, /forbidden/);

    await vscode.workspace.fs.writeFile(contractUri, Buffer.from(originalContract, "utf8"));
    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(originalMcp, "utf8"));
  });

  await runStep("analyzeChangedFiles reports change scope after a file edit", async () => {
    const original = Buffer.from(await vscode.workspace.fs.readFile(mcpUri)).toString("utf8");
    const updated = JSON.stringify({
      servers: {
        forbidden: {
          command: "bash",
          args: ["-c", "npx forbidden-mcp"],
          url: "http://localhost:4567",
          env: {
            API_KEY: "top-secret-value"
          }
        },
        added: {
          command: "npx",
          args: ["added-server@1.0.0"],
          url: "https://mcp.example.com"
        }
      }
    }, null, 2);
    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(updated, "utf8"));

    await vscode.commands.executeCommand("agentContracts.analyzeChangedFiles");
    await waitForDiagnostics(mcpUri);
    await vscode.commands.executeCommand("agentContracts.openReport");

    const reportDocument = vscode.window.activeTextEditor?.document;
    assert.ok(reportDocument);
    assert.match(reportDocument?.getText() ?? "", /Scope: changes/);
    assert.match(reportDocument?.getText() ?? "", /Changed files considered: 1/);
    assert.match(reportDocument?.getText() ?? "", /Changed review queue/);
    assert.match(reportDocument?.getText() ?? "", /Changed MCP server review/);
    assert.match(reportDocument?.getText() ?? "", /\.vscode\/mcp\.json#added \| added \|/);
    assert.match(reportDocument?.getText() ?? "", /\.vscode\/mcp\.json#forbidden \| modified \|/);

    const changedDiagnostics = vscode.languages.getDiagnostics(mcpUri);
    assert.ok(changedDiagnostics.some((item) => item.message.includes("Changed MCP server: added was added")));
    assert.ok(changedDiagnostics.some((item) => item.message.includes("Changed MCP server: forbidden was modified")));

    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(original, "utf8"));
    await execFileAsync("git", ["checkout", "--", ".vscode/mcp.json"], { cwd: workspaceFolder.uri.fsPath });
  });

  await runStep("allowObservedMcp approvals write hosts and runner targets into the contract", async () => {
    const contractFixture = {
      protectedPaths: [".github/workflows/**"],
      requiredVerification: ["npm run lint"],
      blockedCommands: ["git push --force"],
      blockedMcpServers: [],
      allowedMcpHosts: [],
      allowedMcpRunnerTargets: [],
      notes: "Fixture contract"
    };
    await vscode.workspace.fs.writeFile(
      contractUri,
      Buffer.from(`${JSON.stringify(contractFixture, null, 2)}\n`, "utf8")
    );

    const originalMcp = Buffer.from(await vscode.workspace.fs.readFile(mcpUri)).toString("utf8");
    const updatedMcp = JSON.stringify({
      servers: {
        approved: {
          command: "npx",
          args: ["forbidden-mcp@1.0.0"],
          url: "https://mcp.example.com"
        }
      }
    }, null, 2);
    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(updatedMcp, "utf8"));

    await vscode.commands.executeCommand("agentContracts.analyzeWorkspace");
    await vscode.commands.executeCommand("agentContracts.allowObservedMcpHosts");
    await vscode.commands.executeCommand("agentContracts.allowObservedMcpRunnerTargets");

    const updatedContract = Buffer.from(await vscode.workspace.fs.readFile(contractUri)).toString("utf8");
    assert.match(updatedContract, /"allowedMcpHosts": \[\s*"mcp\.example\.com"/);
    assert.match(updatedContract, /"allowedMcpRunnerTargets": \[\s*"forbidden-mcp@1\.0\.0"/);

    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(originalMcp, "utf8"));
  });

  await runStep("MCP quick fixes can approve host and runner target into the contract", async () => {
    const contractFixture = {
      protectedPaths: [".github/workflows/**"],
      requiredVerification: ["npm run lint"],
      blockedCommands: ["git push --force"],
      blockedMcpServers: [],
      allowedMcpHosts: [],
      allowedMcpRunnerTargets: [],
      notes: "Fixture contract"
    };
    await vscode.workspace.fs.writeFile(
      contractUri,
      Buffer.from(`${JSON.stringify(contractFixture, null, 2)}\n`, "utf8")
    );

    const originalMcp = Buffer.from(await vscode.workspace.fs.readFile(mcpUri)).toString("utf8");
    const updatedMcp = JSON.stringify({
      servers: {
        review: {
          command: "npx",
          args: ["review-server@1.0.0"],
          url: "https://mcp.example.com"
        }
      }
    }, null, 2);
    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(updatedMcp, "utf8"));

    const mcpDocument = await vscode.workspace.openTextDocument(mcpUri);
    await vscode.window.showTextDocument(mcpDocument);
    await vscode.commands.executeCommand("agentContracts.analyzeWorkspace");
    await waitForDiagnostics(mcpUri);

    const diagnostics = vscode.languages.getDiagnostics(mcpUri);
    const actionGroups = await Promise.all(
      diagnostics.map((diagnostic) =>
        vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
          "vscode.executeCodeActionProvider",
          mcpUri,
          diagnostic.range
        )
      )
    );
    const actions = actionGroups.flatMap((group) => group ?? []).filter((item): item is vscode.CodeAction => "edit" in item);
    const hostAction = actions.find((action) => action.title.includes("Allow MCP host"));
    assert.ok(hostAction?.edit);
    await vscode.workspace.applyEdit(hostAction.edit);

    const contractDocument = await vscode.workspace.openTextDocument(contractUri);
    if (contractDocument.isDirty) {
      await contractDocument.save();
    }
    assert.match(contractDocument.getText(), /"allowedMcpHosts": \[\s*"mcp\.example\.com"/);

    await vscode.commands.executeCommand("agentContracts.analyzeWorkspace");
    await waitForDiagnostics(mcpUri);
    const refreshedDiagnostics = vscode.languages.getDiagnostics(mcpUri);
    const refreshedGroups = await Promise.all(
      refreshedDiagnostics.map((diagnostic) =>
        vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
          "vscode.executeCodeActionProvider",
          mcpUri,
          diagnostic.range
        )
      )
    );
    const refreshedActions = refreshedGroups.flatMap((group) => group ?? []).filter((item): item is vscode.CodeAction => "edit" in item);
    const runnerAction = refreshedActions.find((action) => action.title.includes("Allow runner target"));
    assert.ok(runnerAction?.edit);
    await vscode.workspace.applyEdit(runnerAction.edit);
    if (contractDocument.isDirty) {
      await contractDocument.save();
    }
    assert.match(contractDocument.getText(), /"allowedMcpRunnerTargets": \[\s*"review-server@1\.0\.0"/);

    await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(originalMcp, "utf8"));
  });

  await runStep("analyzeWorkspace exposes contract quick fixes", async () => {
    const contractFixture = {
      protectedPaths: [".github/workflows/**"],
      requiredVerification: [],
      blockedCommands: ["git push --force"],
      blockedMcpServers: [],
      allowedMcpHosts: [],
      allowedMcpRunnerTargets: [],
      notes: "Fixture contract"
    };
    await vscode.workspace.fs.writeFile(
      contractUri,
      Buffer.from(`${JSON.stringify(contractFixture, null, 2)}\n`, "utf8")
    );

    const contractDocument = await vscode.workspace.openTextDocument(contractUri);
    await vscode.window.showTextDocument(contractDocument);

    await vscode.commands.executeCommand("agentContracts.analyzeWorkspace");
    await waitForDiagnostics(contractUri);

    const diagnostics = vscode.languages.getDiagnostics(contractUri);
    assert.ok(diagnostics.length >= 2);
    assert.ok(diagnostics.some((item) => item.message.includes("Required verification is empty")));
    assert.ok(diagnostics.some((item) => item.message.includes("Sensitive-looking files")));

    const actionGroups = await Promise.all(
      diagnostics.map((diagnostic) =>
        vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
          "vscode.executeCodeActionProvider",
          contractUri,
          diagnostic.range
        )
      )
    );

    const titles = actionGroups.flatMap((actions) => (actions ?? []).map((item) => item.title));
    assert.ok(titles.some((title) => title.includes("verification commands")));
    assert.ok(titles.some((title) => title.includes("sensitive paths")));
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

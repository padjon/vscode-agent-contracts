import { execFile } from "node:child_process";
import * as vscode from "vscode";

function execFileAsync(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
}

export async function getChangedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const stdout = await execFileAsync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"],
    folder.uri.fsPath
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

import { execFile } from "node:child_process";
import * as vscode from "vscode";

import { ChangedFileDetail } from "./types";

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

type RawChangedFileDetail = Omit<ChangedFileDetail, "findingCount" | "highestSeverity">;

export async function getChangedFileDetails(folder: vscode.WorkspaceFolder): Promise<RawChangedFileDetail[]> {
  const [statusOutput, numstatOutput] = await Promise.all([
    execFileAsync(
      "git",
      ["diff", "--name-status", "--find-renames", "--diff-filter=ACMR", "HEAD"],
      folder.uri.fsPath
    ),
    execFileAsync(
      "git",
      ["diff", "--numstat", "--find-renames", "--diff-filter=ACMR", "HEAD"],
      folder.uri.fsPath
    )
  ]);

  const details = new Map<string, RawChangedFileDetail>();

  for (const line of statusOutput.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const parts = line.split(/\t+/);
    const statusCode = parts[0] ?? "";
    const normalizedStatus = normalizeStatus(statusCode);
    if (!normalizedStatus) {
      continue;
    }

    const path = normalizePath(parts[normalizedStatus === "renamed" ? 2 : 1] ?? "");
    const previousPath = normalizedStatus === "renamed" ? normalizePath(parts[1] ?? "") : undefined;
    if (!path) {
      continue;
    }

    details.set(path, {
      path,
      previousPath,
      status: normalizedStatus,
      addedLines: 0,
      removedLines: 0
    });
  }

  for (const line of numstatOutput.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }

    const addedLines = parseDiffCount(parts[0]);
    const removedLines = parseDiffCount(parts[1]);
    const path = normalizePath(parts[parts.length - 1] ?? "");
    const previousPath = parts.length > 3 ? normalizePath(parts[2] ?? "") : undefined;
    const existing = details.get(path);
    if (!existing) {
      continue;
    }

    details.set(path, {
      ...existing,
      previousPath: existing.previousPath ?? previousPath,
      addedLines,
      removedLines
    });
  }

  return [...details.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function getChangedFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const details = await getChangedFileDetails(folder);
  return details.map((detail) => detail.path);
}

function normalizeStatus(value: string): RawChangedFileDetail["status"] | undefined {
  if (value.startsWith("A")) {
    return "added";
  }

  if (value.startsWith("M")) {
    return "modified";
  }

  if (value.startsWith("R")) {
    return "renamed";
  }

  if (value.startsWith("C")) {
    return "copied";
  }

  return undefined;
}

function parseDiffCount(value: string): number {
  return value === "-" ? 0 : Number.parseInt(value, 10) || 0;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

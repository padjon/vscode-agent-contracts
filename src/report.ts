import { AnalysisReport, ChangedFileDetail, Finding, Severity } from "./types";

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW"
};

export function buildMarkdownReport(report: AnalysisReport): string {
  const topFindings = report.findings.slice(0, 10).map(formatFinding).join("\n");

  return `# Agent Contracts Report

- Workspace: ${report.workspaceName}
- Generated: ${report.generatedAt}
- Scope: ${report.scope}
- Trust score: ${report.trustScore}/100
- Contract: ${report.contractExists ? report.contractPath : `missing (${report.contractPath})`}
- MCP configs analyzed: ${report.mcpConfigs.length}
- Sensitive files matched: ${report.sensitiveFiles.length}
- Changed files considered: ${report.changedFiles.length}

## Summary

${report.summary}

## How the scan works

The report combines:

- the repo contract
- verification rules inferred from package scripts
- sensitive file matches
- MCP config heuristics
- optionally, the current Git diff

## Top findings

${topFindings || "_No findings._"}

## Recommended verification

${formatList(report.recommendedVerification)}

## MCP configs

${formatList(report.mcpConfigs)}

## Sensitive paths seen

${formatList(report.sensitiveFiles.slice(0, 20))}

## Changed files

${formatList(report.changedFiles.slice(0, 50))}

## Changed review queue

${formatChangedFileDetails(report.changedFileDetails)}
`;
}

function formatFinding(finding: Finding): string {
  const location = finding.location ? ` (${finding.location})` : "";
  const recommendation = finding.recommendation ? ` Recommendation: ${finding.recommendation}` : "";
  return `- [${SEVERITY_EMOJI[finding.severity]}] ${finding.title}${location}. ${finding.description}${recommendation}`;
}

function formatList(items: string[]): string {
  if (items.length === 0) {
    return "_None detected._";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatChangedFileDetails(details: ChangedFileDetail[]): string {
  if (details.length === 0) {
    return "_No changed files detected._";
  }

  return details
    .map((detail) => {
      const severity = detail.highestSeverity ? `[${SEVERITY_EMOJI[detail.highestSeverity]}] ` : "";
      const renameInfo = detail.previousPath ? ` from ${detail.previousPath}` : "";
      const findings = detail.findingCount > 0 ? `${detail.findingCount} finding(s)` : "no findings";
      return `- ${severity}${detail.path} | ${detail.status}${renameInfo} | +${detail.addedLines} -${detail.removedLines} | ${findings}`;
    })
    .join("\n");
}

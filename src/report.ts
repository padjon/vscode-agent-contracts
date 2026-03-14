import { AnalysisReport, Finding, Severity } from "./types";

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
- Trust score: ${report.trustScore}/100
- Contract: ${report.contractExists ? report.contractPath : `missing (${report.contractPath})`}
- MCP configs analyzed: ${report.mcpConfigs.length}
- Sensitive files matched: ${report.sensitiveFiles.length}

## Summary

${report.summary}

## Why this extension exists

Developer workflows are moving toward AI-assisted coding, MCP-connected tools, and shared automation inside the editor. What teams still lack is a lightweight, repository-local trust contract that explains:

- which paths are too sensitive for casual agent edits
- which verification commands must run before code is trusted
- which MCP servers are disallowed or higher risk

This extension treats that contract as a first-class artifact inside VS Code.

## Top findings

${topFindings || "_No findings._"}

## Recommended verification

${formatList(report.recommendedVerification)}

## MCP configs

${formatList(report.mcpConfigs)}

## Sensitive paths seen

${formatList(report.sensitiveFiles.slice(0, 20))}
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

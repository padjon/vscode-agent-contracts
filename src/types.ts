export type Severity = "critical" | "high" | "medium" | "low";
export type JsonPathSegment = string | number;

export interface SeverityOverrideRule {
  match: string;
  severity: Severity;
  note?: string;
}

export interface FindingFix {
  kind: "set-value" | "remove-property" | "append-unique";
  path: JsonPathSegment[];
  value?: unknown;
  title: string;
  targetLocation?: string;
  safe?: boolean;
}

export interface FindingRange {
  offset: number;
  length: number;
}

export interface AgentContract {
  protectedPaths: string[];
  requiredVerification: string[];
  blockedCommands: string[];
  blockedMcpServers: string[];
  allowedMcpHosts: string[];
  allowedMcpRunnerTargets: string[];
  severityOverrides: SeverityOverrideRule[];
  notes?: string;
}

export interface ChangedFileDetail {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "renamed" | "copied";
  addedLines: number;
  removedLines: number;
  findingCount: number;
  highestSeverity?: Severity;
}

export interface ChangedMcpServerDetail {
  path: string;
  serverName: string;
  status: "added" | "modified" | "removed";
  findingCount: number;
  highestSeverity?: Severity;
}

export interface Finding {
  id: string;
  severity: Severity;
  defaultSeverity?: Severity;
  title: string;
  description: string;
  source: string;
  location?: string;
  range?: FindingRange;
  jsonPath?: JsonPathSegment[];
  fix?: FindingFix;
  recommendation?: string;
  severityOverride?: {
    match: string;
    note?: string;
  };
}

export interface AnalysisReport {
  workspaceName: string;
  generatedAt: string;
  scope: "workspace" | "changes";
  contractPath: string;
  contractExists: boolean;
  trustScore: number;
  findings: Finding[];
  mcpConfigs: string[];
  sensitiveFiles: string[];
  changedFiles: string[];
  changedFileDetails: ChangedFileDetail[];
  changedMcpServers: ChangedMcpServerDetail[];
  observedMcpHosts: string[];
  observedMcpRunnerTargets: string[];
  recommendedVerification: string[];
  severityOverridesConfigured: number;
  severityOverridesApplied: number;
  summary: string;
}

export type Severity = "critical" | "high" | "medium" | "low";
export type JsonPathSegment = string | number;

export interface FindingFix {
  kind: "set-value" | "remove-property";
  path: JsonPathSegment[];
  value?: unknown;
  title: string;
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
  notes?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  source: string;
  location?: string;
  range?: FindingRange;
  jsonPath?: JsonPathSegment[];
  fix?: FindingFix;
  recommendation?: string;
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
  recommendedVerification: string[];
  summary: string;
}

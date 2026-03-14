export type Severity = "critical" | "high" | "medium" | "low";

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
  recommendation?: string;
}

export interface AnalysisReport {
  workspaceName: string;
  generatedAt: string;
  contractPath: string;
  contractExists: boolean;
  trustScore: number;
  findings: Finding[];
  mcpConfigs: string[];
  sensitiveFiles: string[];
  recommendedVerification: string[];
  summary: string;
}

import { AgentContract } from "./types";

export interface ContractPreset {
  id: string;
  label: string;
  description: string;
  contract: AgentContract;
}

export const CONTRACT_PRESETS: ContractPreset[] = [
  {
    id: "node",
    label: "Node",
    description: "JavaScript/TypeScript services and apps",
    contract: {
      protectedPaths: [
        "**/.env*",
        "**/*.pem",
        ".github/workflows/**",
        "migrations/**",
        "prisma/migrations/**"
      ],
      requiredVerification: [
        "npm run lint",
        "npm run test",
        "npm run build"
      ],
      blockedCommands: [
        "git push --force",
        "rm -rf /",
        "curl | sh"
      ],
      blockedMcpServers: [],
      notes: "Preset for Node and TypeScript repositories. Review scripts and paths before committing."
    }
  },
  {
    id: "python",
    label: "Python",
    description: "Backend services, tooling, and notebooks",
    contract: {
      protectedPaths: [
        "**/.env*",
        "**/*.pem",
        ".github/workflows/**",
        "migrations/**",
        "infra/**"
      ],
      requiredVerification: [
        "pytest",
        "ruff check ."
      ],
      blockedCommands: [
        "git push --force",
        "rm -rf /",
        "curl | sh"
      ],
      blockedMcpServers: [],
      notes: "Preset for Python repositories. Replace commands with your actual test and lint entrypoints."
    }
  },
  {
    id: "terraform",
    label: "Terraform",
    description: "Infrastructure and deployment repos",
    contract: {
      protectedPaths: [
        "**/.env*",
        "**/*.pem",
        ".github/workflows/**",
        "terraform/**",
        "infra/**",
        "prod/**"
      ],
      requiredVerification: [
        "terraform fmt -check",
        "terraform validate"
      ],
      blockedCommands: [
        "git push --force",
        "rm -rf /",
        "curl | sh"
      ],
      blockedMcpServers: [],
      notes: "Preset for Terraform repositories. Add plan and policy checks that match your pipeline."
    }
  }
];

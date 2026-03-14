# Agent Contracts

`Agent Contracts` is a VS Code extension for teams adopting AI-assisted development, MCP servers, and agent workflows without wanting to give up repo-level trust boundaries.

The idea is simple:

- keep a lightweight `.agent-contract.json` file in the repository
- mark sensitive paths that require review
- define verification commands that should run before code is trusted
- flag risky MCP configuration patterns directly inside VS Code

## Why this could matter now

The current editor market is saturated with assistants and chat surfaces. What is still missing is a lightweight governance layer that lives with the codebase:

- AI tooling adoption keeps rising, but trust and verification remain weak points.
- MCP is becoming a standard integration layer for tools inside AI coding workflows.
- Enterprise MCP roadmaps increasingly emphasize trust, observability, and auditability.

That combination creates room for a sponsorable open source utility that helps teams adopt agent workflows more safely.

## MVP

This first version includes:

- `Agent Contracts: Initialize Contract`
- `Agent Contracts: Analyze Workspace`
- `Agent Contracts: Open Report`
- a dedicated Activity Bar view with trust score and top findings
- MCP config analysis for shell wrappers, insecure HTTP, package runners, and inline secrets
- sensitive-path coverage analysis against contract rules
- verification-gap detection based on repository scripts

## Contract format

The extension stores its policy in `.agent-contract.json`.

```json
{
  "protectedPaths": [
    "**/.env*",
    "**/*.pem",
    ".github/workflows/**"
  ],
  "requiredVerification": [
    "npm run lint",
    "npm run test"
  ],
  "blockedCommands": [
    "git push --force",
    "rm -rf /",
    "curl | sh"
  ],
  "blockedMcpServers": []
}
```

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch the extension host.

## Research and plan

The trend and positioning analysis that drove this extension lives in [docs/research.md](docs/research.md).
The execution roadmap and sponsor plan lives in [docs/plan.md](docs/plan.md).

# Research Notes: March 14, 2026

## Executive view

The strongest open opportunity in VS Code is no longer "another AI assistant." That category is crowded.

The sharper gap is a trust layer for agent-era development:

- repositories need a portable policy artifact for sensitive paths and verification expectations
- MCP adoption is accelerating, which broadens the local tool surface inside the editor
- enterprise buyers increasingly care about observability, approval boundaries, and auditability

That points to a sponsorable open source extension category: repo-local governance for AI-assisted coding.

## Trend signals

1. AI tooling is mainstream, but developer trust is still uneven.

- GitHub's 2024 Octoverse report says AI is "fundamentally changing the way developers work" and notes broad adoption across both experienced and new developers.
- Stack Overflow's 2025 Developer Survey reports that large majorities of developers are using or planning to use AI tools, but trust and accuracy remain persistent concerns.

2. VS Code is making agent workflows and MCP first-class.

- VS Code documents MCP support directly in the editor and positions it as the way to connect agents to external tools and data.
- VS Code's 2026 roadmap highlights "production deployments for MCP" and "MCP Enterprise Readiness" with audit trails, observability, and config portability.

3. The ecosystem still over-indexes on capability, not control.

- Current GitHub and marketplace discovery turns up many MCP servers, server browsers, installers, and debugging tools.
- I did not find a strong, established open source VS Code extension focused on repository-local trust contracts: protected paths, verification policy, and MCP risk review in one place.
- There are adjacent early projects around MCP auditing and general governance, which suggests the need is emerging rather than saturated.

## Proposed category

`Agent Contracts`: a VS Code extension that treats agent trust policy as code.

Core promise:

- define what an agent should not touch casually
- define what evidence must exist before code is trusted
- surface MCP and workspace risk before it turns into a production problem

## Why this has sponsor potential

- It sits at the boundary between open source utility and enterprise need.
- Security, DevEx, and AI platform companies can sponsor it without the project needing to become a closed product.
- The extension can become a reference format for `.agent-contract.json`, which increases ecosystem leverage if adopted by other tools.

## Roadmap after MVP

1. Add diagnostics and inline decorations for protected-path violations.
2. Add policy packs for common stacks: Node, Python, Terraform, monorepos.
3. Add PR-mode reporting from changed files, not only whole-repo analysis.
4. Add machine-readable export for CI.
5. Add allowlist/approval support for specific MCP servers and commands.
6. Add change-evidence integrations with test runs and terminal tasks.

## Sources

- GitHub Octoverse 2024: https://github.blog/news-insights/research/the-state-of-open-source-and-ai/
- Stack Overflow Developer Survey 2025: https://survey.stackoverflow.co/2025
- VS Code MCP docs: https://code.visualstudio.com/docs/copilot/chat/mcp-servers
- VS Code roadmap (2026): https://code.visualstudio.com/updates/roadmap#_model-context-protocol-mcp
- Model Context Protocol introduction: https://modelcontextprotocol.io/introduction

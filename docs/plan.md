# Execution Plan

## Goal

Turn `Agent Contracts` into a sponsor-attractive open source VS Code extension for AI-assisted development teams.

## Product thesis

The winning position is not "best assistant." It is "best trust layer for assistants already inside the editor."

That means focusing on:

- repo-local policy
- MCP risk visibility
- verification expectations
- compatibility with existing agent tools instead of competing with them

## Phase 1: Ship a sharp MVP

Status: done in this repository.

Deliverables:

- contract file initialization
- workspace analysis
- MCP config heuristics
- sensitive path protection checks
- markdown reporting
- VS Code marketplace listing

Success criteria:

- users understand the value in under five minutes
- repo owners can commit a contract file on day one
- screenshots and README tell a sponsor-ready story

## Phase 2: Improve day-to-day usefulness

Next implementation targets:

1. Diagnostics on changed files that match protected paths.
2. Inline warnings for MCP configs using unsafe patterns.
3. Quick fixes for adding uncovered paths to the contract.
4. Workspace recommendations by stack: Node, Python, Terraform, monorepo.

Success criteria:

- extension becomes part of normal code review preparation
- fewer users treat it as a one-time audit tool

## Phase 3: Connect to team workflows

Targets:

1. Export machine-readable findings for CI.
2. Analyze only staged or changed files for pull-request workflows.
3. Generate change evidence bundles from tasks and terminal runs.
4. Add policy packs and reusable presets.

Success criteria:

- teams can enforce the same policy in editor and CI
- open source users start contributing stack-specific packs

## Sponsor strategy

Potential sponsor profiles:

- AI coding infrastructure companies
- developer security companies
- platform engineering teams with open source budgets
- consultancies building internal AI coding standards

What to pitch:

- a neutral open standard for `.agent-contract.json`
- visible adoption inside VS Code rather than a backend-only project
- enterprise-adjacent need without forcing a commercial core

Sponsor asks:

1. Sponsor roadmap items such as CI export or policy packs.
2. Fund maintenance and ecosystem integrations.
3. Provide design partners for enterprise workflows.

## Distribution strategy

1. Keep the VS Code extension free and MIT licensed.
2. Publish example contracts for popular stacks.
3. Write short demo posts around MCP trust, not generic AI hype.
4. Show before/after examples of risky MCP configs and missing verification policy.

## Metrics to track

- marketplace installs
- GitHub stars and forks
- number of external contract examples contributed
- issues requesting stack presets or CI support
- sponsor conversations started from the README and marketplace page

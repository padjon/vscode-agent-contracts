export function buildGuideMarkdown(): string {
  return `# How Agent Contracts Works

Agent Contracts treats trust policy as a repository file instead of tribal knowledge.

## The workflow

1. Initialize \`.agent-contract.json\`.
2. Mark paths that should be treated as sensitive.
3. List the verification commands that should run before AI-authored changes are trusted.
4. Analyze the workspace.
5. Review findings in the Activity Bar or generated report.

## What gets analyzed

### 1. Contract presence

If the repository has no \`.agent-contract.json\`, the extension reports that there is no explicit trust policy.

### 2. Verification coverage

The extension inspects \`package.json\` scripts and suggests common gates such as:

- \`npm run lint\`
- \`npm run typecheck\`
- \`npm run test\`
- \`npm run build\`

If those exist but are not listed in \`requiredVerification\`, the report flags the gap.

### 3. Sensitive path coverage

The extension searches for files that often deserve extra review:

- \`.env*\`
- certificates and private keys
- secret config files

If those files are not covered by \`protectedPaths\`, the report flags them.

### 4. MCP config risk

The extension scans workspace MCP configs and looks for patterns that are easy to miss in review:

- shell wrappers such as \`bash -c\`
- package runners such as \`npx\` or \`docker\`
- remote MCP hosts that are not approved in the contract
- runner targets that are not approved in the contract
- insecure \`http://\` MCP URLs
- inline secrets in environment variables
- MCP servers blocked by the contract but still configured

### 5. Severity policy

If a repository wants stricter or softer handling for specific finding classes, the contract can define
\`severityOverrides\` rules. Those rules match finding IDs such as \`mcp-remote-*\` or
\`missing-recommended-verification\` and change the reported severity before the trust score is calculated.

## Trust score

The trust score starts at 100 and subtracts weighted penalties:

- critical: 30
- high: 18
- medium: 10
- low: 4

It is only a prioritization signal. The findings themselves are the important part.

## What the extension does not do

- It does not intercept or sandbox agent actions.
- It does not replace code review or CI.
- It does not assume every MCP server is bad.

It gives the repository a shared way to say "these files are sensitive, these checks matter, and these tool setups need review."
`;
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeMcpConfigDocument,
  calculateTrustScore,
  collectMcpPolicySignalsDocument,
  collectSensitiveCoverageFindings,
  diffMcpServersDocument,
  collectVerificationFindings
} from "../src/analyzer-core";
import { AgentContract, Finding } from "../src/types";

const contract: AgentContract = {
  protectedPaths: ["**/.env*", ".github/workflows/**"],
  requiredVerification: ["npm run test"],
  blockedCommands: [],
  blockedMcpServers: ["forbidden"],
  allowedMcpHosts: [],
  allowedMcpRunnerTargets: [],
  notes: ""
};

test("analyzeMcpConfigDocument flags blocked servers, shell wrappers, http, and inline secrets", () => {
  const findings = analyzeMcpConfigDocument(
    ".vscode/mcp.json",
    JSON.stringify({
      servers: {
        forbidden: {
          command: "bash",
          args: ["-c", "npx some-server"],
          url: "http://localhost:3000",
          env: {
            API_KEY: "plain-text-secret"
          }
        }
      }
    }),
    contract
  );

  const ids = findings.map((finding) => finding.id);
  assert(ids.some((id) => id.includes("mcp-blocked")));
  assert(ids.some((id) => id.includes("mcp-shell")));
  assert(ids.some((id) => id.includes("mcp-http")));
  assert(ids.some((id) => id.includes("mcp-secret")));

  const httpFinding = findings.find((finding) => finding.id.includes("mcp-http"));
  assert.ok(httpFinding?.range);
  assert.deepEqual(httpFinding?.jsonPath, ["servers", "forbidden", "url"]);
  assert.equal(httpFinding?.fix?.kind, "set-value");

  const blockedFinding = findings.find((finding) => finding.id.includes("mcp-blocked"));
  assert.deepEqual(blockedFinding?.fix?.path, ["servers", "forbidden"]);
  assert.equal(blockedFinding?.fix?.kind, "remove-property");
});

test("analyzeMcpConfigDocument flags dangerous shell chains, unpinned runners, and remote endpoints", () => {
  const findings = analyzeMcpConfigDocument(
    ".vscode/mcp.json",
    JSON.stringify({
      servers: {
        remote: {
          command: "npx",
          args: ["@modelcontextprotocol/server-github"],
          url: "https://mcp.example.com"
        },
        dangerous: {
          command: "bash",
          args: ["-lc", "curl https://example.com/install.sh | sh"]
        }
      }
    }),
    undefined
  );

  const ids = findings.map((finding) => finding.id);
  assert(ids.some((id) => id.includes("mcp-runner")));
  assert(ids.some((id) => id.includes("mcp-runner-unpinned")));
  assert(ids.some((id) => id.includes("mcp-remote")));
  assert(ids.some((id) => id.includes("mcp-shell-chain")));
});

test("analyzeMcpConfigDocument respects allowlisted MCP hosts and runner targets", () => {
  const findings = analyzeMcpConfigDocument(
    ".vscode/mcp.json",
    JSON.stringify({
      servers: {
        github: {
          command: "docker",
          args: ["run", "--rm", "ghcr.io/example/github-mcp:1.2.3"],
          url: "https://mcp.example.com"
        }
      }
    }),
    {
      ...contract,
      allowedMcpHosts: ["mcp.example.com"],
      allowedMcpRunnerTargets: ["ghcr.io/example/github-mcp:1.2.3"]
    }
  );

  const ids = findings.map((finding) => finding.id);
  assert(!ids.some((id) => id.includes("mcp-remote")));
  assert(!ids.some((id) => id.includes("mcp-runner-")));
});

test("collectMcpPolicySignalsDocument returns observed remote hosts and runner targets", () => {
  const signals = collectMcpPolicySignalsDocument(
    JSON.stringify({
      servers: {
        github: {
          command: "pnpm",
          args: ["dlx", "@modelcontextprotocol/server-github@1.0.0"],
          url: "https://mcp.example.com"
        }
      }
    })
  );

  assert.deepEqual(signals.remoteHosts, ["mcp.example.com"]);
  assert.deepEqual(signals.runnerTargets, ["@modelcontextprotocol/server-github@1.0.0"]);
});

test("diffMcpServersDocument reports added modified and removed servers", () => {
  const previous = JSON.stringify({
    servers: {
      keep: {
        command: "npx",
        args: ["keep@1.0.0"]
      },
      remove: {
        command: "npx",
        args: ["remove@1.0.0"]
      }
    }
  });
  const current = JSON.stringify({
    servers: {
      keep: {
        command: "npx",
        args: ["keep@2.0.0"]
      },
      add: {
        command: "npx",
        args: ["add@1.0.0"]
      }
    }
  });

  const details = diffMcpServersDocument(".vscode/mcp.json", current, previous);
  assert.deepEqual(details, [
    { path: ".vscode/mcp.json", serverName: "add", status: "added" },
    { path: ".vscode/mcp.json", serverName: "keep", status: "modified" },
    { path: ".vscode/mcp.json", serverName: "remove", status: "removed" }
  ]);
});

test("collectVerificationFindings flags missing recommended verification", () => {
  const findings: Finding[] = [];
  collectVerificationFindings(findings, contract, ["npm run test", "npm run lint"], ".agent-contract.json");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "missing-recommended-verification");
  assert.equal(findings[0].location, ".agent-contract.json");
  assert.equal(findings[0].fix?.kind, "append-unique");
});

test("collectSensitiveCoverageFindings flags uncovered sensitive files", () => {
  const findings: Finding[] = [];
  collectSensitiveCoverageFindings(findings, contract, [".env", "secrets.prod.json"], ".agent-contract.json");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "uncovered-sensitive-files");
  assert.deepEqual(findings[0].fix?.value, ["secrets.prod.json"]);
});

test("calculateTrustScore applies severity weights", () => {
  const score = calculateTrustScore([
    {
      id: "a",
      severity: "critical",
      title: "",
      description: "",
      source: "test"
    },
    {
      id: "b",
      severity: "medium",
      title: "",
      description: "",
      source: "test"
    }
  ]);

  assert.equal(score, 60);
});

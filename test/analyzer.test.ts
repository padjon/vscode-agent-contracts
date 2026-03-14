import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeMcpConfigDocument,
  calculateTrustScore,
  collectSensitiveCoverageFindings,
  collectVerificationFindings
} from "../src/analyzer-core";
import { AgentContract, Finding } from "../src/types";

const contract: AgentContract = {
  protectedPaths: ["**/.env*", ".github/workflows/**"],
  requiredVerification: ["npm run test"],
  blockedCommands: [],
  blockedMcpServers: ["forbidden"],
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

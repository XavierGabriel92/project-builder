import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FlowDefinition } from "../../src/shared/types.ts";
import { loadAgent, loadFlowAgents } from "../../src/orchestrator/agent-loader.ts";

let tmpDir: string;
let agentsDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-agent-loader-test-"));
  agentsDir = path.join(tmpDir, "agents");
  fs.mkdirSync(path.join(agentsDir, "subagents"), { recursive: true });

  fs.writeFileSync(
    path.join(agentsDir, "orchestrator.md"),
    [
      "---",
      "id: orchestrator",
      "version: 1",
      'tools: ["subagent", "read"]',
      'subagents: {"scout": "subagents/scout.md"}',
      "parallel_over: service_dirs",
      "parallel_subagent: scout",
      "---",
      "Coordinate scouts.",
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(agentsDir, "subagents", "scout.md"),
    [
      "---",
      "id: scout",
      "version: 1",
      'tools: ["read"]',
      "---",
      "Scout the assigned scope.",
    ].join("\n")
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadAgent", () => {
  it("loads subagents from relative .md paths without appending .md twice", () => {
    const loaded = loadAgent(agentsDir, "subagents/scout.md", true);

    assert.equal(loaded.manifest.id, "scout");
    assert.equal(loaded.isSubagent, true);
    assert.ok(loaded.prompt.includes("Scout the assigned scope."));
  });
});

describe("loadFlowAgents", () => {
  it("loads main agents and named subagents for a flow", () => {
    const flow: FlowDefinition = {
      id: "loader-flow",
      version: 1,
      description: "Loader flow",
      steps: [{ agent: "orchestrator" }],
    };

    const agents = loadFlowAgents(agentsDir, flow);

    assert.ok(agents.has("orchestrator"));
    assert.ok(agents.has("scout"));
    assert.equal(agents.get("scout")?.isSubagent, true);
  });
});

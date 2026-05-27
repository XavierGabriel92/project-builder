import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { allFlows } from "../../flows/index.ts";
import { loadFlowAgents, validateFlowApproval } from "../../src/engine/agent-loader.ts";

const agentsDir = fileURLToPath(new URL("../../agents", import.meta.url));

describe("real flow validation", () => {
  it("loads every registered flow and referenced agent manifest", () => {
    for (const flow of allFlows) {
      const agents = loadFlowAgents(agentsDir, flow);

      validateFlowApproval(agentsDir, flow);
      assert.ok(agents.size > 0);
    }
  });
});

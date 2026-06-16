/**
 * Integration tests for the flow engine.
 *
 * Uses temp directories to test actual workflow.json read/write.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { FlowDefinition } from "../../src/shared/types.ts";
import { start, step, stepUpdate, stepComplete, recordGate, status, list } from "../../src/engine/engine.ts";

// Test flow with retries and approval
// strictOutputs: false — tests submit success without writing the declared output files
const testFlow: FlowDefinition = {
  id: "test-flow",
  version: 1,
  description: "Test flow",
  strictOutputs: false,
  steps: [
    { agent: "gather-input", requestApproval: true },
    { agent: "implement", attempts: 2 },
    { agent: "review" },
  ],
};

let tmpDir: string;
let projectRoot: string;
let agentsDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-engine-test-"));
  projectRoot = path.join(tmpDir, "project");
  fs.mkdirSync(projectRoot, { recursive: true });

  // Set up agents directory with minimal agent .md files for testing
  agentsDir = path.join(tmpDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  // gather-input.md (main agent with approval)
  fs.writeFileSync(
    path.join(agentsDir, "gather-input.md"),
    [
      "---",
      "id: gather-input",
      "version: 1",
      'tools: ["ask_user_question", "read"]',
      'outputs: ["feature-input.md"]',
      'approval: {"header": "Gather Input", "options": [{"label": "Approve", "description": "Looks good", "advance": true}, {"label": "Refine", "description": "Need more", "advance": false}]}',
      "---",
      "Gather input from the user.",
    ].join("\n")
  );

  // implement.md (main agent, no approval, with attempts)
  fs.writeFileSync(
    path.join(agentsDir, "implement.md"),
    [
      "---",
      "id: implement",
      "version: 1",
      'tools: ["subagent", "read", "write", "edit", "bash"]',
      'subagents: {"worker": "subagents/worker.md"}',
      "parallel_over: service_dirs",
      "parallel_subagent: worker",
      "parallel_concurrency: 4",
      "---",
      "Implement the feature using workers.",
    ].join("\n")
  );

  // review.md (main agent with approval)
  fs.writeFileSync(
    path.join(agentsDir, "review.md"),
    [
      "---",
      "id: review",
      "version: 1",
      'tools: ["read", "bash"]',
      'approval: {"header": "Review", "options": [{"label": "Approve", "description": "Good", "advance": true}, {"label": "Changes needed", "description": "Fix", "advance": false}]}',
      "---",
      "Review the changes.",
    ].join("\n")
  );

  // worker.md (subagent)
  fs.mkdirSync(path.join(agentsDir, "subagents"), { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, "subagents", "worker.md"),
    [
      "---",
      "id: worker",
      "version: 1",
      'tools: ["read", "write", "edit", "bash"]',
      "---",
      "Implement the assigned task.",
    ].join("\n")
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("engine.start", () => {
  it("creates workflow.json with frozen snapshot", () => {
    const result = start(testFlow, "test-feature", projectRoot, { agentsDir });

    assert.equal(result.state.flow_id, "test-flow");
    assert.equal(result.state.feature, "test-feature");
    assert.equal(result.state.status, "in_progress");
    assert.equal(result.state.steps.length, 3);

    // Verify workflow.json was written
    const wfPath = path.join(projectRoot, ".temp", result.featurePath, "workflow.json");
    assert.ok(fs.existsSync(wfPath));

    const raw = JSON.parse(fs.readFileSync(wfPath, "utf-8"));
    assert.equal(raw.flow_snapshot.steps.length, 3);
  });

  it("rejects when requestApproval step has no approval block", () => {
    const badFlow: FlowDefinition = {
      id: "bad",
      version: 1,
      description: "Bad",
      steps: [{ agent: "implement", requestApproval: true }], // implement has no approval block
    };

    assert.throws(
      () => start(badFlow, "bad-feat", projectRoot, { agentsDir }),
      /requires user approval/
    );
  });

  it("creates date-stamped feature path", () => {
    const result = start(testFlow, "My Cool Feature!", projectRoot, { agentsDir });

    // Format: DD-MM-YYYY-my-cool-feature
    assert.match(result.featurePath, /^\d{2}-\d{2}-\d{4}-my-cool-feature$/);
  });
});

describe("engine.step", () => {
  it("returns step instruction for the current step", () => {
    const { featurePath } = start(testFlow, "step-test", projectRoot, { agentsDir });

    const instruction = step(projectRoot, { featurePath, agentsDir });

    assert.ok(instruction);
    assert.equal(instruction.agent, "gather-input");
    assert.equal(instruction.stepIndex, 0);
    assert.equal(instruction.attempt, 1);
    assert.equal(instruction.maxAttempts, 1); // default
    assert.equal(instruction.requestApproval, true);
    assert.deepEqual(instruction.tools, ["ask_user_question", "read"]);
    assert.ok(instruction.prompt.includes("Gather input from the user."));

    // Verify step is marked as running
    const state = status(projectRoot, featurePath);
    assert.equal(state?.steps[0].status, "running");
    assert.equal(state?.steps[0].attempt, 1);
  });

  it("returns null when no workflow exists", () => {
    const result = step(projectRoot, { featurePath: "nonexistent-path", agentsDir });
    assert.equal(result, null);
  });
});

describe("engine.stepUpdate", () => {
  it("persists incremental running-step activity", () => {
    const { featurePath } = start(testFlow, "activity-test", projectRoot, { agentsDir });
    step(projectRoot, { featurePath, agentsDir });

    const outcome = stepUpdate(
      {
        phase: "reading plan",
        message: "Checking implementation scope",
        childRunIds: ["child-1"],
      },
      projectRoot,
      featurePath
    );

    assert.ok(outcome);
    assert.equal(outcome.error, undefined);
    const state = status(projectRoot, featurePath);
    assert.equal(state?.steps[0].activity?.phase, "reading plan");
    assert.equal(state?.steps[0].activity?.message, "Checking implementation scope");
    assert.deepEqual(state?.steps[0].activity?.child_run_ids, ["child-1"]);
  });
});

describe("engine.stepComplete + recordGate (full walkthrough)", () => {
  it("walks through all 3 steps successfully", () => {
    const { featurePath } = start(testFlow, "walkthrough", projectRoot, { agentsDir });

    // --- Step 1: gather-input ---
    let instruction = step(projectRoot, { featurePath, agentsDir });
    assert.equal(instruction?.agent, "gather-input");

    // Submit success → should trigger gate
    let outcome = stepComplete(
      { result: "success", message: "Input gathered" },
      projectRoot,
      { featurePath, agentsDir }
    );
    assert.ok(outcome);
    assert.equal(outcome.action, "gate");
    assert.ok(outcome.gate);
    assert.equal(outcome.gate.header, "Gather Input");

    // Answer gate: approve
    const gatherGateNonce = outcome.gate!.nonce;
    let gateResult = recordGate(
      { stepIndex: 0, chosenLabel: "Approve", advance: true, gateNonce: gatherGateNonce },
      projectRoot,
      featurePath
    );
    assert.ok(gateResult);
    assert.equal(gateResult.action, "advance");

    // --- Step 2: implement ---
    instruction = step(projectRoot, { featurePath, agentsDir });
    assert.equal(instruction?.agent, "implement");
    assert.equal(instruction?.attempt, 1);
    assert.equal(instruction?.maxAttempts, 2);
    assert.ok(instruction?.subagents);
    assert.ok(instruction?.subagentInstructions?.worker);
    assert.ok(instruction.subagentInstructions.worker.prompt.includes("Implement the assigned task."));
    assert.ok(instruction?.parallel);
    assert.equal(instruction?.parallel?.subagent, "worker");

    // Submit success (no approval on this step)
    outcome = stepComplete(
      { result: "success", message: "Implemented" },
      projectRoot,
      { featurePath, agentsDir }
    );
    assert.ok(outcome);
    assert.equal(outcome.action, "advance");

    // --- Step 3: review ---
    instruction = step(projectRoot, { featurePath, agentsDir });
    assert.equal(instruction?.agent, "review");

    // Submit success (review has no requestApproval in this flow)
    outcome = stepComplete(
      { result: "success", message: "Reviewed" },
      projectRoot,
      { featurePath, agentsDir }
    );
    assert.ok(outcome);
    assert.equal(outcome.action, "done");
    assert.equal(outcome.state.status, "done");
    assert.equal(outcome.state.build_status, "DONE");
  });

  it("retries implement step on first failure, blocks on second", () => {
    const { featurePath } = start(testFlow, "retry-test", projectRoot, { agentsDir });

    // Advance past gather-input
    step(projectRoot, { featurePath, agentsDir });
    const gatherOutcome = stepComplete(
      { result: "success", message: "Done" },
      projectRoot,
      { featurePath, agentsDir }
    );
    recordGate(
      { stepIndex: 0, chosenLabel: "Approve", advance: true, gateNonce: gatherOutcome!.gate!.nonce },
      projectRoot,
      featurePath
    );

    // --- implement step, attempt 1 ---
    step(projectRoot, { featurePath, agentsDir });
    let outcome = stepComplete(
      { result: "error", message: "Build failed", retryable: true },
      projectRoot,
      { featurePath, agentsDir }
    );
    assert.ok(outcome);
    assert.equal(outcome.action, "retry");

    let state = status(projectRoot, featurePath);
    assert.equal(state?.steps[1].status, "pending"); // reset for retry

    // --- implement step, attempt 2 (last) ---
    step(projectRoot, { featurePath, agentsDir });
    outcome = stepComplete(
      { result: "error", message: "Still failing", retryable: false },
      projectRoot,
      { featurePath, agentsDir }
    );
    assert.ok(outcome);
    assert.equal(outcome.action, "block");
    assert.equal(outcome.state.status, "blocked");
    assert.equal(outcome.state.build_status, "BLOCKED");

    state = status(projectRoot, featurePath);
    assert.equal(state?.steps[1].status, "failed");
    assert.equal(state?.steps[1].attempt, 2);
  });

  it("re-runs step when gate answer is not advance", () => {
    const { featurePath } = start(testFlow, "gate-retry", projectRoot, { agentsDir });

    step(projectRoot, { featurePath, agentsDir });
    let outcome = stepComplete(
      { result: "success", message: "Draft" },
      projectRoot,
      { featurePath, agentsDir }
    );
    assert.equal(outcome?.action, "gate");

    // User says "refine" (not approved)
    const gateNonce = outcome.gate!.nonce;
    let gateResult = recordGate(
      { stepIndex: 0, chosenLabel: "Refine", advance: false, gateNonce },
      projectRoot,
      featurePath
    );
    assert.ok(gateResult);
    assert.equal(gateResult.action, "retry");

    // Step should be pending again
    const state = status(projectRoot, featurePath);
    assert.equal(state?.steps[0].status, "pending");
  });

  it("accepts gate answer without nonce (backward compat)", () => {
    const { featurePath } = start(testFlow, "missing-nonce", projectRoot, { agentsDir });

    step(projectRoot, { featurePath, agentsDir });
    let outcome = stepComplete(
      { result: "success", message: "Done" },
      projectRoot,
      { featurePath, agentsDir }
    );
    assert.equal(outcome?.action, "gate");
    assert.ok(outcome.gate?.nonce); // nonce was generated

    // Answer gate WITHOUT gateNonce (simulating old agent)
    let gateResult = recordGate(
      { stepIndex: 0, chosenLabel: "Approve", advance: true },
      projectRoot,
      featurePath
    );
    assert.ok(gateResult);
    assert.equal(gateResult.action, "advance"); // still advances
    assert.ok(gateResult.warning); // warning emitted
    assert.match(gateResult.warning!, /without gateNonce/);

    // Workflow advanced to step 1
    const state = status(projectRoot, featurePath);
    assert.equal(state?.status, "in_progress");
    assert.equal(state?.current_step_index, 1);
  });

  it("warns when a successful step is missing declared outputs", () => {
    const { featurePath } = start(testFlow, "missing-output", projectRoot, { agentsDir });

    step(projectRoot, { featurePath, agentsDir });
    const outcome = stepComplete(
      { result: "success", message: "Done without artifact" },
      projectRoot,
      { featurePath, agentsDir }
    );

    assert.ok(outcome?.warnings?.some((warning) => warning.includes("feature-input.md")));
  });

  it("stores service_dirs metadata on successful step completion", () => {
    const { featurePath } = start(testFlow, "metadata", projectRoot, { agentsDir });

    step(projectRoot, { featurePath, agentsDir });
    const outcome = stepComplete(
      {
        result: "success",
        message: "Input gathered",
        metadata: { service_dirs: ["services/api", "packages/web"] },
      },
      projectRoot,
      { featurePath, agentsDir }
    );

    assert.deepEqual(outcome?.state.service_dirs, ["services/api", "packages/web"]);
  });
});

describe("engine.list + status", () => {
  it("lists all workflows", () => {
    start(testFlow, "list-test-1", projectRoot, { agentsDir });
    start(testFlow, "list-test-2", projectRoot, { agentsDir });

    const workflows = list(projectRoot);
    assert.ok(workflows.length >= 2);

    // Both should be listed
    const found = workflows.filter((p) => p.includes("list-test"));
    assert.equal(found.length, 2);
  });

  it("returns null for unknown feature path", () => {
    const result = status(projectRoot, "nonexistent");
    assert.equal(result, null);
  });
});

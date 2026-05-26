/**
 * Unit tests for state machine transitions
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { FlowDefinition, WorkflowGate } from "../../src/shared/types.ts";
import {
  createWorkflowState,
  startStep,
  applyStepResult,
  applyGateAnswer,
  currentStep,
} from "../../src/orchestrator/transitions.ts";

// Helper: create a simple flow for testing
function testFlow(): FlowDefinition {
  return {
    id: "test-flow",
    version: 1,
    description: "Test flow",
    steps: [
      { agent: "step-a" },
      { agent: "step-b", requestApproval: true },
      { agent: "step-c", attempts: 2 },
    ],
  };
}

// Helper: create a gate for testing
function testGate(stepIndex: number): WorkflowGate {
  return {
    header: "Approve?",
    options: [
      { label: "Yes", description: "Proceed", advance: true },
      { label: "No", description: "Go back", advance: false },
    ],
    stepIndex,
  };
}

function feedbackGate(stepIndex: number): WorkflowGate {
  return {
    header: "Approve?",
    options: [
      { label: "Approve", description: "Proceed", advance: true },
      { label: "Request changes", description: "Go back", advance: false, feedback: true },
    ],
    stepIndex,
  };
}

describe("createWorkflowState", () => {
  it("creates initial state with all steps pending", () => {
    const state = createWorkflowState(testFlow(), "test-feat", "01-01-2024-test-feat", "/project");

    assert.equal(state.flow_id, "test-flow");
    assert.equal(state.feature, "test-feat");
    assert.equal(state.status, "in_progress");
    assert.equal(state.current_step_index, 0);
    assert.equal(state.steps.length, 3);
    assert.equal(state.steps[0].status, "pending");
    assert.equal(state.steps[0].attempt, 0);
    assert.equal(state.steps[0].agent, "step-a");
    assert.equal(state.steps[1].agent, "step-b");
    assert.equal(state.steps[2].agent, "step-c");
  });

  it("freezes flow_snapshot independently", () => {
    const flow = testFlow();
    const state = createWorkflowState(flow, "feat", "path", "/project");

    // Mutate original flow — should not affect snapshot
    flow.steps.push({ agent: "step-d" });

    assert.equal(state.flow_snapshot.steps.length, 3);
  });
});

describe("startStep", () => {
  it("marks current step as running", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state = startStep(state);

    assert.equal(state.steps[0].status, "running");
    assert.equal(state.steps[0].attempt, 1);
    assert.ok(state.steps[0].started_at);
  });

  it("increments attempt on subsequent starts", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state = startStep(state);
    assert.equal(state.steps[0].attempt, 1);

    // Simulate a failed step that gets retried
    state.steps[0].status = "pending"; // reset
    state = startStep(state);
    assert.equal(state.steps[0].attempt, 2);
  });
});

describe("applyStepResult", () => {
  function noGate(): null {
    return null;
  }

  it("advances to next step on success (no approval)", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state = startStep(state);

    const transition = applyStepResult(state, { result: "success", message: "Done" }, () => noGate());

    assert.equal(transition.action, "advance");
    assert.equal(transition.state.current_step_index, 1);
    assert.equal(transition.state.steps[0].status, "completed");
    assert.equal(transition.state.steps[0].result?.result, "success");
    assert.equal(transition.state.status, "in_progress");
  });

  it("gates on success when requestApproval is true", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    // Advance past step-a
    state = startStep(state);
    state = applyStepResult(state, { result: "success", message: "A done" }, () => noGate()).state;
    assert.equal(state.current_step_index, 1);

    // Now step-b has requestApproval: true
    state = startStep(state);

    const transition = applyStepResult(state, { result: "success", message: "B done" }, (_agent, idx) =>
      testGate(idx)
    );

    assert.equal(transition.action, "gate");
    assert.equal(transition.state.status, "awaiting_user");
    assert.equal(transition.state.awaiting, "user_gate");
    assert.ok(transition.gate);
    assert.equal(transition.gate!.header, "Approve?");
  });

  it("blocks when gate is missing but requestApproval is true", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    // Skip to step-b
    state.current_step_index = 1;
    state = startStep(state);

    const transition = applyStepResult(state, { result: "success", message: "Done" }, () => null);

    assert.equal(transition.action, "block");
    assert.ok(transition.error?.includes("no approval block"));
  });

  it("retries on error with attempts remaining", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    // Skip to step-c which has attempts: 2
    state.current_step_index = 2;
    state = startStep(state);

    const transition = applyStepResult(
      state,
      { result: "error", message: "Boom", retryable: true },
      () => noGate()
    );

    assert.equal(transition.action, "retry");
    assert.equal(transition.state.steps[2].status, "pending"); // reset for retry
    assert.equal(transition.state.current_step_index, 2); // same step
  });

  it("blocks non-retryable errors even when attempts remain", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state.current_step_index = 2;
    state = startStep(state);

    const transition = applyStepResult(
      state,
      { result: "error", message: "Permanent failure", retryable: false },
      () => noGate()
    );

    assert.equal(transition.action, "block");
    assert.equal(transition.state.status, "blocked");
    assert.equal(transition.state.steps[2].status, "failed");
  });

  it("blocks completion when workflow is awaiting a user gate", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state = startStep(state);
    state.status = "awaiting_user";
    state.awaiting = "user_gate";
    state.gate = testGate(0);

    const transition = applyStepResult(
      state,
      { result: "success", message: "Too late" },
      () => noGate()
    );

    assert.equal(transition.action, "block");
    assert.match(transition.error ?? "", /awaiting user approval/);
  });

  it("blocks completion when the current step is not running", () => {
    const state = createWorkflowState(testFlow(), "feat", "path", "/project");

    const transition = applyStepResult(
      state,
      { result: "success", message: "Not run" },
      () => noGate()
    );

    assert.equal(transition.action, "block");
    assert.match(transition.error ?? "", /call flow_step/);
  });

  it("merges service directory metadata on success", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state = startStep(state);

    const transition = applyStepResult(
      state,
      {
        result: "success",
        message: "Planned",
        metadata: { service_dirs: ["services/api", "services/api", "packages/web"] },
      },
      () => noGate()
    );

    assert.deepEqual(transition.state.service_dirs, ["services/api", "packages/web"]);
  });

  it("blocks when retries exhausted", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state.current_step_index = 2;
    state = startStep(state);
    // First attempt fails
    state = applyStepResult(
      state,
      { result: "error", message: "Boom" },
      () => noGate()
    ).state;

    // Second attempt (attempt = 2, max = 2)
    state = startStep(state);
    assert.equal(state.steps[2].attempt, 2);

    const transition = applyStepResult(
      state,
      { result: "error", message: "Boom again" },
      () => noGate()
    );

    assert.equal(transition.action, "block");
    assert.equal(transition.state.status, "blocked");
    assert.equal(transition.state.build_status, "BLOCKED");
  });

  it("marks workflow done after last step success", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    // Complete all three steps
    state.current_step_index = 2;
    state = startStep(state);

    const transition = applyStepResult(state, { result: "success", message: "All done" }, () => noGate());

    assert.equal(transition.action, "done");
    assert.equal(transition.state.status, "done");
    assert.equal(transition.state.build_status, "DONE");
  });

  it("preserves step result in completed state", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state = startStep(state);

    const transition = applyStepResult(state, { result: "success", message: "Great work" }, () => noGate());

    assert.equal(transition.state.steps[0].result?.message, "Great work");
    assert.ok(transition.state.steps[0].completed_at);
  });
});

describe("applyGateAnswer", () => {
  it("advances to next step when advance is true", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state.current_step_index = 1;
    state.status = "awaiting_user";
    state.awaiting = "user_gate";
    state.gate = testGate(1);

    const transition = applyGateAnswer(state, {
      stepIndex: 1,
      chosenLabel: "Yes",
      advance: true,
    });

    assert.equal(transition.action, "advance");
    assert.equal(transition.state.current_step_index, 2);
    assert.equal(transition.state.status, "in_progress");
    assert.equal(transition.state.awaiting, null);
    assert.equal(transition.state.gate, undefined);
  });

  it("resets step for re-run when advance is false", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state.current_step_index = 1;
    state.status = "awaiting_user";
    state.awaiting = "user_gate";
    state.gate = testGate(1);
    state.steps[1].status = "completed";

    const transition = applyGateAnswer(state, {
      stepIndex: 1,
      chosenLabel: "No",
      advance: false,
    });

    assert.equal(transition.action, "retry");
    assert.equal(transition.state.steps[1].status, "pending");
  });

  it("persists feedback on the step when advance is false", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state.current_step_index = 1;
    state.status = "awaiting_user";
    state.awaiting = "user_gate";
    state.gate = testGate(1);
    state.steps[1].status = "completed";

    const transition = applyGateAnswer(state, {
      stepIndex: 1,
      chosenLabel: "No",
      advance: false,
      feedback: "Please add more details",
    });

    assert.equal(transition.action, "retry");
    assert.equal(transition.state.steps[1].status, "pending");
    assert.equal(transition.state.steps[1].last_feedback, "Please add more details");
  });

  it("keeps the gate open when a feedback option has no feedback", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state.current_step_index = 1;
    state.status = "awaiting_user";
    state.awaiting = "user_gate";
    state.gate = feedbackGate(1);
    state.steps[1].status = "completed";

    const transition = applyGateAnswer(state, {
      stepIndex: 1,
      chosenLabel: "Request changes",
      advance: false,
    });

    assert.equal(transition.action, "block");
    assert.match(transition.error ?? "", /requires feedback/);
    assert.equal(transition.state.status, "awaiting_user");
    assert.equal(transition.state.awaiting, "user_gate");
    assert.equal(transition.state.steps[1].status, "completed");
  });

  it("stores trimmed feedback for feedback options", () => {
    let state = createWorkflowState(testFlow(), "feat", "path", "/project");
    state.current_step_index = 1;
    state.status = "awaiting_user";
    state.awaiting = "user_gate";
    state.gate = feedbackGate(1);
    state.steps[1].status = "completed";

    const transition = applyGateAnswer(state, {
      stepIndex: 1,
      chosenLabel: "Request changes",
      advance: false,
      feedback: "  Please add tests  ",
    });

    assert.equal(transition.action, "retry");
    assert.equal(transition.state.steps[1].status, "pending");
    assert.equal(transition.state.steps[1].last_feedback, "Please add tests");
  });

  it("marks done when last step is gated and approved", () => {
    // Create a 1-step flow
    const singleStepFlow: FlowDefinition = {
      id: "single",
      version: 1,
      description: "Single step",
      steps: [{ agent: "only", requestApproval: true }],
    };

    let state = createWorkflowState(singleStepFlow, "feat", "path", "/project");
    state.current_step_index = 0;
    state.status = "awaiting_user";
    state.awaiting = "user_gate";
    state.gate = testGate(0);

    const transition = applyGateAnswer(state, {
      stepIndex: 0,
      chosenLabel: "Yes",
      advance: true,
    });

    assert.equal(transition.action, "done");
    assert.equal(transition.state.status, "done");
    assert.equal(transition.state.build_status, "DONE");
  });
});

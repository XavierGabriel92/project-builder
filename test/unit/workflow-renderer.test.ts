import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { WorkflowState } from "../../src/shared/types.ts";
import { fitLineBudget, renderWorkflowStatus } from "../../src/engine/workflow-renderer.ts";

function workflowState(): WorkflowState {
  return {
    schema_version: 1,
    feature: "trainer-exercise-detail-modal",
    feature_path: "26-05-2026-trainer-exercise-detail-modal",
    project_root: "/project",
    flow_id: "feature-build",
    flow_version: 2,
    flow_snapshot: { id: "feature-build", version: 2, description: "Build", steps: [{ agent: "gather-input" }, { agent: "implement" }] },
    current_step_index: 1,
    status: "in_progress",
    awaiting: null,
    steps: [
      { index: 0, id: "gather-input", agent: "gather-input", status: "completed", attempt: 1, result: { result: "success", message: "Input captured" } },
      {
        index: 1,
        id: "implement",
        agent: "implement",
        status: "running",
        attempt: 1,
        started_at: new Date(1_000).toISOString(),
        activity: {
          phase: "coordinating workers",
          message: "Integrating worker results",
          status: "working",
          child_run_ids: ["run-1"],
          updated_at: new Date(3_000).toISOString(),
        },
      },
    ],
    build_status: null,
  };
}

describe("workflow renderer", () => {
  it("renders compact active-step status with child activity", () => {
    const lines = renderWorkflowStatus(workflowState(), {
      compact: true,
      loadingIcon: "*",
      now: 91_000,
      childRuns: [
        {
          id: "run-1",
          state: "running",
          mode: "single",
          agents: ["worker"],
          steps: [
            {
              agent: "worker",
              status: "running",
              currentTool: "read",
              currentToolStartedAt: 90_000,
              toolCount: 18,
              tokens: { total: 15_000 },
            },
          ],
        },
      ],
    });

    const text = lines.join("\n");
    assert.match(text, /feature-build v2/);
    assert.match(text, /step 2\/2 implement · running 1m30s/);
    assert.match(text, /implement · Integrating worker results/);
    assert.match(text, /\* worker · read 1s · 18 tools · 15k token/);
  });

  it("renders expanded step and child details", () => {
    const lines = renderWorkflowStatus(workflowState(), {
      expanded: true,
      loadingIcon: "*",
      now: 91_000,
      childRuns: [
        {
          id: "run-1",
          state: "running",
          mode: "single",
          outputFile: "/tmp/output-0.log",
          steps: [
            {
              agent: "worker",
              status: "running",
              currentTool: "read",
              currentToolArgs: "src/extension/index.ts",
              recentOutput: ["Checking intermediate results..."],
            },
          ],
        },
      ],
    });

    const text = lines.join("\n");
    assert.match(text, /Step 2: implement · running/);
    assert.match(text, /worker/);
    assert.match(text, /read: src\/extension\/index.ts/);
    assert.match(text, /recent: Checking intermediate results/);
    assert.match(text, /output: \/tmp\/output-0\.log/);
  });

  it("adds a hidden-lines hint when over budget", () => {
    const lines = fitLineBudget(["a", "b", "c", "d", "e", "f"], 10, false);
    assert.match(lines.at(-1) ?? "", /Ctrl\+O expands/);
  });
});

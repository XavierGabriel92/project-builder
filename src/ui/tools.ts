/**
 * Project Builder UI — Tool Registration
 *
 * All flow_* tools moved from project-builder/src/extension/index.ts.
 * Now receives agentsDir from the engine context.
 */

import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { FlowDefinition } from "../shared/types.ts";
import { renderWorkflowStatus } from "../engine/workflow-renderer.ts";
import { listCorrelatedSubagentRuns } from "../engine/subagent-activity.ts";
import type { EngineContext } from "./engine-context.ts";

function getProjectRoot(): string {
  return process.cwd();
}

function textResult(text: string, details?: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

function errorResult(text: string, details?: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: "text", text }], details: { isError: true, ...details } };
}

export function registerTools(pi: ExtensionAPI, engine: EngineContext): void {
  // ---------------------------------------------------------------------------
  // Tool: flow_start
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_start",
    label: "Start Flow",
    description:
      "Start a new workflow run. Creates a frozen workflow snapshot in .temp/{featurePath}/workflow.json.",
    promptSnippet: "Start a new workflow using an inline flow definition",
    parameters: Type.Object({
      flowDefinition: Type.Object({
        id: Type.String(),
        version: Type.Number(),
        description: Type.String(),
        steps: Type.Array(
          Type.Object({
            agent: Type.String(),
            requestApproval: Type.Optional(Type.Boolean()),
            attempts: Type.Optional(Type.Number()),
          })
        ),
      }),
      featureName: Type.String({ description: "Human-readable name for what's being built (e.g. 'user-auth')" }),
      agentsDir: Type.Optional(Type.String({ description: "Path to agents/ directory (defaults to {projectRoot}/agents)" })),
      serviceDirs: Type.Optional(Type.Array(Type.String({ description: "Service directories touched by the flow" }))),
      projectRoot: Type.Optional(Type.String({ description: "Project root directory (defaults to cwd)" })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        flowDefinition: FlowDefinition;
        featureName: string;
        agentsDir?: string;
        serviceDirs?: string[];
        projectRoot?: string;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      try {
        engine.validateFlows([params.flowDefinition]);
      } catch (err) {
        return errorResult(`Flow validation failed: ${(err as Error).message}`);
      }

      try {
        const result = engine.start(params.flowDefinition, params.featureName, projectRoot, {
          serviceDirs: params.serviceDirs,
        });
        return textResult(renderWorkflowStatus(result.state).join("\n"), { featurePath: result.featurePath });
      } catch (err) {
        return errorResult(`Error starting flow: ${(err as Error).message}`);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_step
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_step",
    label: "Flow Step",
    description:
      "Get the current step's instructions. Returns the agent to run, available tools, subagent config, parallel settings, and the agent's prompt. Marks the step as 'running'.",
    promptSnippet: "Get instructions for the current step in an active workflow",
    parameters: Type.Object({
      featurePath: Type.Optional(Type.String({ description: "Feature path (looks up active workflow if omitted)" })),
      agentsDir: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String({ description: "Project root (defaults to cwd)" })),
    }),
    async execute(
      _toolCallId: string,
      params: { featurePath?: string; agentsDir?: string; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      try {
        const instruction = engine.step(projectRoot, {
          featurePath: params.featurePath,
        });

        if (!instruction) {
          return textResult("No active workflow found. Start one with flow_start first.");
        }

        const lines: string[] = [
          `**Step ${instruction.stepIndex + 1}: ${instruction.agent}**`,
          `Attempt: ${instruction.attempt}/${instruction.maxAttempts}`,
          `Approval required: ${instruction.requestApproval ? "yes" : "no"}`,
          `Tools: ${instruction.tools.join(", ")}`,
        ];

        if (instruction.subagents) {
          lines.push(`Subagents: ${Object.keys(instruction.subagents).join(", ")}`);
        }
        if (instruction.parallel) {
          lines.push(
            `Parallel: ${instruction.parallel.subagent} over ${instruction.parallel.over} (concurrency: ${instruction.parallel.concurrency ?? "default"})`
          );
        }
        if (instruction.expectedOutputs?.length) {
          lines.push(`Expected outputs: ${instruction.expectedOutputs.join(", ")}`);
        }
        if (instruction.lastFeedback) {
          lines.push(`Previous feedback: ${instruction.lastFeedback}`);
        }
        lines.push("", "---", "", "## Agent Prompt", "", instruction.prompt);

        if (instruction.subagentInstructions) {
          lines.push("", "## Subagent Prompts");
          for (const [name, subagent] of Object.entries(instruction.subagentInstructions)) {
            lines.push("", `### ${name} (${subagent.path})`, `Tools: ${subagent.tools.join(", ")}`, "", subagent.prompt);
          }
        }

        return textResult(lines.join("\n"), { agent: instruction.agent, stepIndex: instruction.stepIndex });
      } catch (err) {
        return errorResult(`Error loading step: ${(err as Error).message}`);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_step_update
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_step_update",
    label: "Update Step Status",
    description:
      "Record incremental status for the current running workflow step. Use this before major phases, child subagent fan-out, verification, and blockers.",
    promptSnippet: "Update the visible status for the current workflow step",
    parameters: Type.Object({
      phase: Type.Optional(Type.String({ description: "Short semantic phase, e.g. 'reading plan', 'fan out workers', 'running tests'." })),
      message: Type.Optional(Type.String({ description: "Human-readable status line to show in the workflow UI." })),
      status: Type.Optional(Type.String({ enum: ["working", "blocked", "needs_attention"] })),
      childRunIds: Type.Optional(Type.Array(Type.String({ description: "Subagent async run ids associated with this step." }))),
      currentTool: Type.Optional(Type.String({ description: "Current tool or command category, if useful." })),
      currentPath: Type.Optional(Type.String({ description: "Current path/file being inspected or changed." })),
      stepIndex: Type.Optional(Type.Integer({ minimum: 0 })),
      featurePath: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String()),
    }),
    async execute(
      _toolCallId: string,
      params: {
        phase?: string;
        message?: string;
        status?: "working" | "blocked" | "needs_attention";
        childRunIds?: string[];
        currentTool?: string;
        currentPath?: string;
        stepIndex?: number;
        featurePath?: string;
        projectRoot?: string;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();
      const outcome = engine.stepUpdate(
        {
          stepIndex: params.stepIndex,
          phase: params.phase,
          message: params.message,
          status: params.status,
          childRunIds: params.childRunIds,
          currentTool: params.currentTool,
          currentPath: params.currentPath,
        },
        projectRoot,
        params.featurePath
      );

      if (!outcome) {
        return textResult("No active workflow found.");
      }
      if (outcome.error) {
        return errorResult(`Step update blocked: ${outcome.error}`, { featurePath: outcome.featurePath });
      }

      // Enrich with subagent activity if available
      const childRuns = listCorrelatedSubagentRuns(outcome.state, 6);
      const statusLines = renderWorkflowStatus(outcome.state, {
        childRuns,
        loadingIcon: ">",
      });

      return textResult(statusLines.join("\n"), {
        featurePath: outcome.featurePath,
        stepIndex: outcome.state.current_step_index,
        childRuns: childRuns.map((r) => ({ id: r.id, agents: r.agents, state: r.state })),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_step_complete
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_step_complete",
    label: "Complete Step",
    description:
      "Submit the result of the current step (supervisor only). Accepts 'success' or 'error'. If success and the step requires approval, the flow pauses for a user gate. On error with retries remaining, the same step re-runs.",
    promptSnippet: "Submit step-result for an active workflow step (supervisor only)",
    parameters: Type.Object({
      result: Type.Union([Type.Literal("success"), Type.Literal("error")]),
      message: Type.String({ description: "Human-readable summary of the outcome" }),
      retryable: Type.Optional(Type.Boolean({ description: "For errors: whether retry makes sense" })),
      metadata: Type.Optional(
        Type.Object({
          service_dirs: Type.Optional(Type.Array(Type.String())),
        })
      ),
      featurePath: Type.Optional(Type.String()),
      agentsDir: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String()),
    }),
    async execute(
      _toolCallId: string,
      params: {
        result: "success" | "error";
        message: string;
        retryable?: boolean;
        metadata?: { service_dirs?: string[] };
        featurePath?: string;
        agentsDir?: string;
        projectRoot?: string;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      try {
        const outcome = engine.stepComplete(
          {
            result: params.result,
            message: params.message,
            retryable: params.retryable,
            metadata: params.metadata,
          },
          projectRoot,
          {
            featurePath: params.featurePath,
          }
        );

        if (!outcome) {
          return textResult("No active workflow found.");
        }

        const lines: string[] = [];
        lines.push(`Step result: **${params.result}**`);
        if (outcome.warnings?.length) {
          lines.push("", "Warnings:");
          for (const warning of outcome.warnings) {
            lines.push(`- ${warning}`);
          }
        }

        switch (outcome.action) {
          case "advance":
            lines.push("→ Advancing to next step.");
            break;
          case "retry":
            lines.push("↻ Retrying the same step.");
            break;
          case "gate": {
            lines.push(`⛔ **Approval required: ${outcome.gate!.header}**`);
            lines.push("");
            for (const opt of outcome.gate!.options) {
              const suffixes = [
                opt.advance ? "advances" : "",
                opt.feedback ? "requires feedback" : "",
                opt.abort ? "aborts" : "",
              ].filter(Boolean);
              lines.push(
                `  - **${opt.label}**${suffixes.length ? ` (${suffixes.join(", ")})` : ""}: ${opt.description}`
              );
            }
            break;
          }
          case "block":
            lines.push(`❌ Blocked: ${outcome.error || params.message}`);
            break;
          case "done":
            lines.push("🎉 Workflow complete!");
            break;
        }

        lines.push("", ...renderWorkflowStatus(outcome.state));

        return textResult(lines.join("\n"), {
          action: outcome.action,
          featurePath: outcome.featurePath,
        });
      } catch (err) {
        return errorResult(`Error completing step: ${(err as Error).message}`);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_record_gate
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_record_gate",
    label: "Record Gate Answer",
    description:
      "Answer an approval gate. If the chosen option has advance: true, the flow moves to the next step. Otherwise, the current step is reset for re-run. Options marked feedback: true require a non-empty feedback string.",
    promptSnippet: "Answer an approval gate in an active workflow",
    parameters: Type.Object({
      advance: Type.Boolean({ description: "Whether the chosen option means 'approved' (should match the agent's advance field)" }),
      chosenLabel: Type.Optional(Type.String({ description: "Label of the chosen option (for logging)" })),
      abort: Type.Optional(Type.Boolean({ description: "Whether this non-advance answer should abandon the workflow" })),
      feedback: Type.Optional(Type.String({ description: "Free-form feedback when the chosen option supports it" })),
      featurePath: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String()),
    }),
    async execute(
      _toolCallId: string,
      params: { advance: boolean; chosenLabel?: string; abort?: boolean; feedback?: string; featurePath?: string; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      try {
        const current = engine.status(projectRoot, params.featurePath);
        if (!current) {
          return textResult("No active workflow found.");
        }

        if (!current.gate) {
          return textResult("No active gate to answer.");
        }

        let actualAdvance = params.advance;
        let actualLabel = params.chosenLabel ?? "answered";
        let actualAbort = params.abort ?? false;
        let actualFeedback: string | undefined = params.feedback;

        if (!params.chosenLabel) {
          const matches = current.gate.options.filter(
            (opt) => opt.advance === actualAdvance && (opt.abort ?? false) === actualAbort
          );
          if (matches.length === 1) {
            actualLabel = matches[0].label;
          } else {
            return errorResult(
              "Multiple gate options match that answer. Pass `chosenLabel` with the exact option label."
            );
          }
        }

        const outcome = engine.recordGate(
          {
            stepIndex: current.gate.stepIndex,
            chosenLabel: actualLabel,
            advance: actualAdvance,
            abort: actualAbort,
            feedback: actualFeedback,
          },
          projectRoot,
          params.featurePath
        );

        if (!outcome) {
          return textResult("Failed to record gate answer.");
        }

        const lines: string[] = [];
        lines.push(`Gate answered: ${actualAdvance ? "✅ Approved" : "❌ Not approved"}`);

        if (outcome.action === "advance") {
          lines.push("→ Advancing to next step.");
        } else if (outcome.action === "retry") {
          lines.push("↻ Same step will re-run.");
          const feedback = outcome.state.steps[current.gate.stepIndex]?.last_feedback;
          if (feedback) {
            lines.push("", "Feedback:", feedback);
          }
        } else if (outcome.action === "done") {
          lines.push("🎉 Workflow complete!");
        } else if (outcome.action === "abort") {
          lines.push("🛑 Workflow aborted.");
        } else if (outcome.action === "block") {
          lines.push(`❌ Gate answer blocked: ${outcome.error ?? "invalid gate answer"}`);
        }

        lines.push("", ...renderWorkflowStatus(outcome.state));

        return textResult(lines.join("\n"), {
          action: outcome.action,
          featurePath: outcome.featurePath,
        });
      } catch (err) {
        return errorResult(`Error recording gate: ${(err as Error).message}`);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_status
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_status",
    label: "Flow Status",
    description:
      "Show the current status of a workflow: which step is active, what's completed, what's pending, and any approval gates.",
    promptSnippet: "Show the status of an active or completed workflow",
    parameters: Type.Object({
      featurePath: Type.Optional(Type.String({ description: "Feature path (defaults to active workflow)" })),
      projectRoot: Type.Optional(Type.String()),
    }),
    async execute(
      _toolCallId: string,
      params: { featurePath?: string; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();
      const current = engine.status(projectRoot, params.featurePath);

      if (!current) {
        return textResult(
          params.featurePath
            ? `No workflow found at ${params.featurePath}`
            : "No active workflow found. Start one with flow_start."
        );
      }

      // Enrich with subagent activity
      const childRuns = listCorrelatedSubagentRuns(current, 6);
      const statusLines = renderWorkflowStatus(current, {
        childRuns,
        loadingIcon: ">",
      });

      return textResult(statusLines.join("\n"), {
        status: current.status,
        featurePath: current.feature_path,
        childRuns: childRuns.map((r) => ({ id: r.id, agents: r.agents, state: r.state })),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_list
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_list",
    label: "List Flows",
    description: "List all workflow runs in the project's .temp/ directory.",
    promptSnippet: "List active workflow runs",
    parameters: Type.Object({
      projectRoot: Type.Optional(Type.String()),
    }),
    async execute(
      _toolCallId: string,
      params: { projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();
      const runs = engine.list(projectRoot);
      const lines: string[] = ["## Workflow Runs"];

      if (runs.length === 0) {
        lines.push("No workflow runs found.");
      } else {
        for (const fp of runs) {
          const current = engine.status(projectRoot, fp);
          const icon = current?.status === "done" ? "✅" : current?.status === "blocked" ? "❌" : "◦";
          lines.push(`- ${icon} ${fp} — ${current?.flow_id ?? "?"} [${current?.status ?? "?"}]`);
        }
      }

      return textResult(lines.join("\n"), { runs });
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_continue
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_continue",
    label: "Continue Flow",
    description:
      "Detect the active workflow's state and perform the obvious next action automatically. If the workflow is in_progress, loads the current step instructions (same as flow_step). If awaiting a gate, returns the gate details formatted for presentation. If done or blocked, returns the final status. This is the preferred tool for resuming or continuing a workflow.",
    promptSnippet:
      "Continue the active workflow automatically — step if runnable, present gate if awaiting approval, or report final status",
    parameters: Type.Object({
      featurePath: Type.Optional(Type.String({ description: "Feature path (looks up active workflow if omitted)" })),
      agentsDir: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String({ description: "Project root (defaults to cwd)" })),
    }),
    async execute(
      _toolCallId: string,
      params: { featurePath?: string; agentsDir?: string; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      const current = engine.status(projectRoot, params.featurePath);
      if (!current) {
        return textResult("No active workflow found. Start one with flow_start first.");
      }

      if (current.status === "awaiting_user" && current.gate) {
        const lines: string[] = [
          `Workflow "${current.feature}" is awaiting user approval.`,
          "",
          `⛔ **Approval required: ${current.gate.header}**`,
          "",
          "Gate options:",
        ];
        for (const opt of current.gate.options) {
          const suffixes = [
            opt.advance ? "advances" : "",
            opt.feedback ? "requires feedback" : "",
            opt.abort ? "aborts" : "",
          ].filter(Boolean);
          lines.push(
            `  - **${opt.label}**${suffixes.length ? ` (${suffixes.join(", ")})` : ""}: ${opt.description}`
          );
        }
        lines.push(
          "",
          "**Present these options to the user with `ask_user_question`.** After the user answers, call `flow_record_gate` with their choice. If they approve, immediately call `flow_step` again."
        );
        lines.push("", ...renderWorkflowStatus(current));

        return textResult(lines.join("\n"), { action: "gate", featurePath: current.feature_path });
      }

      if (current.status !== "in_progress") {
        const statusLines = renderWorkflowStatus(current);
        return textResult(
          [`Workflow "${current.feature}" is ${current.status}.`, "", ...statusLines].join("\n"),
          { status: current.status, featurePath: current.feature_path }
        );
      }

      // In progress — delegate to flow_step
      const instruction = engine.step(projectRoot, {
        featurePath: current.feature_path,
      });
      if (!instruction) {
        return textResult(
          "Workflow is in_progress but no step instructions are available. This may be a terminal step.",
          { featurePath: current.feature_path }
        );
      }

      const lines: string[] = [
        `Continuing workflow "${current.feature}".`,
        "",
        `**Step ${instruction.stepIndex + 1}: ${instruction.agent}**`,
        `Attempt: ${instruction.attempt}/${instruction.maxAttempts}`,
        `Approval required: ${instruction.requestApproval ? "yes" : "no"}`,
        `Tools: ${instruction.tools.join(", ")}`,
      ];

      if (instruction.subagents) {
        lines.push(`Subagents: ${Object.keys(instruction.subagents).join(", ")}`);
      }
      if (instruction.parallel) {
        lines.push(
          `Parallel: ${instruction.parallel.subagent} over ${instruction.parallel.over} (concurrency: ${instruction.parallel.concurrency ?? "default"})`
        );
      }
      if (instruction.expectedOutputs?.length) {
        lines.push(`Expected outputs: ${instruction.expectedOutputs.join(", ")}`);
      }
      if (instruction.lastFeedback) {
        lines.push(`Previous feedback: ${instruction.lastFeedback}`);
      }
      lines.push("", "---", "", "## Agent Prompt", "", instruction.prompt);

      if (instruction.subagentInstructions) {
        lines.push("", "## Subagent Prompts");
        for (const [name, subagent] of Object.entries(instruction.subagentInstructions)) {
          lines.push("", `### ${name} (${subagent.path})`, `Tools: ${subagent.tools.join(", ")}`, "", subagent.prompt);
        }
      }

      return textResult(lines.join("\n"), {
        action: "advance",
        agent: instruction.agent,
        stepIndex: instruction.stepIndex,
        featurePath: current.feature_path,
      });
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_abort
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_abort",
    label: "Abort Flow",
    description: "Mark a workflow as abandoned. Does not delete any files.",
    parameters: Type.Object({
      featurePath: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String()),
    }),
    async execute(
      _toolCallId: string,
      params: { featurePath?: string; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();
      const result = engine.abort(projectRoot, params.featurePath);

      if (!result) {
        return textResult("No active workflow to abort.");
      }

      return textResult(`Workflow "${result.feature}" (${result.feature_path}) marked as abandoned.`, {
        featurePath: result.feature_path,
      });
    },
  });
}

/**
 * Project Builder UI — Tool Registration
 *
 * All flow_* tools moved from project-builder/src/extension/index.ts.
 * Now receives agentsDir from the engine context.
 *
 * Each tool has renderCall/renderResult for TUI display, following the
 * minimal-mode pattern:
 *   - renderCall: concise one-line command summary
 *   - renderResult (collapsed): minimal output (spinner or short status)
 *   - renderResult (expanded): full workflow status details
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  Component,
  Theme,
} from "@earendil-works/pi-coding-agent";

import type { FlowDefinition } from "../shared/types.ts";
import type { WorkflowState } from "../shared/types.ts";
import {
  renderWorkflowStatus,
} from "../engine/workflow-renderer.ts";
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

/** Whether the workflow is actively running (a step is being executed). */
function isRunningWorkflow(state: WorkflowState): boolean {
  return state.status === "in_progress";
}

// ============================================================================
// Shared render helpers
// ============================================================================

/** Render a flow tool call line: tool name + key args */
function renderFlowCall(
  name: string,
  theme: Theme,
  extraInfo?: string
): Component {
  let text = `${theme.fg("toolTitle", theme.bold(name))}`;
  if (extraInfo) {
    text += ` ${theme.fg("accent", extraInfo)}`;
  }
  return new Text(text, 0, 0);
}

function truncate(value: string, max = 60): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function registerTools(
  pi: ExtensionAPI,
  engine: EngineContext,
  onStateChange?: (sessionId: string) => void,
  registerWidget?: (ctx: ExtensionContext) => void
): void {
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
        strictOutputs: Type.Optional(Type.Boolean({ description: "If true, stepComplete blocks when declared output files are missing (default: false)" })),
        steps: Type.Array(
          Type.Object({
            id: Type.Optional(Type.String({ description: "Optional step identifier (defaults to agent name)" })),
            agent: Type.String(),
            requestApproval: Type.Optional(Type.Boolean()),
            attempts: Type.Optional(Type.Number()),
            model: Type.Optional(Type.String({ description: "Optional model override for this step (e.g. 'google/gemini-2.5-pro')" })),
          })
        ),
      }),
      featureName: Type.String({ description: "Human-readable name for what's being built (e.g. 'user-auth')" }),
      featureContext: Type.Optional(Type.String({ description: "Open-text user description of what they want to build (injected into agent prompts)" })),
      agentsDir: Type.Optional(Type.String({ description: "Path to agents/ directory (defaults to {projectRoot}/agents)" })),
      serviceDirs: Type.Optional(Type.Array(Type.String({ description: "Service directories touched by the flow" }))),
      projectRoot: Type.Optional(Type.String({ description: "Project root directory (defaults to cwd)" })),
    }),
    renderCall(args, theme) {
      return renderFlowCall(
        "flow_start",
        theme,
        args.featureName
      );
    },

    renderResult(result, options, theme) {
      if (options.expanded) {
        const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
        return new Text(`\n${textContent}`, 0, 0);
      }
      // Collapsed: show status
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
      const firstLine = textContent.split("\n")[0] ?? "";
      return new Text(theme.fg("muted", truncate(firstLine, 60)), 0, 0);
    },

    async execute(
      _toolCallId: string,
      params: {
        flowDefinition: FlowDefinition;
        featureName: string;
        featureContext?: string;
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
          featureContext: params.featureContext,
        });

        // Return a concise summary
        const state = result.state;
        const stepInfo = state.steps.map(
          (s, i) => `${i === state.current_step_index ? ">" : " "} Step ${i + 1}: ${s.agent} [${s.status}]`
        ).join("\n");
        // Notify the widget (if registered) to refresh
        onStateChange?.(_ctx.sessionManager.getSessionId());
        // Register the widget for this session on first workflow start
        registerWidget?.(_ctx);

        return textResult(
          `✅ Workflow "${state.feature}" started.\n\n${stepInfo}`,
          { featurePath: result.featurePath }
        );
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
      "Get the current step's instructions. Marks the step as 'running'. Returns step details (agent, prompt, tools, subagents) in both text and metadata.",
    promptSnippet: "Get instructions for the current step in an active workflow — read full step data from details metadata",
    parameters: Type.Object({
      featurePath: Type.Optional(Type.String({ description: "Feature path (looks up active workflow if omitted)" })),
      agentsDir: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String({ description: "Project root (defaults to cwd)" })),
    }),
    renderCall(args, theme) {
      return renderFlowCall(
        "flow_step",
        theme,
        args.featurePath
      );
    },

    renderResult(result, options, theme) {
      // Show spinner when in_progress, full status otherwise
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";

      if (options.expanded) {
        // Expanded: show full details from result
        return new Text(`\n${textContent}`, 0, 0);
      }

      return new Text(theme.fg("muted", truncate(textContent, 60)), 0, 0);
    },

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

        // Notify the widget that a new step has started
        onStateChange?.(_ctx.sessionManager.getSessionId());

        return textResult(
          `Step ${instruction.stepIndex + 1} (${instruction.agent}) loaded. ` +
          `Attempt ${instruction.attempt}/${instruction.maxAttempts}.`,
          {
            agent: instruction.agent,
            stepIndex: instruction.stepIndex,
            attempt: instruction.attempt,
            maxAttempts: instruction.maxAttempts,
            tools: instruction.tools,
            subagents: instruction.subagents ?? {},
            parallel: instruction.parallel,
            expectedOutputs: instruction.expectedOutputs,
            lastFeedback: instruction.lastFeedback,
            lastError: instruction.lastError,
            requestApproval: instruction.requestApproval,
            approvalManifest: instruction.approvalManifest,
            prompt: instruction.prompt,
            subagentInstructions: instruction.subagentInstructions,
          }
        );
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
    renderCall(args, theme) {
      const info = args.phase ?? args.message ?? "";
      return renderFlowCall(
        "flow_update",
        theme,
        truncate(info, 40)
      );
    },

    renderResult(result, options, theme) {
      if (options.expanded) {
        const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
        return new Text(`\n${textContent}`, 0, 0);
      }
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
      
      return new Text(theme.fg("muted", truncate(textContent, 60)), 0, 0);
    },

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

      // Notify the widget to refresh with updated step activity
      onStateChange?.(_ctx.sessionManager.getSessionId());

      if (isRunningWorkflow(outcome.state)) {
        const status = outcome.state.steps[outcome.state.current_step_index];
        return textResult(
          `Step ${outcome.state.current_step_index + 1} (${status?.agent ?? "?"}) updated`,
          {
            featurePath: outcome.featurePath,
            stepIndex: outcome.state.current_step_index,
            childRuns: childRuns.map((r) => ({ id: r.id, agents: r.agents, state: r.state })),
          }
        );
      }

      // Fallback for non-running states (shouldn't normally happen for updates)
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
      "Submit the result of the current step (supervisor only). Accepts 'success' or 'error'. If success and the step requires approval, the flow pauses for a user gate (full gate details shown). On error with retries remaining, the same step re-runs.",
    promptSnippet: "Submit step-result for an active workflow step — gate details shown when approval required",
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
    renderCall(args, theme) {
      return renderFlowCall(
        "flow_complete",
        theme,
        args.result ? `${args.result}: ${truncate(args.message, 30)}` : undefined
      );
    },

    renderResult(result, options, theme) {
      if (options.expanded) {
        const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
        return new Text(`\n${textContent}`, 0, 0);
      }
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
      
      return new Text(theme.fg("muted", truncate(textContent, 60)), 0, 0);
    },

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

        // Notify the widget to refresh after step completion
        onStateChange?.(_ctx.sessionManager.getSessionId());

        // Helper to append warnings if present
        function withWarnings(lines: string[], warnings: string[] | undefined): string[] {
          if (warnings?.length) {
            lines.push("", "⚠️ Warnings:");
            for (const warning of warnings) {
              lines.push(`- ${warning}`);
            }
          }
          return lines;
        }

        // Handle gate — always show full content so the user can answer
        if (outcome.action === "gate") {
          const lines: string[] = [
            `Step result: **${params.result}**`,
            "",
            `⛔ **Approval required: ${outcome.gate!.header}**`,
            "",
            "**IMPORTANT: Use `ask_user_question` to present the gate to the user. " +
            "Call `flow_continue` with the feature path to see the full gate options. " +
            "Do NOT auto-answer the gate by calling `flow_record_gate` directly " +
            "without asking the user first.**",
          ];
          withWarnings(lines, outcome.warnings);
          return textResult(lines.join("\n"), {
            action: outcome.action,
            featurePath: outcome.featurePath,
            gate: { header: outcome.gate!.header, stepIndex: outcome.gate!.stepIndex },
            warnings: outcome.warnings,
          });
        }

        // Handle done / block — show full status
        if (outcome.action === "done" || outcome.action === "block") {
          const lines: string[] = [];
          lines.push(`Step result: **${params.result}**`);
          if (outcome.warnings?.length) {
            lines.push("", "Warnings:");
            for (const warning of outcome.warnings) {
              lines.push(`- ${warning}`);
            }
          }
          if (outcome.action === "done") {
            lines.push("🎉 Workflow complete!");
          } else {
            lines.push(`❌ Blocked: ${outcome.error || params.message}`);
          }
          lines.push("", ...renderWorkflowStatus(outcome.state));
          return textResult(lines.join("\n"), {
            action: outcome.action,
            featurePath: outcome.featurePath,
          });
        }

        // Handle advance / retry
        const actionLabel = outcome.action === "retry" ? "retrying" : "advanced";
        const advanceLines: string[] = [
          `Step ${outcome.state.current_step_index + 1} ` +
          `(${outcome.state.steps[outcome.state.current_step_index]?.agent ?? "?"}) ${actionLabel}: ${outcome.action}`,
        ];
        withWarnings(advanceLines, outcome.warnings);
        return textResult(advanceLines.join("\n"), {
          action: outcome.action,
          featurePath: outcome.featurePath,
          warnings: outcome.warnings,
          stepResult: params.result,
          stepMessage: params.message,
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
      "Record the user's answer to an approval gate. If the chosen option has advance: true, the flow moves to the next step. Otherwise, the current step is reset for re-run. Options marked feedback: true require a non-empty feedback string.\n\n" +
      "CRITICAL: Only call this tool AFTER the user has given their explicit answer via ask_user_question. " +
      "Never auto-answer a gate without user confirmation.",
    promptSnippet: "Answer an approval gate in an active workflow",
    parameters: Type.Object({
      advance: Type.Boolean({ description: "Whether the chosen option means 'approved' (should match the agent's advance field)" }),
      chosenLabel: Type.Optional(Type.String({ description: "Label of the chosen option (for logging)" })),
      abort: Type.Optional(Type.Boolean({ description: "Whether this non-advance answer should abandon the workflow" })),
      feedback: Type.Optional(Type.String({ description: "Free-form feedback when the chosen option supports it" })),
      featurePath: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String()),
    }),
    renderCall(args, theme) {
      return renderFlowCall(
        "flow_gate",
        theme,
        args.chosenLabel ? `${args.advance ? "✅" : "❌"} ${args.chosenLabel}` : undefined
      );
    },

    renderResult(result, options, theme) {
      if (options.expanded) {
        const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
        return new Text(`\n${textContent}`, 0, 0);
      }
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
      
      return new Text(theme.fg("muted", truncate(textContent, 60)), 0, 0);
    },

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

        // Notify the widget to refresh after gate answer
        onStateChange?.(_ctx.sessionManager.getSessionId());

        // Show status for in_progress (advance or retry)
        if (isRunningWorkflow(outcome.state)) {
          const status = outcome.state.steps[outcome.state.current_step_index];
          return textResult(
            `Gate "${actualLabel}" recorded — step ${outcome.state.current_step_index + 1} ` +
            `(${status?.agent ?? "?"}) continues`,
            {
              action: outcome.action,
              featurePath: outcome.featurePath,
              advance: actualAdvance,
              chosenLabel: actualLabel,
            }
          );
        }

        // Otherwise show full status (done, abort, block)
        const lines: string[] = [];
        lines.push(`Gate answered: ${actualAdvance ? "✅ Approved" : "❌ Not approved"}`);

        if (outcome.action === "done") {
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
    renderCall(args, theme) {
      return renderFlowCall(
        "flow_status",
        theme,
        args.featurePath
      );
    },

    renderResult(result, options, theme) {
      if (options.expanded) {
        const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
        return new Text(`\n${textContent}`, 0, 0);
      }
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
      
      return new Text(theme.fg("muted", truncate(textContent, 60)), 0, 0);
    },

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

      // When running, show current status
      if (isRunningWorkflow(current)) {
        const childRuns = listCorrelatedSubagentRuns(current, 6);
        const status = current.steps[current.current_step_index];
        return textResult(
          `Workflow "${current.feature}" in progress — step ${current.current_step_index + 1} (${status?.agent ?? "?"})`,
          {
            status: current.status,
            featurePath: current.feature_path,
            childRuns: childRuns.map((r) => ({ id: r.id, agents: r.agents, state: r.state })),
          }
        );
      }

      // Otherwise show full status (awaiting_user, done, blocked, abandoned)
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
    renderCall(args, theme) {
      return renderFlowCall("flow_list", theme);
    },

    renderResult(result, options, theme) {
      if (options.expanded) {
        const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
        return new Text(`\n${textContent}`, 0, 0);
      }
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
      return new Text(theme.fg("muted", truncate(textContent, 60)), 0, 0);
    },

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
      "Detect the active workflow's state and perform the obvious next action automatically. If the workflow is in_progress, loads the current step instructions (same as flow_step). If awaiting a gate, returns the gate details formatted for presentation. If done or blocked, returns the final status.",
    promptSnippet:
      "Continue the active workflow automatically — step if runnable, present gate if awaiting approval, or report final status",
    parameters: Type.Object({
      featurePath: Type.Optional(Type.String({ description: "Feature path (looks up active workflow if omitted)" })),
      agentsDir: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String({ description: "Project root (defaults to cwd)" })),
    }),
    renderCall(args, theme) {
      return renderFlowCall(
        "flow_continue",
        theme,
        args.featurePath
      );
    },

    renderResult(result, options, theme) {
      if (options.expanded) {
        const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
        return new Text(`\n${textContent}`, 0, 0);
      }
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
      
      return new Text(theme.fg("muted", truncate(textContent, 60)), 0, 0);
    },

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
          "**CRITICAL — You MUST present these options to the user with `ask_user_question`.** " +
          "Do NOT call `flow_record_gate` directly without the user's explicit answer. " +
          "Only after the user responds, call `flow_record_gate` with their choice. " +
          "If they approve, immediately call `flow_step` again."
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

      // In progress — load step instructions
      const instruction = engine.step(projectRoot, {
        featurePath: current.feature_path,
      });
      if (!instruction) {
        return textResult(
          "Workflow is in_progress but no step instructions are available. This may be a terminal step.",
          { featurePath: current.feature_path }
        );
      }

      return textResult(
        `Step ${instruction.stepIndex + 1} (${instruction.agent}) loaded — ` +
        `attempt ${instruction.attempt}/${instruction.maxAttempts}`,
        {
          action: "advance",
          agent: instruction.agent,
          stepIndex: instruction.stepIndex,
          attempt: instruction.attempt,
          maxAttempts: instruction.maxAttempts,
          tools: instruction.tools,
          subagents: instruction.subagents ?? {},
          parallel: instruction.parallel,
          expectedOutputs: instruction.expectedOutputs,
          lastFeedback: instruction.lastFeedback,
          lastError: instruction.lastError,
          requestApproval: instruction.requestApproval,
          approvalManifest: instruction.approvalManifest,
          prompt: instruction.prompt,
          subagentInstructions: instruction.subagentInstructions,
          featurePath: current.feature_path,
        }
      );
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
    renderCall(args, theme) {
      return renderFlowCall(
        "flow_abort",
        theme,
        args.featurePath
      );
    },

    renderResult(result, options, theme) {
      if (options.expanded) {
        const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
        return new Text(`\n${textContent}`, 0, 0);
      }
      const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
      return new Text(theme.fg("muted", truncate(textContent, 60)), 0, 0);
    },

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

      // Notify the widget to clear the step summary
      onStateChange?.(_ctx.sessionManager.getSessionId());

      return textResult(`Workflow "${result.feature}" (${result.feature_path}) marked as abandoned.`, {
        featurePath: result.feature_path,
      });
    },
  });
}

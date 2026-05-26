/**
 * Project Builder — Pi Extension Entry Point
 *
 * Registers flow engine tools as Pi tools callable by the LLM,
 * plus slash commands for interactive use.
 *
 * The extension is a thin wrapper around the orchestrator engine.
 * All domain logic lives in flows/*.ts and agents/*.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import { initEngine, validateFlows, start, step, stepComplete, recordGate, status, abort, list } from "../orchestrator/engine.ts";
import { allFlows } from "../../flows/index.ts";

// ---------------------------------------------------------------------------
// Flow registry
// ---------------------------------------------------------------------------

interface FlowRegistryEntry {
  definition: import("../shared/types.ts").FlowDefinition;
}

let flowRegistry: Map<string, FlowRegistryEntry> = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProjectRoot(): string {
  return process.cwd();
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LOADING_ICON = SPINNER[0]!;
const LOADING_LABEL = "Working...";
const LOADING_ANIMATION_MS = 80;
const WORKFLOW_WIDGET_KEY = "project-builder.workflow";

interface ResultAnimationContext {
  state: { projectBuilderResultAnimationTimer?: ReturnType<typeof setInterval> };
  invalidate: () => void;
}

function spinnerFrame(): string {
  return SPINNER[Math.floor(Date.now() / LOADING_ANIMATION_MS) % SPINNER.length]!;
}

function textContent(result: AgentToolResult): string {
  return result.content
    .map((part) => part.type === "text" ? part.text : "")
    .join("\n");
}

function resultHasLoadingState(result: AgentToolResult): boolean {
  return textContent(result).includes(`[${LOADING_LABEL}]`);
}

function stopResultAnimation(context: ResultAnimationContext): void {
  const timer = context.state.projectBuilderResultAnimationTimer;
  if (!timer) return;
  clearInterval(timer);
  context.state.projectBuilderResultAnimationTimer = undefined;
}

function syncResultAnimation(result: AgentToolResult, context: ResultAnimationContext): void {
  if (!resultHasLoadingState(result)) {
    stopResultAnimation(context);
    return;
  }
  if (context.state.projectBuilderResultAnimationTimer) return;
  const timer = setInterval(() => context.invalidate(), LOADING_ANIMATION_MS);
  timer.unref?.();
  context.state.projectBuilderResultAnimationTimer = timer;
}

function renderFlowResult(result: AgentToolResult, context: ResultAnimationContext): Text {
  syncResultAnimation(result, context);
  const component = new Text("", 0, 0);
  component.render = (width: number) => {
    const text = textContent(result).replaceAll(LOADING_ICON, spinnerFrame());
    return new Text(text, 0, 0).render(width);
  };
  return component;
}

function renderProjectBuilderToolResult(
  result: AgentToolResult,
  _options: unknown,
  _theme: ExtensionContext["ui"]["theme"],
  context: ResultAnimationContext
): Text {
  return renderFlowResult(result, context);
}

function workflowHasRunningStep(state: import("../shared/types.ts").WorkflowState | null | undefined): boolean {
  return state?.steps.some((step) => step.status === "running") ?? false;
}

function currentRunningStep(state: import("../shared/types.ts").WorkflowState): import("../shared/types.ts").WorkflowStep | undefined {
  return state.steps.find((step) => step.index === state.current_step_index && step.status === "running");
}

function fitWidgetLine(line: string, width: number): string {
  const maxWidth = Math.max(1, width);
  return visibleWidth(line) > maxWidth ? truncateToWidth(line, maxWidth) : line;
}

function buildResumePrompt(projectRoot: string, state: import("../shared/types.ts").WorkflowState): string {
  const running = currentRunningStep(state);
  const stepLabel = running
    ? `Step ${running.index + 1}: ${running.agent}`
    : `current step ${state.current_step_index + 1}`;

  return [
    `Resume the active project-builder workflow "${state.feature}" at ${state.feature_path}.`,
    "",
    `The previous Pi session was interrupted while ${stepLabel} was marked running.`,
    "Call `flow_step` with this exact workflow path to retrieve the current step instructions again, then execute that step.",
    "When the step is complete, call `flow_step_complete` with the result so the workflow can advance.",
    "",
    "Use these tool arguments:",
    `- projectRoot: ${projectRoot}`,
    `- featurePath: ${state.feature_path}`,
  ].join("\n");
}

function buildWorkflowWidget(projectRoot: string, featurePath?: string): (tui: TUI, theme: ExtensionContext["ui"]["theme"]) => Component & { dispose?(): void } {
  return (tui, theme) => {
    const component = new Container() as Component & { dispose?(): void };
    const timer = setInterval(() => tui.requestRender(), LOADING_ANIMATION_MS);
    timer.unref?.();
    component.dispose = () => clearInterval(timer);
    component.render = (width: number) => {
      const current = status(projectRoot, featurePath);
      if (!current || !workflowHasRunningStep(current)) return [];
      return renderWorkflowStatus(current)
        .join("\n")
        .replaceAll(LOADING_ICON, theme.fg("accent", spinnerFrame()))
        .split("\n")
        .map((line) => fitWidgetLine(line, width));
    };
    return component;
  };
}

function syncWorkflowWidget(ctx: ExtensionContext | undefined, projectRoot: string, featurePath?: string): void {
  if (!ctx?.hasUI) return;
  const current = status(projectRoot, featurePath);
  if (!workflowHasRunningStep(current)) {
    ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
    return;
  }
  ctx.ui.setWorkingMessage(LOADING_LABEL);
  ctx.ui.setWorkingIndicator({ frames: SPINNER, intervalMs: LOADING_ANIMATION_MS });
  ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, buildWorkflowWidget(projectRoot, current?.feature_path ?? featurePath));
}

function renderStaticWorkflowStatus(state: import("../shared/types.ts").WorkflowState): string[] {
  return renderWorkflowStatus(state).map((line) => line.replaceAll(LOADING_ICON, "•"));
}

function formatStepStatus(icon: string, label: string, detail?: string): string {
  const line = detail ? `${icon} ${label} — ${detail}` : `${icon} ${label}`;
  return line;
}

function renderWorkflowStatus(state: import("../shared/types.ts").WorkflowState): string[] {
  const lines: string[] = [];
  lines.push(`Flow: ${state.flow_id} v${state.flow_version} — ${state.feature}`);
  lines.push(`Status: ${state.status}${state.build_status ? ` (${state.build_status})` : ""}`);
  lines.push(`Path: ${state.feature_path}`);
  lines.push("");

  for (const step of state.steps) {
    const isCurrent = step.index === state.current_step_index;
    const marker = isCurrent ? "→" : " ";
    let icon: string;
    switch (step.status) {
      case "completed":
        icon = "✅";
        break;
      case "failed":
        icon = "❌";
        break;
      case "running":
        icon = LOADING_ICON;
        break;
      default:
        icon = "⏳";
    }
    const resultText = step.result
      ? ` — ${step.result.result}: ${step.result.message.slice(0, 60)}`
      : "";
    const attemptText = step.attempt > 1 ? ` (attempt ${step.attempt})` : "";
    const statusText = step.status === "running" ? LOADING_LABEL : step.status;
    lines.push(`${marker} ${icon} Step ${step.index + 1}: ${step.agent} [${statusText}]${attemptText}${resultText}`);
  }

  if (state.gate) {
    lines.push("");
    lines.push(`⛔ Awaiting approval: ${state.gate.header}`);
    lines.push(`   Options: ${state.gate.options.map((o) => o.label).join(", ")}`);
  }

  return lines;
}

function renderSubagentInstructions(
  instruction: import("../shared/types.ts").StepInstruction
): string[] {
  if (!instruction.subagentInstructions) return [];

  const lines: string[] = ["", "## Subagent Prompts"];
  for (const [name, subagent] of Object.entries(instruction.subagentInstructions)) {
    lines.push("");
    lines.push(`### ${name} (${subagent.path})`);
    lines.push(`Tools: ${subagent.tools.join(", ")}`);
    lines.push("");
    lines.push(subagent.prompt);
  }
  return lines;
}

function renderGatePreview(
  projectRoot: string,
  featurePath: string,
  gate: import("../shared/types.ts").WorkflowGate
): string[] {
  if (!gate.preview) return [];

  const previewPath = path.join(projectRoot, ".temp", featurePath, gate.preview);
  if (!fs.existsSync(previewPath)) {
    return [`Preview configured but missing: ${gate.preview}`];
  }

  const preview = fs
    .readFileSync(previewPath, "utf-8")
    .split("\n")
    .slice(0, 80)
    .join("\n");

  return [`Preview: ${gate.preview}`, "", preview];
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // --- Resolve extension directory ---
  // The extension file is at src/extension/index.ts
  // The agents/ directory is at ../../agents/ relative to this file
  const extensionDir = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
  const agentsDir = path.join(extensionDir, "agents");

  initEngine(agentsDir);

  // --- Load flow registry ---
  loadFlowRegistry();
  validateFlows([...flowRegistry.values()].map((entry) => entry.definition));

  // ---------------------------------------------------------------------------
  // Tool: flow_start
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_start",
    label: "Start Flow",
    description:
      "Start a new workflow run. Creates a frozen workflow snapshot in .temp/{featurePath}/workflow.json. The flow definition (steps, agents, approval gates) is frozen at start time.",
    promptSnippet:
      "Start a new workflow using a registered flow definition",
    parameters: Type.Object({
      flowId: Type.String({ description: "Flow definition ID (e.g. 'feature-build')" }),
      featureName: Type.String({ description: "Human-readable name for what's being built (e.g. 'user-auth')" }),
      serviceDirs: Type.Optional(Type.Array(Type.String({ description: "Service directories touched by the flow" }))),
      projectRoot: Type.Optional(Type.String({ description: "Project root directory (defaults to current working directory)" })),
    }),
    renderResult: renderProjectBuilderToolResult,
    async execute(
      _toolCallId: string,
      params: { flowId: string; featureName: string; serviceDirs?: string[]; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();
      const entry = flowRegistry.get(params.flowId);
      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown flow "${params.flowId}". Available: ${[...flowRegistry.keys()].join(", ")}`,
            },
          ],
          details: {},
        };
      }

      try {
        const result = start(entry.definition, params.featureName, projectRoot, params.serviceDirs);
        syncWorkflowWidget(ctx, projectRoot, result.featurePath);
        const lines = renderWorkflowStatus(result.state);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { featurePath: result.featurePath },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error starting flow: ${(err as Error).message}`,
            },
          ],
          details: { isError: true },
        };
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
    promptSnippet:
      "Get instructions for the current step in an active workflow",
    parameters: Type.Object({
      featurePath: Type.Optional(Type.String({ description: "Feature path (looks up active workflow if omitted)" })),
      projectRoot: Type.Optional(Type.String({ description: "Project root (defaults to cwd)" })),
    }),
    async execute(
      _toolCallId: string,
      params: { featurePath?: string; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      try {
        const instruction = step(projectRoot, params.featurePath);
        syncWorkflowWidget(ctx, projectRoot, params.featurePath);
        if (!instruction) {
          return {
            content: [
              {
                type: "text",
                text: "No active workflow found. Start one with flow_start first.",
              },
            ],
            details: {},
          };
        }

        const text = [
          `**Step ${instruction.stepIndex + 1}: ${instruction.agent}**`,
          `Attempt: ${instruction.attempt}/${instruction.maxAttempts}`,
          `Approval required: ${instruction.requestApproval ? "yes" : "no"}`,
          `Tools: ${instruction.tools.join(", ")}`,
          instruction.subagents
            ? `Subagents: ${Object.keys(instruction.subagents).join(", ")}`
            : "",
          instruction.parallel
            ? `Parallel: ${instruction.parallel.subagent} over ${instruction.parallel.over} (concurrency: ${instruction.parallel.concurrency ?? "default"})`
            : "",
          instruction.expectedOutputs?.length
            ? `Expected outputs: ${instruction.expectedOutputs.join(", ")}`
            : "",
          "",
          "---",
          "",
          "## Agent Prompt",
          "",
          instruction.prompt,
          ...renderSubagentInstructions(instruction),
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [{ type: "text", text }],
          details: { agent: instruction.agent, stepIndex: instruction.stepIndex },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error loading step: ${(err as Error).message}`,
            },
          ],
          details: { isError: true },
        };
      }
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
    promptSnippet:
      "Submit step-result for an active workflow step (supervisor only)",
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
      projectRoot: Type.Optional(Type.String()),
    }),
    renderResult: renderProjectBuilderToolResult,
    async execute(
      _toolCallId: string,
      params: {
        result: "success" | "error";
        message: string;
        retryable?: boolean;
        metadata?: { service_dirs?: string[] };
        featurePath?: string;
        projectRoot?: string;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      try {
        const outcome = stepComplete(
          {
            result: params.result,
            message: params.message,
            retryable: params.retryable,
            metadata: params.metadata,
          },
          projectRoot,
          params.featurePath
        );

        if (!outcome) {
          return {
            content: [{ type: "text", text: "No active workflow found." }],
            details: {},
          };
        }
        syncWorkflowWidget(ctx, projectRoot, outcome.featurePath);

        const lines: string[] = [];
        lines.push(`Step result: **${params.result}**`);
        if (outcome.warnings?.length) {
          lines.push("");
          lines.push("Warnings:");
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
            // Present the approval gate directly to the user via UI selector.
            // This prevents the AI from auto-approving gates without user input.
            if (ctx.hasUI && outcome.gate) {
              const previewLines = renderGatePreview(projectRoot, outcome.featurePath, outcome.gate);
              if (previewLines.length > 0) {
                lines.push("");
                lines.push(...previewLines);
                lines.push("");
              }
              const gateOptions = outcome.gate.options.map((o) => o.label);
              const chosenLabel = await ctx.ui.select(
                `Approve: ${outcome.gate.header}`,
                gateOptions
              );

              const chosenOption = chosenLabel
                ? outcome.gate.options.find((o) => o.label === chosenLabel)
                : undefined;

              const gateResult = recordGate(
                {
                  stepIndex: outcome.gate.stepIndex,
                  chosenLabel: chosenLabel ?? "cancelled",
                  advance: chosenOption?.advance ?? false,
                  abort: chosenOption?.abort ?? false,
                },
                projectRoot,
                params.featurePath
              );

              if (gateResult) {
                syncWorkflowWidget(ctx, projectRoot, gateResult.featurePath);
                if (gateResult.action === "advance") {
                  lines.push("→ Approved — advancing to next step.");
                } else if (gateResult.action === "retry") {
                  lines.push("↻ Changes requested — step will re-run.");
                } else if (gateResult.action === "done") {
                  lines.push("🎉 Workflow complete!");
                } else if (gateResult.action === "abort") {
                  lines.push("🛑 Workflow aborted.");
                } else {
                  lines.push("❌ Failed to record gate answer.");
                }
                lines.push("");
                lines.push(...renderWorkflowStatus(gateResult.state));
              } else {
                lines.push("❌ Failed to record gate answer.");
              }

              return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: {
                  action: gateResult?.action ?? "block",
                  featurePath: gateResult?.featurePath ?? outcome.featurePath,
                },
              };
            }

            // No UI available — fall back to text-based gate (non-interactive mode)
            lines.push(`⛔ **Approval required: ${outcome.gate!.header}**`);
            lines.push(...renderGatePreview(projectRoot, outcome.featurePath, outcome.gate!));
            lines.push("");
            for (const opt of outcome.gate!.options) {
              lines.push(
                `  - **${opt.label}**${opt.advance ? " (advances)" : ""}: ${opt.description}`
              );
            }
            lines.push("");
            lines.push("Use `flow_record_gate` to answer.");
            break;
          }
          case "block":
            lines.push(`❌ Blocked: ${outcome.error || params.message}`);
            break;
          case "done":
            lines.push("🎉 Workflow complete!");
            break;
        }

        lines.push("");
        lines.push(...renderWorkflowStatus(outcome.state));

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { action: outcome.action, featurePath: outcome.featurePath },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error completing step: ${(err as Error).message}`,
            },
          ],
          details: { isError: true },
        };
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
      "Answer an approval gate. If the chosen option has advance: true, the flow moves to the next step. Otherwise, the current step is reset for re-run.",
    promptSnippet:
      "Answer an approval gate in an active workflow",
    parameters: Type.Object({
      advance: Type.Boolean({ description: "Whether the chosen option means 'approved' (should match the agent's advance field)" }),
      chosenLabel: Type.Optional(Type.String({ description: "Label of the chosen option (for logging)" })),
      abort: Type.Optional(Type.Boolean({ description: "Whether this non-advance answer should abandon the workflow" })),
      featurePath: Type.Optional(Type.String()),
      projectRoot: Type.Optional(Type.String()),
    }),
    renderResult: renderProjectBuilderToolResult,
    async execute(
      _toolCallId: string,
      params: { advance: boolean; chosenLabel?: string; abort?: boolean; featurePath?: string; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      try {
        // Need the step index from the current workflow state
        const state = status(projectRoot, params.featurePath);
        if (!state) {
          return {
            content: [{ type: "text", text: "No active workflow found." }],
            details: {},
          };
        }

        if (!state.gate) {
          return {
            content: [{ type: "text", text: "No active gate to answer." }],
            details: {},
          };
        }

        // When UI is available, present the gate directly to the user.
        // This prevents the AI from auto-approving gates without user input.
        let actualAdvance = params.advance;
        let actualLabel = params.chosenLabel ?? "answered";
        let actualAbort = params.abort ?? false;

        if (ctx.hasUI) {
          const previewLines = renderGatePreview(projectRoot, state.feature_path, state.gate);
          if (previewLines.length > 0) {
            ctx.ui.notify(previewLines.join("\n"), "info");
          }

          const gateOptions = state.gate.options.map((o) => o.label);
          const chosenLabel = await ctx.ui.select(
            `Approve: ${state.gate.header}`,
            gateOptions
          );

          const chosenOption = chosenLabel
            ? state.gate.options.find((o) => o.label === chosenLabel)
            : undefined;

          actualAdvance = chosenOption?.advance ?? false;
          actualAbort = chosenOption?.abort ?? false;
          actualLabel = chosenLabel ?? "cancelled";
        }

        const outcome = recordGate(
          {
            stepIndex: state.gate.stepIndex,
            chosenLabel: actualLabel,
            advance: actualAdvance,
            abort: actualAbort,
          },
          projectRoot,
          params.featurePath
        );

        if (!outcome) {
          return {
            content: [{ type: "text", text: "Failed to record gate answer." }],
            details: {},
          };
        }
        syncWorkflowWidget(ctx, projectRoot, outcome.featurePath);

        const lines: string[] = [];
        lines.push(`Gate answered: ${actualAdvance ? "✅ Approved" : "❌ Not approved"}`);

        if (outcome.action === "advance") {
          lines.push("→ Advancing to next step.");
        } else if (outcome.action === "retry") {
          lines.push("↻ Same step will re-run.");
        } else if (outcome.action === "done") {
          lines.push("🎉 Workflow complete!");
        } else if (outcome.action === "abort") {
          lines.push("🛑 Workflow aborted.");
        }

        lines.push("");
        lines.push(...renderWorkflowStatus(outcome.state));

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { action: outcome.action, featurePath: outcome.featurePath },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error recording gate: ${(err as Error).message}`,
            },
          ],
          details: { isError: true },
        };
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
    promptSnippet:
      "Show the status of an active or completed workflow",
    parameters: Type.Object({
      featurePath: Type.Optional(Type.String({ description: "Feature path (defaults to active workflow)" })),
      projectRoot: Type.Optional(Type.String()),
    }),
    renderResult: renderProjectBuilderToolResult,
    async execute(
      _toolCallId: string,
      params: { featurePath?: string; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      const state = status(projectRoot, params.featurePath);
      syncWorkflowWidget(ctx, projectRoot, params.featurePath);
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: params.featurePath
                ? `No workflow found at ${params.featurePath}`
                : "No active workflow found. Start one with flow_start.",
            },
          ],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: renderWorkflowStatus(state).join("\n") }],
        details: { status: state.status, featurePath: state.feature_path },
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: flow_list
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "flow_list",
    label: "List Flows",
    description:
      "List all workflow runs in the project's .temp/ directory, or list available flow definitions.",
    promptSnippet: "List available flows and active workflow runs",
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([
          Type.Literal("definitions"),
          Type.Literal("runs"),
          Type.Literal("all"),
        ] as const)
      ),
      projectRoot: Type.Optional(Type.String()),
    }),
    renderResult: renderProjectBuilderToolResult,
    async execute(
      _toolCallId: string,
      params: { mode?: "definitions" | "runs" | "all"; projectRoot?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();
      syncWorkflowWidget(ctx, projectRoot);
      const mode = params.mode || "all";
      const lines: string[] = [];

      if (mode === "definitions" || mode === "all") {
        lines.push("## Available Flow Definitions");
        for (const [id, entry] of flowRegistry) {
          lines.push(`- **${id}** v${entry.definition.version}: ${entry.definition.description}`);
          lines.push(`  Steps: ${entry.definition.steps.map((s) => s.agent).join(" → ")}`);
        }
        lines.push("");
      }

      if (mode === "runs" || mode === "all") {
        lines.push("## Workflow Runs");
        const runs = list(projectRoot);
        if (runs.length === 0) {
          lines.push("No workflow runs found.");
        } else {
          for (const fp of runs) {
            const state = status(projectRoot, fp);
            const running = state?.status !== "done" && state?.status !== "blocked";
            const icon = state?.status === "done" ? "✅" : state?.status === "blocked" ? "❌" : LOADING_ICON;
            const statusText = running ? LOADING_LABEL : state?.status ?? "?";
            lines.push(`- ${icon} ${fp} — ${state?.flow_id ?? "?"} [${statusText}]`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { flows: [...flowRegistry.keys()], runs: list(projectRoot) },
      };
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
      ctx: ExtensionContext
    ): Promise<AgentToolResult> {
      const projectRoot = params.projectRoot || getProjectRoot();

      const result = abort(projectRoot, params.featurePath);
      syncWorkflowWidget(ctx, projectRoot, params.featurePath);
      if (!result) {
        return {
          content: [{ type: "text", text: "No active workflow to abort." }],
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Workflow "${result.feature}" (${result.feature_path}) marked as abandoned.`,
          },
        ],
        details: { featurePath: result.feature_path },
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Slash command: /flow
  // ---------------------------------------------------------------------------
  pi.registerCommand("flow", {
    description: "Show flow engine status or available commands",
    handler: async (_args: string, ctx) => {
      const projectRoot = getProjectRoot();
      const active = status(projectRoot);

      if (active) {
        syncWorkflowWidget(ctx, projectRoot, active.feature_path);
        ctx.ui.notify(
          renderStaticWorkflowStatus(active).join("\n"),
          "info"
        );
        if (currentRunningStep(active)) {
          if (ctx.isIdle() && !ctx.hasPendingMessages()) {
            ctx.ui.notify("Resuming interrupted workflow step...", "info");
            pi.sendUserMessage(buildResumePrompt(projectRoot, active));
          } else {
            ctx.ui.notify("Workflow step is marked running; Pi is busy, so resume was not started.", "warning");
          }
        }
      } else {
        ctx.ui.notify(
          `No active workflow. Available flows: ${[...flowRegistry.keys()].join(", ")}`,
          "info"
        );
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Flow registry loader
// ---------------------------------------------------------------------------

function loadFlowRegistry(): void {
  flowRegistry = new Map();
  for (const definition of allFlows) {
    flowRegistry.set(definition.id, { definition });
  }
}

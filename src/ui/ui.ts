/**
 * Project Builder UI — TUI Dashboard
 *
 * Live workflow dashboard widget via ctx.ui.setWidget.
 *
 * **Compact** (default): step summary + subagent status lines via engine renderer.
 * **Expanded**: full step list with agent details, tools, tokens, elapsed.
 *
 * Toggle: /pb-expand or alt+o
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  renderWorkflowStatus,
  fitLineBudget,
} from "../engine/workflow-renderer.ts";
import { listCorrelatedSubagentRuns } from "../engine/subagent-activity.ts";
import type { EngineContext } from "./engine-context.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ============================================================================
// Spinner
// ============================================================================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// Dashboard state
// ============================================================================

let expanded = false;

// ============================================================================
// Widget renderer
// ============================================================================

function resolveWorkflow(
  engine: EngineContext,
  projectRoot: string,
  featurePath?: string
): { state: import("../shared/types.ts").WorkflowState; featurePath: string } | null {
  if (featurePath) {
    const state = engine.status(projectRoot, featurePath);
    return state ? { state, featurePath } : null;
  }
  // Auto-detect: find the most recent active workflow
  const runs = engine.list(projectRoot);
  for (const fp of runs) {
    const state = engine.status(projectRoot, fp);
    if (state && (state.status === "in_progress" || state.status === "awaiting_user")) {
      return { state, featurePath: fp };
    }
  }
  return null;
}

export function createDashboardRenderer(
  engine: EngineContext,
  projectRoot: string,
  featurePath?: string
) {
  // Mutable reference — resolved workflow can update across renders
  let rf: { state: import("../shared/types.ts").WorkflowState; featurePath: string } | null = featurePath
    ? resolveWorkflow(engine, projectRoot, featurePath)
    : null;

  if (!spinnerTimer) {
    spinnerTimer = setInterval(() => { spinnerIndex++; }, 150);
  }

  return (tui: { requestRender: () => void } | null, _theme: unknown) => {
    return {
      render(): string[] {
        // Re-resolve: if no fixed featurePath, auto-detect latest workflow
        if (!featurePath) {
          rf = resolveWorkflow(engine, projectRoot);
        } else if (!rf) {
          // Retry resolution in case workflow appears after a delay
          rf = resolveWorkflow(engine, projectRoot, featurePath);
        }

        if (!rf) {
          return ["\u23f3 starting workflow\u2026", "waiting for flow_start to be called"];
        }

        const current = rf.state;

        const hasRunning = current.steps.some((s) => s.status === "running");
        const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];

        // Delegate to the engine's workflow renderer for both compact and expanded
        const childRuns = hasRunning
          ? listCorrelatedSubagentRuns(current, expanded ? 6 : 3)
          : [];

        const lines = renderWorkflowStatus(current, {
          compact: !expanded,
          loadingIcon: hasRunning ? spinner : ">",
          childRuns,
        });

        // Auto-refresh for spinner and live worker updates (both compact and expanded)
        if ((hasRunning || !rf) && tui) {
          setTimeout(() => tui.requestRender(), 200);
        }

        const maxWidth = process.stdout.columns || 157;

        if (!expanded) {
          return fitLineBudget(lines, 24, false).map((l) => truncateToWidth(l, maxWidth));
        }

        // Safety: truncate every line to terminal width to prevent TUI crash
        return lines.map((l) => truncateToWidth(l, maxWidth));
      },

      invalidate(): void {
        if (tui) tui.requestRender();
      },
    };
  };
}

// ============================================================================
// Dashboard registration — on-demand only
// ============================================================================

export function registerDashboard(pi: ExtensionAPI, engine: EngineContext, projectRoot: string): void {
  // Keyboard shortcut: alt+o to toggle compact/expanded
  pi.registerShortcut("alt+o", {
    description: "Toggle workflow dashboard compact/expanded",
    handler: async (ctx: ExtensionContext) => {
      expanded = !expanded;
      showDashboard(ctx, engine, projectRoot);
      ctx.ui.notify(
        expanded ? "Dashboard expanded" : "Dashboard compacted",
        "info"
      );
    },
  });
}

// ============================================================================
// Public: show/hide dashboard (called from slash commands)
// ============================================================================

/** Show the workflow dashboard widget. Returns false if no active workflow. */
export function showDashboard(
  ctx: ExtensionContext,
  engine: EngineContext,
  projectRoot: string
): boolean {
  // Always register the widget — it auto-detects the workflow on each render
  ctx.ui.setWidget(
    "pb-dashboard",
    createDashboardRenderer(engine, projectRoot)
  );

  const current = engine.status(projectRoot, undefined);
  if (!current) {
    // No workflow yet (just called startNewWorkflow, LLM hasn't called flow_start yet)
    ctx.ui.setStatus(
      "pb-workflow",
      `${SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]} starting workflow…`
    );
    return false;
  }

  // Status bar
  const step = current.steps[current.current_step_index];
  if (step) {
    const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    const icon =
      current.status === "awaiting_user" ? "⛔"
      : current.status === "done" ? "✅"
      : current.status === "blocked" ? "❌"
      : spinner;
    ctx.ui.setStatus(
      "pb-workflow",
      `${icon} ${current.feature} · ${step.agent} · step ${step.index + 1}/${current.steps.length} · ${current.status}`
    );
  }

  return true;
}

/** Hide the dashboard widget and clear the status bar. */
export function hideDashboard(ctx: ExtensionContext): void {
  ctx.ui.setWidget("pb-dashboard", undefined);
  ctx.ui.setStatus("pb-workflow", undefined);
}

// ============================================================================
// Exported toggle (used by /pb-expand command)
// ============================================================================

export function toggleDashboardExpand(): boolean {
  expanded = !expanded;
  return expanded;
}

export function isDashboardExpanded(): boolean {
  return expanded;
}

/**
 * Step Summary Widget — Live above-editor widget for project-builder workflows.
 *
 * Shows an expanded view of the current workflow step with full child subagent
 * activity tree while the orchestrator LLM is executing.
 *
 * Expanded layout:
 *   ━ Step 3/10: implement · working · 32s
 *     ┃ Phase: planning worker fan-out
 *     ┃ Tool: subagent · Path: src/auth/
 *     ┃ Model: google/gemini-2.0-flash · thinking medium · 1.2k tokens
 *     ┃
 *     ┃ Child runs:
 *     ┃  ✓ worker · 3/5 done · 1 running · 12k tokens
 *     ┃    ✓ step 1: worker · complete · 8s · 3 tools · 4k tokens
 *     ┃    > step 1: worker · running · 5s · tool: read src/auth/login.ts
 *     ┃    ◦ step 2: worker · pending
 *     ┃    …
 *
 * The widget is registered via ctx.ui.setWidget() and renders the full expanded
 * view above the editor.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkflowState, WorkflowStep } from "../shared/types.ts";
import type { EngineContext } from "./engine-context.ts";
import type { WorkflowChildRun, WorkflowChildStep } from "../engine/workflow-renderer.ts";
import { listCorrelatedSubagentRuns } from "../engine/subagent-activity.ts";

// ============================================================================
// Constants
// ============================================================================

const MAX_EXPANDED_CHILD_RUNS = 8;
const MAX_EXPANDED_CHILD_STEPS = 6;

// ============================================================================
// Formatting helpers (local, to avoid pulling in theme from non-render context)
// ============================================================================

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return "now";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Number(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${Number(value / 1_000_000).toFixed(1)}m`;
}

function stepElapsed(step: WorkflowStep, now: number): string | undefined {
  const start = step.started_at ? Date.parse(step.started_at) : undefined;
  if (!start || Number.isNaN(start)) return undefined;
  const end = step.completed_at ? Date.parse(step.completed_at) : now;
  if (!end || Number.isNaN(end)) return undefined;
  return formatDuration(end - start);
}

function statusLabel(status: string | undefined): string {
  if (status === "needs_attention") return "⚠ needs attention";
  if (status === "blocked") return "✗ blocked";
  return status ?? "working";
}

/**
 * Build a short summary of child run status.
 * E.g. "3/5 workers done · 1 running"
 */
function childRunSummary(runs: WorkflowChildRun[]): string | undefined {
  if (runs.length === 0) return undefined;

  const total = runs.length;
  const done = runs.filter((r) => r.state === "complete" || r.state === "failed").length;
  const running = runs.filter((r) => r.state === "running").length;
  const paused = runs.filter((r) => r.state === "paused").length;

  const parts: string[] = [];
  if (done > 0) parts.push(`${done}/${total} done`);
  if (running > 0) parts.push(`${running} running`);
  if (paused > 0) parts.push(`${paused} paused`);

  const totalTokens = runs.reduce((sum, r) => sum + (r.totalTokens?.total ?? 0), 0);
  if (totalTokens > 0) parts.push(`${formatTokenCount(totalTokens)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// ============================================================================
// StepSummaryWidget — Component
// ============================================================================

export class StepSummaryWidget {
  private _engine: EngineContext;
  private _projectRoot: string;
  private _requestRender: (() => void) | null = null;
  private _cachedWidth: number | undefined;
  private _cachedLines: string[] | undefined;

  constructor(engine: EngineContext, projectRoot: string) {
    this._engine = engine;
    this._projectRoot = projectRoot;
  }

  /**
   * Set a callback to request a TUI re-render.
   * Called by the tools layer after state changes.
   */
  setRequestRender(fn: () => void): void {
    this._requestRender = fn;
  }

  /** Notify the widget that the workflow state has changed — triggers re-render */
  notifyChange(): void {
    this.invalidate();
    this._requestRender?.();
  }

  // ========================================================================
  // Component interface (render + invalidate)
  // ========================================================================

  invalidate(): void {
    this._cachedWidth = undefined;
    this._cachedLines = undefined;
  }

  /**
   * Render the widget lines using the expanded view.
   *
   * @param width  Available width for the widget
   * @param theme  Theme object for styling (can be any theme-like object)
   */
  render(width: number, theme?: unknown): string[] {
    if (this._cachedLines && this._cachedWidth === width) {
      return this._cachedLines;
    }

    const state = this._engine.status(this._projectRoot);
    if (!state) {
      this._cachedLines = [];
      this._cachedWidth = width;
      return this._cachedLines;
    }

    const now = Date.now();
    const lines = this.renderExpanded(state, width, theme, now);

    this._cachedWidth = width;
    this._cachedLines = lines;
    return lines;
  }

  // ========================================================================
  // Expanded rendering
  // ========================================================================

  private renderExpanded(
    state: WorkflowState,
    width: number,
    theme: any,
    now: number
  ): string[] {
    const step = state.steps[state.current_step_index];
    if (!step) {
      return [this.limitLine(`━ ${state.feature} · ${state.status} (no step)`, width)];
    }

    const lines: string[] = [];
    const elapsed = stepElapsed(step, now);
    const status = statusLabel(step.activity?.status ?? step.status);
    const phase = step.activity?.phase;
    const message = step.activity?.message;
    const currentTool = step.activity?.current_tool;
    const currentPath = step.activity?.current_path;
    const totalSteps = state.steps.length;

    // ── Header line ──
    const headerParts: string[] = [
      `Step ${step.index + 1}/${totalSteps}: ${step.agent}`,
      status,
    ];
    if (elapsed) headerParts.push(elapsed);
    lines.push(this.limitLine(`━ ${headerParts.join(" · ")}`, width));

    // ── Detail lines ──
    if (phase) {
      lines.push(this.limitLine(` ┃ Phase: ${phase}`, width));
    }
    if (message && message !== phase) {
      lines.push(this.limitLine(` ┃ ${message}`, width));
    }
    if (currentTool) {
      const toolLine = currentPath
        ? ` ┃ Tool: ${currentTool}  ·  Path: ${currentPath}`
        : ` ┃ Tool: ${currentTool}`;
      lines.push(this.limitLine(toolLine, width));
    }
    if (step.attempt > 1) {
      lines.push(this.limitLine(` ┃ Attempt: ${step.attempt}/${step.result?.result === "error" ? 1 : step.attempt}`, width));
    }
    if (step.last_feedback) {
      lines.push(this.limitLine(` ┃ Feedback: ${step.last_feedback}`, width));
    }

    // ── Awaiting gate ──
    if (state.status === "awaiting_user" && state.gate) {
      lines.push(this.limitLine(` ┃ ⛔ Awaiting approval: ${state.gate.header}`, width));
      lines.push(this.limitLine(` ┃    Options: ${state.gate.options.map((o) => o.label).join(", ")}`, width));
    }

    // ── Child runs ──
    const childRuns = listCorrelatedSubagentRuns(state, MAX_EXPANDED_CHILD_RUNS);
    if (childRuns.length > 0) {
      const summary = childRunSummary(childRuns);
      lines.push("");
      lines.push(this.limitLine(` ┃ Child runs${summary ? ` · ${summary}` : ""}:`, width));

      for (const run of childRuns) {
        // Render the child run header
        const runLine = this.renderChildRunLine(run, width, theme);
        lines.push(this.limitLine(` ┃  ${runLine}`, width));

        // Render individual child steps
        const steps = (run.steps ?? []).slice(0, MAX_EXPANDED_CHILD_STEPS);
        for (const childStep of steps) {
          const stepLine = this.renderChildStepLine(childStep, now);
          lines.push(this.limitLine(` ┃    ${stepLine}`, width));
        }

        if ((run.steps?.length ?? 0) > MAX_EXPANDED_CHILD_STEPS) {
          lines.push(this.limitLine(
            ` ┃    … ${(run.steps?.length ?? 0) - MAX_EXPANDED_CHILD_STEPS} more steps hidden`,
            width
          ));
        }
      }

      if (childRuns.length >= MAX_EXPANDED_CHILD_RUNS) {
        lines.push(this.limitLine(
          ` ┃ … ${MAX_EXPANDED_CHILD_RUNS} of ${childRuns.length} runs shown`,
          width
        ));
      }
    }

    // ── Footer ──
    lines.push("");
    lines.push(this.limitLine(
      this.applyTheme(theme, "dim", "workflow step summary"),
      width
    ));

    return lines;
  }

  private renderChildRunLine(
    run: WorkflowChildRun,
    _width: number,
    _theme: any
  ): string {
    const total = run.steps?.length ?? run.agents?.length ?? 1;
    const done = run.steps?.filter((s) => s.status === "complete" || s.status === "completed").length ?? 0;
    const running = run.steps?.filter((s) => s.status === "running").length ?? 0;
    const failed = run.steps?.filter((s) => s.status === "failed").length ?? 0;

    const prefix = run.state === "complete" ? "✓" : run.state === "failed" ? "✗" : run.state === "running" ? ">" : "◦";
    const title = run.agents?.length === 1 ? run.agents[0] : run.mode ?? "subagent";

    const parts: string[] = [title];
    parts.push(`${done}/${total} done`);
    if (running > 0) parts.push(`${running} running`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (run.totalTokens?.total) parts.push(`${formatTokenCount(run.totalTokens.total)}`);

    return `${prefix} ${parts.join(" · ")}`;
  }

  private renderChildStepLine(
    step: WorkflowChildStep,
    now: number
  ): string {
    const prefix = step.status === "complete" || step.status === "completed"
      ? "✓"
      : step.status === "failed"
        ? "✗"
        : step.status === "running"
          ? ">"
          : step.status === "paused"
            ? "■"
            : "◦";

    const agent = step.agent;
    const status = step.status;

    const parts: string[] = [agent, status];

    if (step.model) {
      const shortModel = step.model.split("/").pop() ?? step.model;
      const thinkingLabel = step.thinking ? `thinking ${step.thinking}` : undefined;
      parts.push(thinkingLabel ? `${shortModel} ${thinkingLabel}` : shortModel);
    }

    if (step.durationMs !== undefined) parts.push(formatDuration(step.durationMs));
    if (step.toolCount !== undefined) parts.push(`${step.toolCount} tools`);
    if (step.tokens?.total) parts.push(`${formatTokenCount(step.tokens.total)}`);
    if (step.currentTool) {
      const toolStr = step.currentPath
        ? `${step.currentTool} ${step.currentPath}`
        : step.currentTool;
      parts.push(toolStr);
    }
    if (step.error) parts.push(`error: ${step.error}`);
    if (step.activityState === "needs_attention") parts.push("⚠ needs attention");

    return `${prefix} ${parts.join(" · ")}`;
  }

  // ========================================================================
  // Utilities
  // ========================================================================

  private limitLine(text: string, width: number): string {
    return truncateToWidth(text, width);
  }

  private applyTheme(theme: any, color: string, text: string): string {
    if (theme?.fg) {
      try {
        return theme.fg(color, text);
      } catch {
        return text;
      }
    }
    return text;
  }
}

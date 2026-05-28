import type { WorkflowState, WorkflowStep } from "../shared/types.ts";

export interface WorkflowChildStep {
  index?: number;
  agent: string;
  status: "pending" | "running" | "complete" | "completed" | "failed" | "paused";
  activityState?: "active_long_running" | "needs_attention";
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  recentTools?: Array<{ tool: string; args: string; endMs: number }>;
  recentOutput?: string[];
  turnCount?: number;
  toolCount?: number;
  durationMs?: number;
  tokens?: { total: number };
  model?: string;
  thinking?: string;
  error?: string;
}

export interface WorkflowChildRun {
  id: string;
  asyncDir?: string;
  mode?: "single" | "parallel" | "chain";
  state: "queued" | "running" | "complete" | "failed" | "paused";
  agents?: string[];
  startedAt?: number;
  updatedAt?: number;
  outputFile?: string;
  currentStep?: number;
  chainStepCount?: number;
  steps?: WorkflowChildStep[];
  totalTokens?: { total: number };
}

export interface RenderWorkflowOptions {
  compact?: boolean;
  expanded?: boolean;
  childRuns?: WorkflowChildRun[];
  loadingIcon?: string;
  now?: number;
}

const DEFAULT_LOADING_ICON = ">";

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return "now";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function formatAge(ts: number | undefined, now: number): string | undefined {
  if (ts === undefined) return undefined;
  return formatDuration(now - ts);
}

function stepGlyph(step: WorkflowStep, loadingIcon: string): string {
  if (step.status === "completed") return "✓";
  if (step.status === "failed") return "x";
  if (step.status === "running") return loadingIcon;
  return "◦";
}

function childGlyph(status: WorkflowChildStep["status"] | WorkflowChildRun["state"], loadingIcon: string): string {
  if (status === "complete" || status === "completed") return "✓";
  if (status === "failed") return "x";
  if (status === "paused") return "■";
  if (status === "running") return loadingIcon;
  return "◦";
}

function compactStatus(step: WorkflowStep): string {
  if (step.status === "running") return step.activity?.phase ?? step.activity?.message ?? "working";
  if (step.status === "completed") return truncate(step.result?.message ?? "completed", 90);
  if (step.status === "failed") return truncate(step.result?.message ?? "failed", 90);
  return step.status;
}

function truncate(value: string, max = 90): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function stepElapsed(step: WorkflowStep, now: number): string | undefined {
  const start = step.started_at ? Date.parse(step.started_at) : undefined;
  if (!start || Number.isNaN(start)) return undefined;
  const end = step.completed_at ? Date.parse(step.completed_at) : now;
  if (!end || Number.isNaN(end)) return undefined;
  return formatDuration(end - start);
}

function modelBadge(step: WorkflowChildStep): string {
  const model = step.model?.split("/").pop();
  if (!model && !step.thinking) return "";
  return ` (${[model, step.thinking ? `thinking ${step.thinking}` : ""].filter(Boolean).join(" · ")})`;
}

function childStats(step: WorkflowChildStep): string {
  const parts = [
    step.toolCount !== undefined ? `${step.toolCount} tools` : "",
    step.turnCount !== undefined ? `${step.turnCount} turns` : "",
    step.tokens?.total ? `${formatTokenCount(step.tokens.total)} token` : "",
    step.durationMs !== undefined ? formatDuration(step.durationMs) : "",
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Number(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${Number(value / 1_000_000).toFixed(1)}m`;
}

function childActivity(step: WorkflowChildStep, now: number, expanded: boolean): string {
  if (step.activityState === "needs_attention") return "needs attention";
  if (step.activityState === "active_long_running") return "active but long-running";
  if (step.currentTool) {
    const duration = step.currentToolStartedAt !== undefined ? ` ${formatDuration(now - step.currentToolStartedAt)}` : "";
    const args = step.currentToolArgs && expanded ? `: ${step.currentToolArgs}` : "";
    return `${step.currentTool}${args}${duration}`;
  }
  const age = formatAge(step.lastActivityAt, now);
  if (age) return age === "now" ? "active now" : `active ${age} ago`;
  if (step.error) return step.error;
  return "";
}

function runSummary(run: WorkflowChildRun): string {
  const total = run.steps?.length ?? run.agents?.length ?? 1;
  const running = run.steps?.filter((step) => step.status === "running").length ?? (run.state === "running" ? 1 : 0);
  const done = run.steps?.filter((step) => step.status === "complete" || step.status === "completed").length ?? (run.state === "complete" ? total : 0);
  const parts = [
    run.mode ?? "subagent",
    run.state,
    total > 1 ? `${done}/${total} done` : "",
    running > 0 ? `${running} running` : "",
    run.totalTokens?.total ? `${formatTokenCount(run.totalTokens.total)} token` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function renderChildRun(run: WorkflowChildRun, loadingIcon: string, now: number, expanded: boolean): string[] {
  const lines: string[] = [];
  const title = run.agents?.length === 1 ? run.agents[0] : run.mode ?? "subagent";
  lines.push(`    ${childGlyph(run.state, loadingIcon)} ${title ?? "subagent"} · ${runSummary(run)}`);

  const steps = run.steps ?? [];
  if (steps.length === 0) {
    if (run.outputFile && expanded) lines.push(`      output: ${run.outputFile}`);
    return lines;
  }

  const visibleSteps = expanded ? steps : steps.filter((step) => step.status === "running").slice(0, 3);
  for (const [index, step] of visibleSteps.entries()) {
    const label = run.mode === "parallel" ? `worker ${index + 1}/${steps.length}` : `step ${(step.index ?? index) + 1}/${steps.length}`;
    const activity = childActivity(step, now, expanded);
    lines.push(
      `      ${childGlyph(step.status, loadingIcon)} ${label} ${step.agent}${modelBadge(step)} · ${step.status}${activity ? ` · ${activity}` : ""}${childStats(step)}`
    );
    if (expanded) {
      for (const tool of step.recentTools?.slice(-3) ?? []) {
        lines.push(`        tool: ${tool.tool}${tool.args ? ` ${truncate(tool.args, 100)}` : ""}`);
      }
      for (const output of step.recentOutput?.slice(-3) ?? []) {
        lines.push(`        recent: ${truncate(output, 100)}`);
      }
    }
  }

  if (!expanded && steps.length > visibleSteps.length) {
    lines.push(`      … ${steps.length - visibleSteps.length} child rows hidden · Ctrl+O expands`);
  }
  if (expanded && run.outputFile) lines.push(`      output: ${run.outputFile}`);
  return lines;
}

function renderStepLine(
  state: WorkflowState,
  step: WorkflowStep,
  loadingIcon: string,
  now: number
): string {
  const current = step.index === state.current_step_index ? ">" : " ";
  const attempt = step.attempt > 1 ? ` attempt ${step.attempt}` : "";
  const elapsed = stepElapsed(step, now);
  const elapsedText = elapsed ? ` · ${elapsed}` : "";
  const detail = compactStatus(step);
  return `${current} ${stepGlyph(step, loadingIcon)} Step ${step.index + 1}: ${step.agent} · ${step.status}${attempt}${elapsedText}${detail ? ` · ${truncate(detail, 70)}` : ""}`;
}

export function renderWorkflowStatus(state: WorkflowState, options: RenderWorkflowOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const loadingIcon = options.loadingIcon ?? DEFAULT_LOADING_ICON;
  if (options.compact) return renderCompactWorkflowStatus(state, options);

  const lines: string[] = [];
  lines.push(`Flow: ${state.flow_id} v${state.flow_version} - ${state.feature}`);
  lines.push(`Status: ${state.status}${state.build_status ? ` (${state.build_status})` : ""}`);
  lines.push(`Path: ${state.feature_path}`);
  lines.push("");

  for (const step of state.steps) {
    lines.push(renderStepLine(state, step, loadingIcon, now));
    if (options.expanded && step.index === state.current_step_index && options.childRuns?.length) {
      for (const run of options.childRuns) lines.push(...renderChildRun(run, loadingIcon, now, true));
    }
  }

  if (!options.expanded && options.childRuns?.length) {
    lines.push("");
    for (const run of options.childRuns) lines.push(...renderChildRun(run, loadingIcon, now, false));
  }

  if (state.gate) {
    lines.push("");
    lines.push(`! Awaiting approval: ${state.gate.header}`);
    lines.push(`  Options: ${state.gate.options.map((o) => o.label).join(", ")}`);
  }

  return lines;
}

function renderCompactWorkflowStatus(state: WorkflowState, options: RenderWorkflowOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const loadingIcon = options.loadingIcon ?? DEFAULT_LOADING_ICON;
  const step = state.steps[state.current_step_index] ?? state.steps.find((candidate) => candidate.status === "running");
  if (!step) return [`${state.flow_id} v${state.flow_version} · ${state.feature} · ${state.status}`];

  const elapsed = stepElapsed(step, now);
  const headline = `${state.flow_id} v${state.flow_version} · ${state.feature} · step ${step.index + 1}/${state.steps.length} ${step.agent} · ${step.status}${elapsed ? ` ${elapsed}` : ""}`;
  const lines = [headline];
  const activity = step.activity?.message ?? step.activity?.phase ?? truncate(compactStatus(step));
  lines.push(`  ${step.agent} · ${activity}`);

  const childRuns = options.childRuns ?? [];
  for (const run of childRuns.slice(0, 3)) {
    const activeStep = run.steps?.find((candidate) => candidate.status === "running") ?? run.steps?.[0];
    if (activeStep) {
      lines.push(`  ${childGlyph(activeStep.status, loadingIcon)} ${activeStep.agent} · ${childActivity(activeStep, now, false) || activeStep.status}${childStats(activeStep)}`);
    } else {
      lines.push(`  ${childGlyph(run.state, loadingIcon)} ${run.agents?.join(", ") ?? "subagent"} · ${runSummary(run)}`);
    }
  }
  if (childRuns.length > 3) lines.push(`  … ${childRuns.length - 3} child runs hidden · Ctrl+O expands`);
  return lines;
}

export function fitLineBudget(lines: string[], rows: number, expanded: boolean): string[] {
  const budget = expanded
    ? Math.max(12, Math.min(24, Math.floor(rows * 0.55)))
    : Math.max(4, Math.min(10, Math.floor(rows * 0.3)));
  if (lines.length <= budget) return lines;
  const visible = Math.max(1, budget - 1);
  const hidden = lines.length - visible;
  return [...lines.slice(0, visible), expanded ? `… ${hidden} live-detail lines hidden` : `… ${hidden} lines hidden · Ctrl+O expands`];
}

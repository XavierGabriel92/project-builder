import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowState } from "../shared/types.ts";
import type { WorkflowChildRun, WorkflowChildStep } from "./workflow-renderer.ts";

interface WorkflowCorrelation {
  projectRoot?: string;
  featurePath?: string;
  stepIndex?: number;
  agent?: string;
  flowId?: string;
}

interface AsyncStatusFile {
  runId?: string;
  mode?: "single" | "parallel" | "chain";
  state?: "queued" | "running" | "complete" | "failed" | "paused";
  cwd?: string;
  startedAt?: number;
  lastUpdate?: number;
  endedAt?: number;
  outputFile?: string;
  currentStep?: number;
  chainStepCount?: number;
  agents?: string[];
  totalTokens?: { total: number };
  steps?: WorkflowChildStep[];
  workflow?: WorkflowCorrelation;
}

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolveTempScopeId(): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  return home ? `home-${sanitizeTempScopeSegment(home)}` : "shared";
}

export const SUBAGENT_ASYNC_RUNS_DIR = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`, "async-subagent-runs");

function readJson(file: string): AsyncStatusFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as AsyncStatusFile;
  } catch {
    return null;
  }
}

function resolveOutputPath(asyncDir: string, outputFile: string | undefined): string | undefined {
  if (!outputFile) return undefined;
  return path.isAbsolute(outputFile) ? outputFile : path.join(asyncDir, outputFile);
}

function statusMtime(statusFile: string): number {
  try {
    return fs.statSync(statusFile).mtimeMs;
  } catch {
    return 0;
  }
}

function matchesWorkflow(state: WorkflowState, status: AsyncStatusFile, childRunIds: Set<string>): boolean {
  const runId = status.runId;
  if (runId && childRunIds.has(runId)) return true;
  const workflow = status.workflow;
  if (!workflow) return false;
  if (workflow.projectRoot && path.resolve(workflow.projectRoot) !== path.resolve(state.project_root)) return false;
  if (workflow.featurePath !== state.feature_path) return false;
  if (workflow.stepIndex !== undefined && workflow.stepIndex !== state.current_step_index) return false;
  return true;
}

export function listCorrelatedSubagentRuns(state: WorkflowState, limit = 6): WorkflowChildRun[] {
  const currentStep = state.steps[state.current_step_index];
  const childRunIds = new Set(currentStep?.activity?.child_run_ids ?? []);
  let entries: string[];
  try {
    entries = fs.readdirSync(SUBAGENT_ASYNC_RUNS_DIR);
  } catch {
    return [];
  }

  const runs = entries
    .map((entry) => {
      const asyncDir = path.join(SUBAGENT_ASYNC_RUNS_DIR, entry);
      const statusFile = path.join(asyncDir, "status.json");
      const status = readJson(statusFile);
      if (!status || !matchesWorkflow(state, status, childRunIds)) return null;
      const id = status.runId ?? entry;
      const agents = status.steps?.map((step) => step.agent);
      return {
        id,
        asyncDir,
        mode: status.mode,
        state: status.state ?? "running",
        agents,
        startedAt: status.startedAt,
        updatedAt: status.lastUpdate ?? status.endedAt ?? statusMtime(statusFile),
        outputFile: resolveOutputPath(asyncDir, status.outputFile),
        currentStep: status.currentStep,
        chainStepCount: status.chainStepCount,
        steps: status.steps,
        totalTokens: status.totalTokens,
      } satisfies WorkflowChildRun;
    })
    .filter((run): run is WorkflowChildRun => Boolean(run))
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

  return runs.slice(0, limit);
}

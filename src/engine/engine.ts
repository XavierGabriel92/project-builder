/**
 * Flow Engine
 *
 * Domain-agnostic engine that advances through flow steps based on
 * supervisor-submitted step-results and user gate answers.
 *
 * API:
 *   start(flow, featureName, projectRoot, options) → StartResult
 *   step(projectRoot, options) → StepInstruction | null
 *   stepComplete(result, projectRoot, options) → StepCompleteResult | null
 *   stepUpdate(update, projectRoot, featurePath?) → StepUpdateResult | null
 *   recordGate(answer, projectRoot, featurePath?) → GateResult | null
 *   status(featurePath?, projectRoot) → WorkflowState | null
 *   list(projectRoot) → string[]
 *   abort(projectRoot, featurePath?) → WorkflowState | null
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type FlowDefinition,
  type GateAnswer,
  type StepInstruction,
  type StepResult,
  type WorkflowStepUpdate,
  type WorkflowState,
} from "../shared/types.ts";
import {
  resolveFeaturePath,
  writeWorkflow,
  listWorkflows,
  resolveWorkflow,
  getWorkflowDir,
  cleanupWorkflows as cleanupPersisted,
} from "../shared/persistence.ts";
import {
  createWorkflowState,
  startStep,
  applyStepResult,
  applyGateAnswer,
  updateStepActivity,
  currentStep,
  currentWorkflowStep,
  type StepTransition,
  type GateTransition,
} from "./transitions.ts";
import type { LoadedAgent } from "./agent-loader.ts";
import {
  loadAgent,
  loadFlowAgents,
  validateFlowApproval,
  buildGate,
} from "./agent-loader.ts";

// ============================================================================
// Agent cache (avoids re-reading .md files on every step/complete call)
// ============================================================================

const agentCache = new Map<string, { loaded: LoadedAgent; mtime: number }>();

function getCachedAgent(agentsDir: string, agentId: string, isSubagent = false): LoadedAgent {
  const filePath = path.join(agentsDir, agentId.endsWith(".md") ? agentId : `${agentId}.md`);
  const cached = agentCache.get(filePath);
  try {
    const currentMtime = fs.statSync(filePath).mtimeMs;
    if (cached && cached.mtime === currentMtime) {
      return cached.loaded;
    }
  } catch {
    // File might not exist yet; fall through to loadAgent which will throw
  }

  const loaded = loadAgent(agentsDir, agentId, isSubagent);
  try {
    agentCache.set(filePath, { loaded, mtime: fs.statSync(filePath).mtimeMs });
  } catch {
    // Don't cache if stat fails
  }
  return loaded;
}

// ============================================================================
// Prompt Prefix / Suffix (injected by the engine, not written in agent .md files)
// ============================================================================

function workspacePrefix(featurePath: string): string {
  return (
    "## Workspace\n\n" +
    `Write all output files to .temp/${featurePath}/. ` +
    "Read inputs from the same directory.\n"
  );
}

function completionSuffix(strictOutputs: boolean): string {
  const blockMsg = strictOutputs
    ? "If you do not write them, the workflow will block."
    : "If you do not write them, warnings will appear when you complete the step.";

  return (
    "\n\n## Important\n\n" +
    "Follow the instructions above carefully. Do not skip steps or complete this step " +
    "without doing the work described. The workflow expects the declared output files " +
    `to exist. ${blockMsg}\n\n` +
    "## Completion\n\n" +
    "When you have finished all the work described above, stop. " +
    "Do not ask what to do next. Do not offer to continue. " +
    "The workflow will advance automatically."
  );
}

const APPROVAL_INSTRUCTION =
  "\n\n## Approval Gate\n\n" +
  "After you submit `flow_step_complete` with `result: \"success\"`, this step will " +
  "pause for user approval before the workflow advances. " +
  "When the approval gate appears, you MUST use `ask_user_question` to present " +
  "the gate options to the user. " +
  "Do NOT call `flow_record_gate` directly without the user's explicit choice. " +
  "Only after the user picks an option should you call `flow_record_gate` " +
  "with their answer.\n\n" +
  "If the user has given you general instructions to proceed without asking " +
  "(e.g., \"do not ask questions, keep going\"), you may auto-answer the gate. " +
  "Otherwise, always ask first.";

const SUBAGENT_COMPLETION_SUFFIX =
  "\n\n## Completion\n\n" +
  "When you have finished, stop. Return your results to the orchestrator. " +
  "Do not ask questions or offer to continue.";

const SUPPRESS_SUBAGENT_PROGRESS =
  "\n\n## Subagent Behavior\n\n" +
  "Always pass `progress: false` to every subagent call. " +
  "Do not generate progress.md files. " +
  "All workflow output belongs under .temp/.";

// ============================================================================
// validateFlows
// ============================================================================

/** Validate registered flows and all referenced agent manifests. */
export function validateFlows(flows: FlowDefinition[], agentsDir: string): void {
  const errors: string[] = [];
  for (const flow of flows) {
    try {
      loadFlowAgents(agentsDir, flow);
      validateFlowApproval(agentsDir, flow);
    } catch (err) {
      errors.push(`Flow "${flow.id}": ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Flow validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}

// ============================================================================
// start
// ============================================================================

export interface StartResult {
  state: WorkflowState;
  featurePath: string;
}

export interface StartOptions {
  serviceDirs?: string[];
  agentsDir: string;
}

/**
 * Start a new flow run.
 *
 * 1. Validates the flow definition
 * 2. Validates all approval gates exist
 * 3. Creates workflow.json with frozen flow_snapshot
 *
 * @throws if validation fails (e.g., missing approval block)
 */
export function start(
  flow: FlowDefinition,
  featureName: string,
  projectRoot: string,
  options: StartOptions
): StartResult {
  const { serviceDirs, agentsDir } = options;

  // Validate that requestApproval steps have approval blocks
  validateFlowApproval(agentsDir, flow);

  const featurePath = resolveFeaturePath(featureName, projectRoot);
  const state = createWorkflowState(flow, featureName, featurePath, projectRoot, serviceDirs);

  writeWorkflow(projectRoot, featurePath, state);

  return { state, featurePath };
}

// ============================================================================
// step
// ============================================================================

export interface StepOptions {
  featurePath?: string;
  agentsDir: string;
}

/**
 * Get the current step's instructions for the supervisor.
 *
 * Loads the agent manifest, builds a StepInstruction with tools,
 * subagents, parallel config, prompt, etc.
 *
 * Returns null if no active workflow found.
 * @throws if the agent .md cannot be loaded
 */
export function step(
  projectRoot: string,
  options: StepOptions
): StepInstruction | null {
  const { featurePath, agentsDir } = options;
  const resolved = resolveWorkflow(projectRoot, featurePath);
  if (!resolved) return null;

  let { state } = resolved;
  if (state.status === "awaiting_user") {
    throw new Error("Workflow is awaiting user approval. Answer the active gate before requesting another step.");
  }
  if (state.status !== "in_progress") return null;

  const flowStep = currentStep(state);
  if (!flowStep) return null; // No more steps

  // Mark step as running and persist
  state = startStep(state);
  writeWorkflow(projectRoot, resolved.featurePath, state);

  // Load agent manifest (cached)
  const loaded = getCachedAgent(agentsDir, flowStep.agent);
  const subagentInstructions = loaded.manifest.subagents
    ? Object.fromEntries(
        Object.entries(loaded.manifest.subagents).map(([name, relativePath]) => {
          const subagent = getCachedAgent(agentsDir, relativePath, true);
          return [
            name,
            {
              path: relativePath,
              tools: subagent.manifest.tools,
              prompt:
                workspacePrefix(resolved.featurePath) +
                "\n\n" +
                subagent.prompt +
                SUBAGENT_COMPLETION_SUFFIX,
            },
          ];
        })
      )
    : undefined;

  const currentWsStep = currentWorkflowStep(state);

  // Build instruction
  const instruction: StepInstruction = {
    agent: flowStep.agent,
    stepIndex: state.current_step_index,
    tools: loaded.manifest.tools,
    subagents: loaded.manifest.subagents,
    subagentInstructions,
    parallel: loaded.manifest.parallel,
    prompt:
      workspacePrefix(resolved.featurePath) +
      "\n\n" +
      loaded.prompt +
      (loaded.manifest.subagents ? SUPPRESS_SUBAGENT_PROGRESS : "") +
      (flowStep.requestApproval ? APPROVAL_INSTRUCTION : "") +
      completionSuffix(state.flow_snapshot.strictOutputs ?? true),
    requestApproval: flowStep.requestApproval ?? false,
    approvalManifest: flowStep.requestApproval ? loaded.manifest.approval : undefined,
    attempt: currentWsStep?.attempt ?? 1,
    maxAttempts: flowStep.attempts ?? 1,
    expectedOutputs: loaded.manifest.outputs,
    lastFeedback: currentWsStep?.last_feedback,
    lastError:
      currentWsStep?.result?.result === "error" && currentWsStep.status === "pending"
        ? currentWsStep.result.message
        : undefined,
    model: flowStep.model,
  };

  return instruction;
}

// ============================================================================
// step_complete
// ============================================================================

export interface StepCompleteOptions {
  featurePath?: string;
  agentsDir: string;
}

export interface StepCompleteResult {
  state: WorkflowState;
  featurePath: string;
  action: StepTransition["action"];
  /** Present if action is "gate" — the approval dialog to show */
  gate?: import("../shared/types.ts").WorkflowGate;
  /** Present if action is "block" or there's an error */
  error?: string;
  /** Non-blocking output/artifact checks */
  warnings?: string[];
}

/**
 * Submit a step result (supervisor only).
 *
 * Processes the result and advances the state machine.
 *
 * Returns null if no active workflow found or step index mismatch.
 */
export function stepComplete(
  result: StepResult,
  projectRoot: string,
  options: StepCompleteOptions
): StepCompleteResult | null {
  const { featurePath, agentsDir } = options;
  const resolved = resolveWorkflow(projectRoot, featurePath);
  if (!resolved) return null;

  const { state } = resolved;
  const flowStep = currentStep(state);

  // --- Strict output check (blocks success if declared outputs are missing) ---
  const strictOutputs = state.flow_snapshot.strictOutputs ?? true;
  if (paramsSucceeded(result) && flowStep && strictOutputs) {
    const missing = verifyExpectedOutputs(agentsDir, projectRoot, resolved.featurePath, flowStep.agent);
    if (missing.length > 0) {
      return {
        state,
        featurePath: resolved.featurePath,
        action: "block" as const,
        error: `Strict output check failed:\n${missing.join("\n")}\nComplete the work and write the missing files before calling stepComplete again.`,
        warnings: missing,
      };
    }
  }

  // Non-strict mode: produce warnings only
  const warnings =
    paramsSucceeded(result) && flowStep && !strictOutputs
      ? verifyExpectedOutputs(agentsDir, projectRoot, resolved.featurePath, flowStep.agent)
      : [];

  // Build gate loader bound to the agents directory (cached)
  const loadGate = (agent: string, stepIndex: number): import("../shared/types.ts").WorkflowGate | null => {
    try {
      const loaded = getCachedAgent(agentsDir, agent);
      return buildGate(loaded.manifest, stepIndex);
    } catch {
      return null;
    }
  };

  const transition = applyStepResult(state, result, loadGate);

  // Persist the new state
  writeWorkflow(projectRoot, resolved.featurePath, transition.state);

  return {
    state: transition.state,
    featurePath: resolved.featurePath,
    action: transition.action,
    gate: transition.gate,
    error: transition.error,
    warnings,
  };
}

// ============================================================================
// step_update
// ============================================================================

export interface StepUpdateResult {
  state: WorkflowState;
  featurePath: string;
  error?: string;
}

/** Record incremental activity for the current running step. */
export function stepUpdate(
  update: WorkflowStepUpdate,
  projectRoot: string,
  featurePath?: string
): StepUpdateResult | null {
  const resolved = resolveWorkflow(projectRoot, featurePath);
  if (!resolved) return null;

  const result = updateStepActivity(resolved.state, update);
  if (!result.error) {
    writeWorkflow(projectRoot, resolved.featurePath, result.state);
  }

  return {
    state: result.state,
    featurePath: resolved.featurePath,
    error: result.error,
  };
}

function paramsSucceeded(result: StepResult): boolean {
  return result.result === "success";
}

function verifyExpectedOutputs(
  agentsDir: string,
  projectRoot: string,
  featurePath: string,
  agent: string
): string[] {
  const loaded = getCachedAgent(agentsDir, agent);
  const outputs = loaded.manifest.outputs ?? [];
  if (outputs.length === 0) return [];

  const workflowDir = getWorkflowDir(projectRoot, featurePath);
  return outputs
    .filter((output) => !fs.existsSync(path.join(workflowDir, output)))
    .map((output) => `Expected output missing: ${output}`);
}

// ============================================================================
// record_gate
// ============================================================================

export interface GateResult {
  state: WorkflowState;
  featurePath: string;
  action: GateTransition["action"];
  /** Whether the workflow was aborted via gate */
  aborted?: boolean;
  /** Present when the gate answer could not be applied */
  error?: string;
}

/**
 * Record the user's gate answer.
 *
 * If the user chose advance: true, the flow advances to the next step.
 * If not, the step is reset for re-run.
 *
 * Returns null if no active workflow or step index mismatch.
 */
export function recordGate(
  answer: GateAnswer,
  projectRoot: string,
  featurePath?: string
): GateResult | null {
  const resolved = resolveWorkflow(projectRoot, featurePath);
  if (!resolved) return null;

  const transition = applyGateAnswer(resolved.state, answer);

  // Persist the new state
  writeWorkflow(projectRoot, resolved.featurePath, transition.state);

  return {
    state: transition.state,
    featurePath: resolved.featurePath,
    action: transition.action,
    aborted: transition.action === "abort",
    error: transition.error,
  };
}

// ============================================================================
// status / list
// ============================================================================

/**
 * Get the status of a workflow.
 * Returns null if no workflow found.
 */
export function status(
  projectRoot: string,
  featurePath?: string
): WorkflowState | null {
  const resolved = resolveWorkflow(projectRoot, featurePath);
  return resolved?.state ?? null;
}

/**
 * List all workflow feature paths in a project.
 */
export function list(projectRoot: string): string[] {
  return listWorkflows(projectRoot);
}

// ============================================================================
// abort
// ============================================================================

/**
 * Mark a workflow as abandoned.
 */
export function abort(
  projectRoot: string,
  featurePath?: string
): WorkflowState | null {
  const resolved = resolveWorkflow(projectRoot, featurePath);
  if (!resolved) return null;

  const state = { ...resolved.state, status: "abandoned" as const };
  writeWorkflow(projectRoot, resolved.featurePath, state);
  return state;
}

// ============================================================================
// cleanup
// ============================================================================

/**
 * Remove workflow runs older than the given number of days.
 * Only removes completed, blocked, or abandoned workflows.
 * Active workflows (in_progress, awaiting_user) are preserved.
 *
 * @returns Array of removed feature paths
 */
export function cleanupWorkflows(projectRoot: string, olderThanDays: number): string[] {
  return cleanupPersisted(projectRoot, olderThanDays);
}

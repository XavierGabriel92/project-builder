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
import {
  loadAgent,
  loadFlowAgents,
  validateFlowApproval,
  buildGate,
} from "./agent-loader.ts";

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

const COMPLETION_SUFFIX =
  "\n\n## Completion\n\n" +
  "When you have finished all the work described above, stop. " +
  "Do not ask what to do next. Do not offer to continue. " +
  "The workflow will advance automatically.";

const SUBAGENT_COMPLETION_SUFFIX =
  "\n\n## Completion\n\n" +
  "When you have finished, stop. Return your results to the orchestrator. " +
  "Do not ask questions or offer to continue.";

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

  // Load agent manifest
  const loaded = loadAgent(agentsDir, flowStep.agent);
  const subagentInstructions = loaded.manifest.subagents
    ? Object.fromEntries(
        Object.entries(loaded.manifest.subagents).map(([name, relativePath]) => {
          const subagent = loadAgent(agentsDir, relativePath, true);
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
      COMPLETION_SUFFIX,
    requestApproval: flowStep.requestApproval ?? false,
    attempt: currentWsStep?.attempt ?? 1,
    maxAttempts: flowStep.attempts ?? 1,
    expectedOutputs: loaded.manifest.outputs,
    lastFeedback: currentWsStep?.last_feedback,
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
  const warnings =
    paramsSucceeded(result) && flowStep
      ? verifyExpectedOutputs(agentsDir, projectRoot, resolved.featurePath, flowStep.agent)
      : [];

  // Build gate loader bound to the agents directory
  const loadGate = (agent: string, stepIndex: number): import("../shared/types.ts").WorkflowGate | null => {
    try {
      const loaded = loadAgent(agentsDir, agent);
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
  const loaded = loadAgent(agentsDir, agent);
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

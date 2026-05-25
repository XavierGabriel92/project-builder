/**
 * Flow Orchestrator Engine
 *
 * Domain-agnostic engine that advances through flow steps based on
 * supervisor-submitted step-results and user gate answers.
 *
 * API (see §12 of rfc.md):
 *   start(flow, featureName, projectRoot) → WorkflowState
 *   step(featurePath?, projectRoot) → StepInstruction
 *   step_complete(result, featurePath?, projectRoot) → StepTransitionResult
 *   record_gate(answer, featurePath?, projectRoot) → GateTransitionResult
 *   status(featurePath?, projectRoot) → WorkflowState | null
 *   list(projectRoot) → string[]
 */

import {
  type FlowDefinition,
  type GateAnswer,
  type StepInstruction,
  type StepResult,
  type WorkflowState,
  type WorkflowGate,
} from "../shared/types.ts";
import {
  resolveFeaturePath,
  writeWorkflow,
  listWorkflows,
  resolveWorkflow,
} from "../shared/persistence.ts";
import {
  createWorkflowState,
  startStep,
  applyStepResult,
  applyGateAnswer,
  currentStep,
  currentWorkflowStep,
  type StepTransition,
  type GateTransition,
} from "./transitions.ts";
import {
  loadAgent,
  validateFlowApproval,
  buildGate,
} from "./agent-loader.ts";

// ============================================================================
// Engine State
// ============================================================================

/** The agents directory — set by the extension entry point at init */
let _agentsDir = "";

/** Initialize the engine with the path to the agents/ directory */
export function initEngine(agentsDir: string): void {
  _agentsDir = agentsDir;
}

function agentsDir(): string {
  if (!_agentsDir) {
    throw new Error(
      "Engine not initialized. Call initEngine(agentsDir) before using engine functions."
    );
  }
  return _agentsDir;
}

// ============================================================================
// start
// ============================================================================

export interface StartResult {
  state: WorkflowState;
  featurePath: string;
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
  serviceDirs?: string[]
): StartResult {
  // Validate that requestApproval steps have approval blocks
  validateFlowApproval(agentsDir(), flow);

  const featurePath = resolveFeaturePath(featureName, projectRoot);
  const state = createWorkflowState(flow, featureName, featurePath, projectRoot, serviceDirs);

  writeWorkflow(projectRoot, featurePath, state);

  return { state, featurePath };
}

// ============================================================================
// step
// ============================================================================

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
  featurePath?: string
): StepInstruction | null {
  const resolved = resolveWorkflow(projectRoot, featurePath);
  if (!resolved) return null;

  let { state } = resolved;

  const flowStep = currentStep(state);
  if (!flowStep) return null; // No more steps

  // Mark step as running and persist
  state = startStep(state);
  writeWorkflow(projectRoot, resolved.featurePath, state);

  // Load agent manifest
  const loaded = loadAgent(agentsDir(), flowStep.agent);

  // Build instruction
  const instruction: StepInstruction = {
    agent: flowStep.agent,
    stepIndex: state.current_step_index,
    tools: loaded.manifest.tools,
    subagents: loaded.manifest.subagents,
    parallel: loaded.manifest.parallel,
    prompt: loaded.prompt,
    requestApproval: flowStep.requestApproval ?? false,
    attempt: currentWorkflowStep(state)?.attempt ?? 1,
    maxAttempts: flowStep.attempts ?? 1,
    expectedOutputs: loaded.manifest.outputs,
  };

  return instruction;
}

// ============================================================================
// step_complete
// ============================================================================

export interface StepCompleteResult {
  state: WorkflowState;
  featurePath: string;
  action: StepTransition["action"];
  /** Present if action is "gate" — the approval dialog to show */
  gate?: WorkflowGate;
  /** Present if action is "block" or there's an error */
  error?: string;
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
  featurePath?: string
): StepCompleteResult | null {
  const resolved = resolveWorkflow(projectRoot, featurePath);
  if (!resolved) return null;

  const { state } = resolved;

  // Build gate loader bound to the agents directory
  const loadGate = (agent: string, stepIndex: number): WorkflowGate | null => {
    try {
      const loaded = loadAgent(agentsDir(), agent);
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
  };
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

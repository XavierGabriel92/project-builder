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
import { discoverProjectRules } from "./project-rules.ts";

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

function workspacePrefix(
  featurePath: string,
  featureContext?: string,
  projectRulesContext?: string
): string {
  let prefix = "## Workspace\n\n" +
    "Your declared output files MUST be written to .temp/" + featurePath + "/. " +
    "Always write .temp/" + featurePath + "/plan.md, NOT plan.md. " +
    "If the instructions below explicitly tell you to write files directly to the project tree, follow those instructions.\n";

  // Project rules (auto-discovered) — injected before feature context
  // since rules apply to all steps and features
  if (projectRulesContext) {
    prefix +=
      "\n## Project Rules\n\n" +
      "The following rules, conventions, and architectural constraints were " +
      "discovered from the project. Follow them for every change you make.\n\n" +
      projectRulesContext + "\n";
  }

  if (featureContext) {
    prefix +=
      "\n## Feature Context\n\n" +
      "The user provided this description of what they want to build:\n\n" +
      featureContext + "\n";
  }

  return prefix;
}

/**
 * Build a digest of all previously completed steps from activity.message fields.
 * Injected into every agent prompt so agents don't need to read every previous file.
 */
function previousStepsDigest(state: WorkflowState): string {
  const completed = state.steps.filter(
    (s) => s.status === "completed" && s.activity?.message
  );
  if (completed.length === 0) return "";

  const lines: string[] = [
    "## Previous Steps\n",
    "These steps have already been completed. The summaries below provide enough " +
    "context that you do NOT need to read their output files unless you need " +
    "specific details beyond what is summarized here.\n",
  ];

  for (const step of completed) {
    const msg = step.activity!.message!;
    // Truncate long messages to ~300 chars to keep prompts lean
    const short = msg.length > 300 ? msg.slice(0, 297) + "..." : msg;
    lines.push("- **" + step.agent + "** (completed): " + short);
  }

  return lines.join("\n") + "\n";
}

function completionSuffix(strictOutputs: boolean): string {
  const blockMsg = strictOutputs
    ? "If you do not write them, the workflow will block."
    : "If you do not write them, warnings will appear when you complete the step.";

  return (
    "\n\n## Important\n\n" +
    "Follow the instructions above carefully. Do not skip steps or complete this step " +
    "without doing the work described. The workflow expects the declared output files " +
    "to exist. " + blockMsg + "\n\n" +
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
  "You MUST follow this exact protocol:\n\n" +
  "### Protocol\n\n" +
  "1. Call `flow_continue` to see the full gate details.\n" +
  "2. Use `ask_user_question` to present the gate options to the user.\n" +
  "3. **After the user answers, IMMEDIATELY call `flow_record_gate`.**\n" +
  "   - Do NOT read files, write files, make edits, or do any other work.\n" +
  "   - Do NOT refine your output based on the user's feedback.\n" +
  "   - The user's answer IS the decision — record it NOW.\n" +
  "4. Use the **EXACT option label** from the gate options — do NOT add " +
  "any suffix like \"(Recommended)\" to the label.\n" +
  "5. If the user chose a \"Request changes\" / \"Refine\" option, " +
  "include their feedback as the `feedback` argument. " +
  "The workflow will retry the step with the feedback.\n\n" +
  "### Never\n\n" +
  "- Do NOT do any work between the `ask_user_question` answer and `flow_record_gate`.\n" +
  "- Do NOT add \"(Recommended)\" or any suffix to gate option labels.\n" +
  "- Do NOT call `flow_record_gate` without the user's explicit choice " +
  "(unless they gave a standing instruction to auto-approve).\n\n" +
  "If the user has given you general instructions to proceed without asking " +
  "(e.g., \"do not ask questions, keep going\"), you may auto-answer the gate. " +
  "Otherwise, always ask first.";

const SUBAGENT_COMPLETION_SUFFIX =
  "\n\n## Completion\n\n" +
  "When you have finished, stop. Return your results to the orchestrator. " +
  "Do not ask questions or offer to continue.";

const SUPPRESS_SUBAGENT_PROGRESS =
  "\n\n## Subagent Behavior — Output & Progress Configuration\n\n" +
  "These constraints apply to the `subagent` tool's `output` and `progress` parameters ONLY. " +
  "Worker subagents themselves use `write`/`edit` to modify project source files normally.\n\n" +
  "### When using the `tasks` array (parallel dispatch):\n" +
  "- Do NOT set `output` on any task object — omit it entirely\n" +
  "- Do NOT set `progress: true` on any task object — the engine defaults to `false`; do not override\n\n" +
  "### When using single-agent mode:\n" +
  "- Do NOT set the top-level `output` parameter\n" +
  "- Do NOT set `includeProgress: true`\n\n" +
  "### Rationale\n" +
  "Your own output files (like implementation-notes.md) belong under .temp/. " +
  "Subagent output files and progress.md clutter the workspace and are never consumed by downstream steps. " +
  "Worker subagents return results inline in the response.";

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
      errors.push("Flow \"" + flow.id + "\": " + (err as Error).message);
    }
  }

  if (errors.length > 0) {
    throw new Error("Flow validation failed:\n" + errors.map(function(e) { return "  - " + e; }).join("\n"));
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
  /** Open-text user description of what they want to build (collected at UI start). */
  featureContext?: string;
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
  const { serviceDirs, featureContext, agentsDir } = options;

  // Validate that requestApproval steps have approval blocks
  validateFlowApproval(agentsDir, flow);

  // Auto-discover project rules (AGENTS.md, docs/, README.md)
  const projectRulesContext = discoverProjectRules(projectRoot);

  const featurePath = resolveFeaturePath(featureName, projectRoot);
  const state = createWorkflowState(
    flow, featureName, featurePath, projectRoot,
    serviceDirs, featureContext, projectRulesContext
  );

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
  const featureContext = resolved.state.feature_context;
  const projectRulesContext = resolved.state.project_rules_context;
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
                workspacePrefix(resolved.featurePath, featureContext, projectRulesContext) +
                "\n\n" +
                previousStepsDigest(state) +
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
      workspacePrefix(resolved.featurePath, featureContext, projectRulesContext) +
      "\n\n" +
      previousStepsDigest(state) +
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
        error: "Strict output check failed:\n" + missing.join("\n") + "\nComplete the work and write the missing files before calling stepComplete again.",
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
    .map(function(output) { return "Expected output missing: " + output; });
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

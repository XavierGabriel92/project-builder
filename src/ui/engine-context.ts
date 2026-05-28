/**
 * Engine Context
 *
 * Central module that owns the engine lifecycle for the UI layer.
 * Resolves agentsDir (configurable, defaults to {projectRoot}/agents or
 * the built-in reference agents in project-builder) and provides
 * convenience wrappers for tool execute bodies.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateFlows,
  start,
  step,
  stepComplete,
  stepUpdate,
  recordGate,
  status,
  abort,
  list,
  cleanupWorkflows,
  type StartOptions,
  type StepOptions,
  type StepCompleteOptions,
  type StepCompleteResult,
} from "../engine/engine.ts";
import type { FlowDefinition } from "../shared/types.ts";

/** Resolve this file's directory for relative path resolution */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve agentsDir for a given project root */
export function resolveAgentsDir(projectRoot: string, agentsDir?: string): string {
  if (agentsDir) return path.resolve(agentsDir);

  // Check for project-level agents dir first
  const projectAgents = path.join(projectRoot, "agents");
  if (fs.existsSync(projectAgents)) return projectAgents;

  // Built-in reference agents
  const builtinAgents = path.resolve(__dirname, "../../agents");
  return builtinAgents;
}

export interface EngineContext {
  agentsDir: string;
  validateFlows: (flows: FlowDefinition[]) => void;
  start: (flow: FlowDefinition, featureName: string, projectRoot: string, opts?: Partial<Omit<StartOptions, "agentsDir">>) => ReturnType<typeof start>;
  step: (projectRoot: string, opts?: Partial<Omit<StepOptions, "agentsDir">>) => ReturnType<typeof step>;
  stepComplete: (result: Parameters<typeof stepComplete>[0], projectRoot: string, opts?: Partial<Omit<StepCompleteOptions, "agentsDir">>) => StepCompleteResult | null;
  stepUpdate: typeof stepUpdate;
  recordGate: typeof recordGate;
  status: typeof status;
  abort: typeof abort;
  list: typeof list;
  cleanupWorkflows: (projectRoot: string, olderThanDays: number) => string[];
}

export function createEngineContext(agentsDir: string): EngineContext {
  return {
    agentsDir,
    validateFlows: (flows) => validateFlows(flows, agentsDir),
    start: (flow, featureName, projectRoot, opts) =>
      start(flow, featureName, projectRoot, { ...opts, agentsDir }),
    step: (projectRoot, opts) =>
      step(projectRoot, { ...opts, agentsDir }),
    stepComplete: (result, projectRoot, opts) =>
      stepComplete(result, projectRoot, { ...opts, agentsDir }),
    stepUpdate,
    recordGate,
    status,
    abort,
    list,
    cleanupWorkflows,
  };
}

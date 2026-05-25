/**
 * Persistence utilities for workflow.json
 *
 * Workflows live under {PROJECT_ROOT}/.temp/{featurePath}/workflow.json
 * All writes are atomic (temp file → rename).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_DIR, WORKFLOW_FILE, type WorkflowState } from "./types.ts";

/**
 * Generate a feature path from a feature name.
 * Format: DD-MM-YYYY-{slug}
 * Optionally creates the directory under projectRoot/.temp/
 */
export function resolveFeaturePath(featureName: string, projectRoot?: string): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();

  const slug = featureName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

  return `${dd}-${mm}-${yyyy}-${slug}`;
}

/**
 * Get the full path to a workflow's directory.
 */
export function getWorkflowDir(projectRoot: string, featurePath: string): string {
  return path.join(projectRoot, TEMP_DIR, featurePath);
}

/**
 * Get the full path to a workflow.json file.
 */
export function getWorkflowPath(projectRoot: string, featurePath: string): string {
  return path.join(getWorkflowDir(projectRoot, featurePath), WORKFLOW_FILE);
}

/**
 * Read a workflow.json file.
 * Returns null if the file doesn't exist.
 */
export function readWorkflow(
  projectRoot: string,
  featurePath: string
): WorkflowState | null {
  const filePath = getWorkflowPath(projectRoot, featurePath);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as WorkflowState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write a workflow.json file atomically.
 * Creates the directory tree if it doesn't exist.
 */
export function writeWorkflow(
  projectRoot: string,
  featurePath: string,
  state: WorkflowState
): void {
  const dir = getWorkflowDir(projectRoot, featurePath);
  const filePath = path.join(dir, WORKFLOW_FILE);
  const tmpPath = path.join(dir, `.${WORKFLOW_FILE}.tmp`);

  fs.mkdirSync(dir, { recursive: true });

  const json = JSON.stringify(state, null, 2);

  // Atomic write: write to temp, then rename
  fs.writeFileSync(tmpPath, json, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * List all workflow feature paths in a project.
 */
export function listWorkflows(projectRoot: string): string[] {
  const tempDir = path.join(projectRoot, TEMP_DIR);
  try {
    if (!fs.existsSync(tempDir)) return [];
    return fs
      .readdirSync(tempDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const wfPath = path.join(tempDir, entry.name, WORKFLOW_FILE);
        return fs.existsSync(wfPath);
      })
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find an active (in_progress or awaiting_user) workflow in a project.
 * Returns the first one found, or null.
 */
export function findActiveWorkflow(projectRoot: string): {
  featurePath: string;
  state: WorkflowState;
} | null {
  const paths = listWorkflows(projectRoot);
  for (const fp of paths) {
    const state = readWorkflow(projectRoot, fp);
    if (state && (state.status === "in_progress" || state.status === "awaiting_user")) {
      return { featurePath: fp, state };
    }
  }
  return null;
}

/**
 * Resolve the active workflow if featurePath is not specified.
 * Returns null if no featurePath specified and no active workflow found.
 */
export function resolveWorkflow(
  projectRoot: string,
  featurePath?: string
): { featurePath: string; state: WorkflowState } | null {
  if (featurePath) {
    const state = readWorkflow(projectRoot, featurePath);
    if (!state) return null;
    return { featurePath, state };
  }
  return findActiveWorkflow(projectRoot);
}

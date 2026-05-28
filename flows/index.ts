/**
 * Shared flow definitions.
 *
 * Single source of truth for the feature-build pipeline and any other
 * reusable flow definitions. Import from here instead of hardcoding.
 */

import type { FlowDefinition } from "../src/shared/types.ts";

/**
 * The built-in 10-step feature-build pipeline.
 *
 * Steps:
 *   gather-input (gate) → discover → clarify (gate) → spec-write (gate) →
 *   research (gate) → plan (gate, 2 attempts) → implement (2 attempts) →
 *   review → doc-sync → complete
 */
export const FEATURE_BUILD_FLOW: FlowDefinition = {
  id: "feature-build",
  version: 1,
  description: "Full product feature build from input gathering to completion docs",
  strictOutputs: false,
  steps: [
    { agent: "gather-input", requestApproval: true },
    { agent: "discover" },
    { agent: "clarify", requestApproval: true },
    { agent: "spec-write", requestApproval: true },
    { agent: "research", requestApproval: true },
    { agent: "plan", requestApproval: true, attempts: 2 },
    { agent: "implement", attempts: 2 },
    { agent: "review" },
    { agent: "doc-sync" },
    { agent: "complete" },
  ],
};

/** All flows registered in this package. */
export const allFlows: FlowDefinition[] = [FEATURE_BUILD_FLOW];

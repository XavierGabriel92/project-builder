/**
 * Shared flow definitions.
 *
 * Single source of truth for the feature-build pipeline and any other
 * reusable flow definitions. Import from here instead of hardcoding.
 */

import type { FlowDefinition } from "../src/shared/types.ts";

/**
 * The built-in 8-step feature-build pipeline.
 *
 * gather-input (gate) → discover → spec-write (gate) → plan →
 * implement (2 attempts) → review (gate) → doc-sync → complete (gate)
 *
 * Merges: clarify into discover, research into spec-write.
 * Enhanced: implement uses task-based worker fan-out.
 */
export const FEATURE_BUILD_FLOW: FlowDefinition = {
  id: "feature-build",
  version: 2,
  description: "Full product feature build from input gathering to completion docs",
  steps: [
    { agent: "gather-input", requestApproval: true },
    { agent: "discover" },
    { agent: "spec-write", requestApproval: true },
    { agent: "plan" },
    { agent: "implement", attempts: 2 },
    { agent: "review", requestApproval: true },
    { agent: "doc-sync" },
    { agent: "complete" },
  ],
};

/**
 * The built-in 6-step bug-fix pipeline.
 *
 * triage (gate) → reproduce → diagnose → fix (2 attempts) → verify (gate) → complete (gate)
 *
 * Optimized for diagnosing and fixing bugs — narrower scope, reproduction-first,
 * root-cause-driven. No spec-writing, no plan, no doc-sync.
 */
export const BUG_FIX_FLOW: FlowDefinition = {
  id: "bug-fix",
  version: 1,
  description: "Bug diagnosis and fix from issue triage to verified resolution",
  steps: [
    { agent: "triage", requestApproval: true },
    { agent: "reproduce" },
    { agent: "diagnose" },
    { agent: "fix", attempts: 2 },
    { agent: "verify", requestApproval: true },
    { agent: "complete" },
  ],
};

/** All flows registered in this package. */
export const allFlows: FlowDefinition[] = [FEATURE_BUILD_FLOW, BUG_FIX_FLOW];

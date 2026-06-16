/**
 * Shared flow definitions.
 *
 * Single source of truth for all pipelines. Import from here instead of hardcoding.
 */

import type { FlowDefinition } from "../src/shared/types.ts";

/**
 * The built-in 7-step feature-build pipeline.
 *
 * spec-write (gate) → plan → implement (2 attempts) →
 * review (gate) → lint → doc-sync (2 attempts) → complete (gate)
 *
 * spec-write merges: analysis + specification into a single step producing spec.md.
 * implement uses task-based worker fan-out.
 * doc-sync audits existing reference docs and writes audit report.
 * complete writes summary files to .temp/ (engine-validated) and reference
 *   docs directly to the project tree (feature-summary, learnings, maintenance).
 */
export const FEATURE_BUILD_FLOW: FlowDefinition = {
  id: "feature-build",
  version: 6,
  description: "Full product feature build from specification to completion docs",
  steps: [
    { agent: "spec-write", requestApproval: true },
    { agent: "plan" },
    { agent: "implement", attempts: 2 },
    { agent: "review", requestApproval: true },
    { agent: "lint" },
    { agent: "doc-sync", attempts: 2 },
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

/**
 * The built-in 5-step small-feature pipeline.
 *
 * spec-write (gate) → implement (2 attempts) → review (gate) → lint → complete (gate)
 *
 * For well-scoped features: ≤10 files to change, no new dependencies,
 * no architecture changes. Skips plan (no architectural decisions needed)
 * and doc-sync (minimal doc impact — complete handles the essentials).
 * The spec-write agent's complexity assessment classifies features and
 * suggests this flow for Quick-scope changes.
 */
export const SMALL_FEATURE_FLOW: FlowDefinition = {
  id: "small-feature",
  version: 2,
  description: "Small feature — ≤10 files, no new deps, no architecture changes",
  steps: [
    { agent: "spec-write", requestApproval: true },
    { agent: "implement", attempts: 2 },
    { agent: "review", requestApproval: true },
    { agent: "lint" },
    { agent: "complete" },
  ],
};

/** All flows registered in this package. */
export const allFlows: FlowDefinition[] = [FEATURE_BUILD_FLOW, BUG_FIX_FLOW, SMALL_FEATURE_FLOW];

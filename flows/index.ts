import type { FlowDefinition } from "../src/shared/types.ts";

/**
 * Full product feature build pipeline.
 *
 * This is one example use of the engine - the engine itself
 * knows nothing about "specs", "plans", or "implementation".
 * It just runs agents in order and gates when told.
 */
export const featureBuild: FlowDefinition = {
  id: "feature-build",
  version: 2,
  description: "Full product build with discovery, clarification, research, implementation, review, and documentation",
  steps: [
    { agent: "gather-input", requestApproval: true },
    { agent: "discover" },
    // { agent: "clarify", requestApproval: true },
    { agent: "spec-write", requestApproval: true },
    { agent: "research"  },
    { agent: "plan"},
    { agent: "implement", attempts: 3 },
    { agent: "review", requestApproval: true },
    { agent: "doc-sync" },
    { agent: "complete" },
  ],
};

export const allFlows: FlowDefinition[] = [featureBuild];

# RFC: Declarative generic flow engine

**Status:** Draft (decisions locked — pending implementation)  
**Location:** `~/.pi/agent/extensions/project-builder/rfc.md`  
**Scope:** Generic flow orchestration engine; not coupled to any specific use case

---

## 1. Summary

A **generic, declarative flow engine** (no opinions about "what kind of steps"). It runs an ordered list of steps; each step points to an agent `.md` that declares its own tools, subagents, parallelism, and approval dialog.

Three layers:

1. **`flows/*.ts`** inside the extension — ordered steps: which agent, retries, whether user approval is needed after the step.
2. **`agents/*.md`** — self-contained step contract: tools, subagents, parallel, approval UI, prompt.
3. **Thin orchestrator** — advances step by step when the **supervisor** submits `step-result` (`success` | `error`).

**Flows say *when* (order + retries + approval flag). Agents say *everything else*.**

---

## 2. Problem (today)

| Issue | Where it shows up |
|--------|-------------------|
| Phase order not in one file | `runner.ts` switches |
| Behavior duplicated | `SKILL.md` vs `handlers/phase*.ts` |
| Engine coupled to "coding a feature" | Gate kinds (`spec`, `plan`) hardcoded in runner |
| Hard to reuse for a different workflow | All of the above |

---

## 3. Goals

- **G1** — Reorder pipeline by editing `flows/*.ts` only.
- **G2** — Multiple flows; engine doesn't care what they do.
- **G3** — Tools, subagents, parallel, **approval UI** all on agent `.md`.
- **G4** — Subagents via Pi `subagent` tool (swappable later without changing flow).
- **G5** — Supervisor-only `step-result`; orchestrator never trusts subagent output directly.
- **G6** — `requestApproval` is a **boolean flag** on the flow step. The agent decides *what* to ask.

## 4. Non-goals (v1)

- Skip steps, `when` conditions, flow overrides.
- `pending` / async step state in the orchestrator.
- `ask_user_question` on subagents.
- Per-repo flow overrides (flows live in extension only).
- Changing flow definition mid-run.

---

## 5. Layout (extension package)

```text
~/.pi/agent/extensions/project-builder/
  flows/
    feature-build.ts        # one example flow
    some-other-workflow.ts  # totally different domain
  agents/
    gather-input.md
    discover.md
    implement.md
    …
    subagents/
      worker.md
      spec-writer.md
      …
  orchestrator/
    engine.ts
    step-result.schema.ts
    transitions.ts
  extension/
  rfc.md
```

**Runtime artifacts (repo under work):**

```text
{PROJECT_ROOT}/.temp/DD-MM-YYYY-feature-name/
  workflow.json          # frozen flow + per-step results (see §10)
```

---

## 6. Separation: flow vs agent

| Concern | **Flow step** | **Agent `.md`** |
|---------|---------------|-----------------|
| Order in pipeline | ✓ | |
| `requestApproval` after step succeeds | ✓ (boolean flag) | |
| `attempts` (auto-retry on error) | ✓ | |
| Agent to run | ✓ (`agent` id) | |
| Tools allowed | | ✓ |
| Subagents map | | ✓ |
| Parallel (fan-out via subagent tool) | | ✓ |
| **Approval UI** (header, preview, options) | | ✓ |
| Prompt / behavior | | ✓ body |

Engine is **agnostic** about what the step does — it just runs the agent, collects `success`/`error`, and asks the user when `requestApproval` is true.

---

## 7. Flow config (`flows/*.ts`)

All flow definitions live **inside the extension** (not per-repo). The engine is generic — you can define any sequence of agents.

```typescript
export type FlowStep = {
  /** Defaults to agent id; used in workflow.steps[].id */
  id?: string;

  /** → agents/{agent}.md */
  agent: string;

  /** After supervisor submits "success", pause for user approval */
  requestApproval?: boolean;

  /** Auto-retry on error until exhausted (default 1) */
  attempts?: number;
};

export type FlowDefinition = {
  id: string;
  version: number;
  description: string;
  steps: FlowStep[];
};
```

No `approvalGate`, no domain-specific enums. The flow says **"approval needed: yes/no"** — the agent `.md` owns the dialog.

### Example — `feature-build`

```typescript
export const featureBuild: FlowDefinition = {
  id: "feature-build",
  version: 1,
  description: "Full product build (one example use of the engine)",
  steps: [
    { agent: "gather-input", requestApproval: true },
    { agent: "discover", requestApproval: true },
    { agent: "clarify" },
    { agent: "spec-write", requestApproval: true },
    { agent: "research" },
    { agent: "plan", requestApproval: true },
    { agent: "implement", attempts: 2 },
    { agent: "review", requestApproval: true },
    { agent: "doc-sync" },
    { agent: "complete" },
  ],
};
```

The flow is just a list of agent names + approval flag — nothing domain-specific.

### Example — hypothetical totally different flow

```typescript
export const deployPipeline: FlowDefinition = {
  id: "deploy-pipeline",
  version: 1,
  description: "CI/CD style pipeline",
  steps: [
    { agent: "run-tests", attempts: 3 },
    { agent: "build-artifacts" },
    { agent: "deploy-staging", requestApproval: true },
    { agent: "smoke-tests", attempts: 2 },
    { agent: "deploy-prod", requestApproval: true },
  ],
};
```

Same engine, completely different domain. Agents define what each step means.

---

## 8. Agent definitions (`agents/*.md`)

Each `.md` file is a **self-describing step** — nothing domain-specific in the engine.

### Agent manifest

```typescript
export type AgentManifest = {
  id: string;
  version: number;

  /** Main agents only */
  tools: Array<
    | "subagent"
    | "ask_user_question"
    | "read"
    | "write"
    | "bash"
  >;

  subagents?: Record<string, string>;

  /** Fan-out: main agent calls Pi subagent tool */
  parallel?: {
    over: "service_dirs";
    subagent: string;
    concurrency?: number;
  };

  outputs?: string[];

  /**
   * If the flow step has requestApproval: true, the orchestrator will
   * present this dialog after the supervisor submits "success".
   * The agent owns what "approval" means for this step.
   */
  approval?: {
    /** Shown as the question header (e.g. "Spec review") */
    header: string;
    /** Optional: path to an artifact to show as preview (relative to feature path) */
    preview?: string;
    /** Options presented to the user */
    options: Array<{
      label: string;
      description: string;
      /** Which option means "approved" → advance to next step */
      advance: boolean;
    }>;
  };
};
```

### Subagent `.md`

- Prompt + optional `tools` (no `ask_user_question`, no `subagent` by default).
- No `step-result` — parent step is not finished until supervisor says so.
- No `approval` — only main agents gate the flow.

### Example — `agents/spec-write.md`

```yaml
---
id: spec-write
version: 1
tools:
  - read
  - write
approval:
  header: "Spec"
  preview: "spec.md"
  options:
    - label: "Approve"
      description: "Proceed with this specification"
      advance: true
    - label: "Request changes"
      description: "Revise before continuing"
      advance: false
    - label: "Exit"
      description: "Stop the workflow"
      advance: false
---
```

Write the feature specification. Save to `spec.md`. When done, the supervisor will submit `step-result: success`.

### Example — `agents/implement.md`

```yaml
---
id: implement
version: 1
tools:
  - subagent
  - read
  - write
subagents:
  worker: subagents/worker.md
parallel:
  over: service_dirs
  subagent: worker
  concurrency: 4
---
```

No `approval` — implementation doesn't require user gate in the current flow. If a different flow wanted a gate after implement, the same agent `.md` would work (just add `requestApproval: true` on the flow step and add `approval:` to the manifest).

### Example — `agents/deploy-prod.md` (hypothetical)

```yaml
---
id: deploy-prod
version: 1
tools:
  - bash
approval:
  header: "Deploy"
  preview: ""
  options:
    - label: "Deploy to production"
      description: "Ship it"
      advance: true
    - label: "Cancel"
      description: "Abort deploy"
      advance: false
---
```

---

## 9. Step result (supervisor only)

Only the **supervisor** writes step results. Subagents return text to the supervisor.

```json
{
  "result": "success",
  "message": "Human-readable summary"
}
```

```json
{
  "result": "error",
  "message": "What failed",
  "retryable": true
}
```

**No `pending`.** Orchestrator advances only on `success` (and optional user approval).

### 9.1 Approval timing (post-run only in v1)

`requestApproval` fires **after** the agent has run and the supervisor submitted `success`. The agent's work is done; the gate is "do you accept these results?"

**Why not pre-run?** A "should we run this?" gate (e.g. "Run review or skip?") would require the engine to present a dialog *before* running the agent, then conditionally skip. That adds a `gateBefore` flag — deferred to **v2** if needed.

**In v1, if you want a pre-run choice**, split into two steps:

```typescript
{ agent: "review-gate", requestApproval: true },  // asks: Run review or skip?
{ agent: "review" },                                // only runs if gate answer was "run"
```

The `review-gate` agent is thin — it only calls `ask_user_question` and returns `success`. If the user picks "skip", the supervisor sets `step-result: success` and the engine advances. If "run", the next step executes normally.

### 9.2 Validation: missing `approval` block

When a flow step has `requestApproval: true` but the agent `.md` has no `approval:` block, the engine **rejects at `start`** time with a clear error:

> `step "review" requires user approval (requestApproval: true) but agent "review" has no approval block`

This fails fast rather than falling back to a generic dialog that the agent author didn't intend. If the author wants a generic gate, they add an explicit `approval:` block.

### Orchestrator rules

| `result` | Behavior |
|----------|----------|
| `success` | If flow step has `requestApproval` → load agent's `approval` manifest, present gate to user (supervisor runs `ask_user_question`). On `advance: true` → next step. On `advance: false` → retry same step or `error` per supervisor policy. |
| `error` | If `attempts` remaining → same step again. Else `build_status: BLOCKED`. |

---

## 10. `workflow.json` (frozen run state)

On **`start`**:

1. Resolve `featurePath` = `DD-MM-YYYY-{slug}`.
2. Copy **full flow definition** into `workflow.json` (`flow_snapshot`) — frozen for this run.
3. Initialize `steps[]` — one per flow step, status `pending`.

```typescript
export type WorkflowState = {
  schema_version: number;
  feature: string;
  feature_path: string;
  project_root: string;
  flow_id: string;
  flow_version: number;
  flow_snapshot: FlowDefinition;
  current_step_index: number;
  status: "in_progress" | "blocked" | "awaiting_user" | "abandoned" | "done";
  awaiting: null | "user_gate";
  gate?: {
    /** From agent approval.header */
    header: string;
    /** From agent approval.preview */
    preview?: string;
    /** From agent approval.options */
    options: Array<{ label: string; description: string; advance: boolean }>;
    stepIndex: number;
  };
  steps: Array<{
    index: number;
    id: string;
    agent: string;
    status: "pending" | "running" | "completed" | "failed";
    result?: { result: "success" | "error"; message: string; retryable?: boolean };
    attempt: number;
    started_at?: string;
    completed_at?: string;
  }>;
  service_dirs?: string[];
  build_status?: "DONE" | "BLOCKED" | null;
};
```

---

## 11. Orchestrator loop

```text
start(flowId, featureName, …)
  → write workflow.json with frozen flow_snapshot + steps[]

step()
  → load flow_snapshot.steps[current_step_index]
  → load agents/{agent}.md manifest
  → return StepInstruction to supervisor (tools, parallel, subagents, approval, prompt, context)

step_complete({ result, message })   // supervisor only
  → write steps[i].result
  → if error: retry if attempts left
  → if success && step.requestApproval:
      awaiting = user_gate
      gate = { header, preview, options } from agent.approval
  → else: current_step_index++

record_gate(answers)
  → if user picked advance: true (per agent's approval.options) → advance index
  → else: supervisor decides (re-run / block / request changes)
```

**Engine is domain-agnostic:** it loads the agent, runs it, collects result, gates if flag is set. What the agent does is entirely defined by its `.md`.

---

## 12. Tool API

| Action | Purpose |
|--------|---------|
| `list` / `status` | Inspect `.temp/*/workflow.json` |
| `start` | `flow` + feature input → create `workflow.json` + frozen `flow_snapshot` |
| `step` | Current `StepInstruction` from agent manifest |
| `step_complete` | Supervisor submits `success` \| `error` |
| `record_gate` | After `ask_user_question` when `requestApproval` |

No orchestration-level knowledge of what a step does.

---

## 13. Locked decisions (2026-05-24)

| # | Decision |
|---|----------|
| 1 | **Approval:** `requestApproval` flag on flow step; agent `.md` owns the approval dialog |
| 2 | **step-result:** supervisor only |
| 3 | **Parallel:** agent calls Pi `subagent`; config in agent `.md` |
| 4 | **Flow location:** extension package only |
| 5 | **Flow versioning:** snapshot at `start`; never changes mid-run; results stored per step in `workflow.json` |
| 6 | **Retries:** auto-retry on `error` using flow step `attempts` |
| 7 | **Results:** `success` \| `error` only |
| 8 | **Tools:** `ask_user_question` on main agents only, never subagents |
| 9 | **Removed:** `async`, `overrides`, `when`, skip, `pending` |
| 10 | **Engine is generic:** no domain-specific enums or gate kinds — all behavior from `.md` |
| 11 | **Approval timing:** post-run only in v1 (`gateBefore` deferred); pre-run choice via two-step pattern (gate agent → work agent) |
| 12 | **Missing `approval` block:** engine rejects at `start` — no silent fallback |

---

## 14. Phased rollout

| Phase | Deliverable |
|-------|-------------|
| R0 | RFC agreed |
| R1 | `flow_snapshot` + slim `FlowStep`; adapter from old handlers |
| R2 | Agent `.md` loader + `step_complete` |
| R3 | Replace handler switches; migrate `feature-build` flow |
| R4 | Second flow proves domain-agnostic reorder |

---

## 15. Success criteria

- Reorder pipeline → edit `flows/*.ts` only.
- Change tools/parallel/subagents/approval → edit `agents/*.md` only.
- One transition module; no `phase`/`stage` switches.
- Same engine runs `feature-build` and a hypothetical `deploy-pipeline` without code changes.
- Unit tests: mock supervisor `step_complete` walks any frozen `flow_snapshot`.

---

## 16. Changelog

| Date | Change |
|------|--------|
| 2026-05-24 | Initial draft |
| 2026-05-24 | Tools/parallel/subagents on agent manifest |
| 2026-05-24 | Locked decisions §13; frozen flow snapshot; removed async/overrides/when/pending |
| 2026-05-24 | **Removed `approvalGate` from flow step** — approval UI now owned by agent `.md`; engine is domain-agnostic |
| 2026-05-24 | **Approval behavior:** post-run only in v1; two-step gate pattern for pre-run choices; fail-fast on missing `approval` block |

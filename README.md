# Project Builder — Pi Extension

A **domain-agnostic flow orchestration engine** with full Pi integration (custom tools, TUI dashboard, slash commands, gate dialogs). Workflows are defined as ordered lists of agent steps, each self-described in a markdown manifest. The engine advances steps based on **supervisor-submitted results** and **user approval gates**.

> **Self-contained Pi extension.** The engine (`src/engine/`) is a pure library with no Pi dependencies. The UI layer (`src/ui/`) wires it into Pi as custom tools, a live TUI dashboard widget, and slash commands.

## Quick Start

Navigate to any project folder and start a Pi interactive session:

```bash
cd my-project
pi
```

Inside Pi, type the slash command to launch the project-builder:

```
/project-builder
```

This opens an interactive menu where you:
1. **Pick a flow** — e.g. `feature-build` (the built-in 8-step pipeline)
2. **Name your feature** — e.g. `user-auth`
3. **Start or resume** — pick an active workflow to resume, or kick off a new one

Once started, Pi guides you step-by-step through the pipeline. Each step describes what to do, which tools are available, and (for gated steps) pauses for your approval before advancing.

> **Tip:** Use `/project-builder` to start, resume, or list workflow runs.

## How the Engine Works

The engine is built around two simple types: `FlowDefinition` and `FlowStep`. Together they form a **declarative pipeline** — you describe *what* to run and *when*, and the engine handles the state machine, persistence, and user gates.

### `FlowDefinition`

A flow is an ordered list of steps plus metadata. It says **when** — the agent `.md` files say **how**.

```typescript
interface FlowDefinition {
  id: string;              // Unique name, e.g. "feature-build"
  version: number;         // Schema version for migration logic
  description: string;     // Human-readable label shown in /project-builder
  strictOutputs?: boolean; // If true, missing output files block step completion
  steps: FlowStep[];       // Ordered pipeline
}
```

| Property | What it does |
|----------|-------------|
| `id` | Identifies the flow. Stored in `WorkflowState.flow_id` and shown in the `/project-builder` menu. |
| `version` | Schema version, useful if you evolve flow definitions over time. |
| `description` | Human-readable summary displayed when the user picks a flow. |
| `strictOutputs` | When `true`, `flow_step_complete` with `"success"` **blocks** if the agent's declared output files are missing. Defaults to `true` (blocks on missing outputs). |
| `steps` | The heart of the flow — an ordered array of `FlowStep`. The engine walks through them one by one. |

### `FlowStep`

Each step maps to one agent manifest and configures its behavior:

```typescript
interface FlowStep {
  agent: string;              // → agents/{agent}.md
  requestApproval?: boolean;  // Pause for user gate after success
  attempts?: number;          // Max retries on error (default: 1)
  model?: string;             // Optional LLM override for this step
}
```

| Property | What it does |
|----------|-------------|
| `agent` | Maps to `agents/{agent}.md`. The agent manifest defines tools, prompt, subagents, parallel config, and the approval dialog UI. |
| `requestApproval` | If `true`, after the supervisor reports `result: "success"`, the workflow pauses in `"awaiting_user"` state. The LLM presents the approval dialog from the agent manifest, and the workflow only advances once the user explicitly approves. |
| `attempts` | Max retry count on error. The engine increments an attempt counter at each `flow_step` call. If the step fails with `retryable: true` and attempts remain, the step resets to `"pending"` for re-execution. Once exhausted, the workflow goes to `"blocked"`. |
| `model` | Optional model override (e.g. `"google/gemini-2.5-pro"`). Passed through to `StepInstruction.model` — the executor can use it to route this step to a different LLM. |

### How they work together

```
FlowDefinition.steps  ───  FlowStep.agent  ───→  agents/{agent}.md
                           (maps to)              (tools, prompt, subagents,
                                                   approval dialog)

                                 ───→  Engine state machine
                                       (order, retries, gates,
                                        frozen snapshot)
```

The flow definition is **frozen** at `flow_start` time via deep clone into `WorkflowState.flow_snapshot`. Mid-run mutations to the original flow object have no effect — guaranteeing reproducible runs.

## Built-in Feature-Build Pipeline

The reference pipeline is `FEATURE_BUILD_FLOW` from `flows/index.ts`:

```typescript
export const FEATURE_BUILD_FLOW: FlowDefinition = {
  id: "feature-build",
  version: 5,
  description: "Full product feature build from analysis to completion docs",
  steps: [
    { agent: "analyze", requestApproval: true },
    { agent: "spec-write", requestApproval: true },
    { agent: "plan" },
    { agent: "implement", attempts: 2 },
    { agent: "review", requestApproval: true },
    { agent: "lint" },
    { agent: "doc-sync", attempts: 2 },
    { agent: "complete" },
  ],
};
```

**8-step pipeline** with subagent delegation for doc-sync and complete:

```
analyze (gate) → spec-write (gate) → plan →
implement (2 attempts) → review (gate) → lint →
doc-sync (2 attempts) → complete (gate)
```

| Step | Agent | Subagents | Outputs | Gate? | Notes |
|------|-------|-----------|---------|-------|-------|
| `analyze` | `agents/analyze.md` | — | `analysis.md` | ✅ | Merged gather-input + discover |
| `spec-write` | `agents/spec-write.md` | — | `spec.md` | ✅ | Writes spec from analysis, user approves |
| `plan` | `agents/plan.md` | — | `plan.md`, `service-dirs.json` | | Implementation plan + service dirs |
| `implement` | `agents/implement.md` | `worker` | `implementation-notes.md` | | 2 attempts; parallel worker fan-out |
| `review` | `agents/review.md` | `reviewer` | `review-findings.md` | ✅ | Code review, user signs off |
| `lint` | `agents/lint.md` | `lint-worker` | `lint-report.md` | | Ensures zero lint errors |
| `doc-sync` | `agents/doc-sync.md` | `doc-sync-classify` → `doc-sync-writer` | `docs.md` | | Classify changes → write project docs; 2 attempts |
| `complete` | `agents/complete.md` | `reference-writer` → `verifier` → `artifact-writer` | `summary.md`, `state.md`, `completion.md` + per-service refs | ✅ | Write project tree → verify → write .temp; final user approval |

### doc-sync subagent flow
```
main agent
  ├─ classify subagent — classifies change type, discovers docs, maps updates
  └─ writer subagent — executes doc updates on real project files
       (if any missed, re-dispatch with corrective instructions)
```

### complete subagent flow
```
main agent
  ├─ reference-writer subagent — writes 3 project tree files + README index per service dir
  ├─ verifier subagent — checks all files exist (re-dispatches writer on failure)
  └─ artifact-writer subagent — writes .temp files (summary.md, state.md, completion.md)
```

### How it plays out live

1. User runs `/project-builder` in a Pi session, picks a flow, names their feature (e.g. `user-auth`).
2. **`flow_start`** freezes the flow definition into a snapshot — the original can't affect the run anymore.
3. The engine walks through the steps in order (8-11 depending on the flow). At each **`flow_step`** call:
   - Resolves `agents/{agent}.md`, parses its YAML frontmatter, and builds the prompt with workspace context.
   - Marks the step `"running"` and returns the `StepInstruction` (tools + prompt + subagents).
4. The LLM executes the agent's instructions, optionally reporting progress via **`flow_step_update`**.
5. On **`flow_step_complete`**:
   - **No gate** → advances `current_step_index` by 1.
   - **Gate step** (`requestApproval: true`) → transitions to `"awaiting_user"`. The LLM presents the approval dialog (from the agent manifest) via `ask_user_question`. The user can approve (advance), reject with feedback (retry step), or abort (abandon workflow).
   - **Error** with `attempts: 2` on `implement` → resets to `"pending"` for one retry. If it fails again, the workflow goes `"blocked"`.
6. After the final step (`complete`), the workflow reaches `"done"`.

All artifacts land in `.temp/{DD-MM-YYYY-feature-name}/` — one directory per run, no collisions.

## Architecture Overview

```
project-builder/
├── src/
│   ├── engine/              ← Pure state machine + agent loading + persistence
│   │   ├── engine.ts        ← Public API (start, step, stepComplete, etc.)
│   │   ├── transitions.ts   ← Pure state transitions (no I/O!)
│   │   ├── agent-loader.ts  ← Load & validate agent .md manifests
│   │   ├── workflow-renderer.ts  ← Text rendering for TUI status
│   │   └── subagent-activity.ts  ← Correlate Pi subagent runs to steps
│   ├── shared/              ← Types, persistence, frontmatter parser
│   │   ├── types.ts         ← FlowDefinition, AgentManifest, WorkflowState, etc.
│   │   ├── persistence.ts   ← Atomic read/write of workflow.json
│   │   └── frontmatter.ts   ← YAML frontmatter parser for agent .md files
│   └── ui/                  ← Pi integration layer
│       ├── index.ts         ← Extension entry point (pi.extensions)
│       ├── engine-context.ts← Engine lifecycle wrapper, agentsDir resolution
│       ├── tools.ts         ← All 9 flow_* tools (Pi custom tool registration)
│       ├── step-summary-widget.ts  ← TUI dashboard widget (step status display)
│       └── commands.ts            ← Slash commands (/project-builder)
├── agents/                  ← Reference agent manifests
│   ├── subagents/           ← Subagent manifests (worker, scout, reviewer)
│   └── *.md                 ← 8 main agents
├── skills/                  ← Editable agent creation skill
│   └── agent-creation-guide/
├── docs/                    ← Documentation
│   ├── ARCHITECTURE.md      ← Architecture deep-dive
│   ├── AGENT-MANIFEST-SCHEMA.md  ← Agent manifest schema reference
│   └── ENGINE-STATE-MACHINE.md   ← State machine documentation
└── scripts/                 ← Validation & scaffolding utilities
```

**See `docs/ARCHITECTURE.md` for the full deep-dive.**

## Three Conceptual Layers

| Layer | Says | Lives in |
|-------|------|----------|
| **Flows** | *When* (order, retries, approval flag) | Inline JSON in `flow_start` call |
| **Agents** | *How* (tools, subagents, parallel config, prompt, approval dialog) | `agents/*.md` with YAML frontmatter |
| **Engine** | *State machine* (persists `workflow.json`, advances transitions) | `src/engine/` (no Pi deps) |

Flows say **when**. Agents say **how**. The engine says **what happens next**.

## Engine API Reference

| Function | Purpose |
|----------|---------|
| `validateFlows(flows, agentsDir)` | Validate flow definitions against agent manifests |
| `start(flow, featureName, projectRoot, options)` | Start a new workflow run |
| `step(projectRoot, options)` | Get current step instructions |
| `stepComplete(result, projectRoot, options)` | Submit step success/error, advance |
| `stepUpdate(update, projectRoot, featurePath?)` | Record incremental step activity |
| `recordGate(answer, projectRoot, featurePath?)` | Answer an approval gate |
| `status(projectRoot, featurePath?)` | Read current workflow state |
| `list(projectRoot)` | List all workflow runs |
| `abort(projectRoot, featurePath?)` | Abandon a workflow |
| `cleanupWorkflows(projectRoot, olderThanDays)` | Remove old completed/blocked/abandoned workflows |

## Pi Tools

9 custom tools registered by this extension:

| Tool | Purpose |
|------|---------|
| `flow_start` | Start a new workflow (freezes `flow_snapshot`) |
| `flow_step` | Get current step instructions + mark step as running |
| `flow_step_update` | Record incremental progress (phase, message, child run IDs) |
| `flow_step_complete` | Submit step result (supervisor only) |
| `flow_record_gate` | Record user's approval gate answer |
| `flow_status` | Show full workflow status |
| `flow_list` | List all workflow runs |
| `flow_continue` | Auto-detect state and perform next action |
| `flow_abort` | Mark workflow as abandoned |

## Key Constraints (non-negotiable)

1. **Supervisor-only step completion.** Subagents never call `flow_step_complete`. Only the supervising LLM can advance workflow state.
2. **Engine is domain-agnostic.** No hardcoded phase enums, step names, or agent behavior. Everything is driven by agent .md files.
3. **Frozen flow snapshots.** `flow_start` deep-clones the flow definition. Mutating the original flow mid-run has no effect.
4. **Atomic persistence.** `workflow.json` writes go to a temp file first, then rename. No partial writes.
5. **Approval is post-run.** A step completes with `success`, *then* the gate pauses the workflow. Not pre-run.
6. **Pure state machine transitions.** `transitions.ts` has no I/O, no file system access, no Pi dependencies.
7. **Missing approval blocks fail fast.** Validated at `flow_start`, caught again at `stepComplete`.

## Development

```bash
npm test                              # Run unit tests
npm run validate                      # Validate all agent manifests
npm run scaffold:agent -- my-agent --approval   # Create main agent
npm run scaffold:agent -- worker --subagent     # Create subagent
```

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/project-builder` | Interactive flow selection, naming, start/resume |

## Skills

This package includes a skill at `src/skills/agent-creation-guide/SKILL.md` that provides an authoritative reference for creating new agents (main and subagent). It covers YAML frontmatter schema, tool selection rules, subagent wiring, parallel execution, approval gates, and common pitfalls.

## Related

- **`docs/ARCHITECTURE.md`** — Full architecture deep-dive with data flow diagrams
- **`docs/AGENT-MANIFEST-SCHEMA.md`** — Complete reference for agent .md frontmatter
- **`docs/ENGINE-STATE-MACHINE.md`** — State machine documentation (states, transitions, sequence diagrams)
- **`src/skills/agent-creation-guide/SKILL.md`** — Agent creation skill

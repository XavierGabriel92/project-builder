# Project Builder — Pi Extension

A **domain-agnostic flow orchestration engine** with full Pi integration (custom tools, TUI dashboard, slash commands, gate dialogs). Workflows are defined as ordered lists of agent steps, each self-described in a markdown manifest. The engine advances steps based on **supervisor-submitted results** and **user approval gates**.

> **Self-contained Pi extension.** The engine (`src/engine/`) is a pure library with no Pi dependencies. The UI layer (`src/ui/`) wires it into Pi as custom tools, a live TUI dashboard widget, and slash commands.

## Quick Start

```bash
# Validate all agent manifests
npm run validate

# Run unit tests
npm test

# Scaffold a new agent
npm run scaffold:agent -- my-agent --approval
npm run scaffold:agent -- worker --subagent
```

## Built-in Feature-Build Pipeline

The reference 10-step pipeline `feature-build`:

```
gather-input → discover → clarify → spec-write → research → plan → implement → review → doc-sync → complete
```

Each step produces artifacts in `.temp/{featurePath}/`:

| Step          | Outputs                                              | Gate? |
|---------------|------------------------------------------------------|-------|
| `gather-input` | `feature-input.md`                                   | ✅    |
| `discover`     | `discovery.md`, `scout-report.md`                    |       |
| `clarify`      | `clarifications.md`                                  | ✅    |
| `spec-write`   | `spec.md`                                            | ✅    |
| `research`     | `research.md`                                        | ✅    |
| `plan`         | `plan.md`, `service-dirs.json`                       | ✅    |
| `implement`    | `implementation-notes.md`                            |       |
| `review`       | `review-findings.md`                                 |       |
| `doc-sync`     | `docs.md`                                            |       |
| `complete`     | `summary.md`, per-service reference docs             |       |

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
│       ├── ui.ts            ← TUI dashboard widget (compact/expanded)
│       └── commands.ts      ← Slash commands (/pb, /pb-list, etc.)
├── agents/                  ← Reference agent manifests
│   ├── subagents/           ← Subagent manifests (worker, scout, reviewer)
│   └── *.md                 ← 10 main agents
└── scripts/                 ← Validation & scaffolding utilities
```

**See `ARCHITECTURE.md` for the full deep-dive.**

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

## Related

- **ARCHITECTURE.md** — Full architecture deep-dive with data flow diagrams
- **AGENT-MANIFEST-SCHEMA.md** — Complete reference for agent .md frontmatter
- **ENGINE-STATE-MACHINE.md** — State machine documentation (states, transitions, sequence diagrams)

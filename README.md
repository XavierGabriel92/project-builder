# Project Builder — Pi Extension

A domain-agnostic flow orchestration **engine** with full Pi integration (tools, TUI dashboard, slash commands, gate dialogs). Defines workflows as ordered lists of agents, each self-described in markdown. The engine advances steps based on supervisor-submitted results and user approval gates.

> **Self-contained Pi extension.** The engine (`src/engine/`) is a pure library with no Pi dependencies. The UI layer (`src/ui/`) wires it into Pi as custom tools, a live TUI dashboard widget, and slash commands.

## Architecture

```
project-builder/               (self-contained Pi extension)
├── src/engine/                ← state machine, transitions, agent loading
│   ├── engine.ts              ← public API: start, step, stepComplete, stepUpdate, recordGate, status, list, abort
│   ├── transitions.ts         ← pure state machine transitions (no I/O)
│   ├── agent-loader.ts        ← load/validate agent .md manifests
│   ├── workflow-renderer.ts   ← text rendering for status displays
│   └── subagent-activity.ts   ← correlate Pi subagent async runs to workflow steps
├── src/shared/                ← types, persistence, frontmatter parser
│   ├── types.ts               ← FlowDefinition, AgentManifest, WorkflowState, etc.
│   ├── persistence.ts         ← atomic read/write of workflow.json
│   └── frontmatter.ts         ← YAML frontmatter parser for agent .md files
├── src/ui/                    ← Pi integration: tools, dashboard, commands
│   ├── index.ts               ← Extension entry point (pi.extensions)
│   ├── engine-context.ts      ← Engine lifecycle wrapper, agentsDir resolution
│   ├── tools.ts               ← All 8 flow_* tools registered as Pi custom tools
│   ├── ui.ts                  ← TUI dashboard widget (compact/expanded), status bar
│   └── commands.ts            ← Slash commands (/pb, /pb-list, /pb-status, /pb-expand)
└── agents/                    ← reference agent manifests
    ├── implement.md
    ├── plan.md
    └── ... (10 agents total)
        └── subagents/         ← subagent manifests (worker, scout, reviewer)
```

Three layers:

1. **Flows** define order, retries, and whether a step needs approval.
2. **Agents** (`agents/*.md`) define tools, subagents, parallel fan-out, approval UI, expected outputs, and the prompt.
3. **Engine** persists `workflow.json` and advances the state machine.
4. **UI** (`src/ui/`) wires the engine into Pi as custom tools, a live TUI dashboard, and slash commands.

Flows say **when**. Agents say **how**. The UI makes it interactive.

## Engine API

| Function | Purpose |
|----------|---------|
| `validateFlows(flows, agentsDir)` | Validate flow definitions against agent manifests |
| `start(flow, featureName, projectRoot, options)` | Start a new workflow run |
| `step(projectRoot, options)` | Get current step instructions (agent prompt, tools, subagents) |
| `stepComplete(result, projectRoot, options)` | Submit step success/error, advance the state machine |
| `stepUpdate(update, projectRoot, featurePath?)` | Record incremental step activity |
| `recordGate(answer, projectRoot, featurePath?)` | Answer an approval gate |
| `status(projectRoot, featurePath?)` | Read current workflow state |
| `list(projectRoot)` | List all workflow runs |
| `abort(projectRoot, featurePath?)` | Abandon a workflow |

## Reference Agents

### `feature-build`

Full product build pipeline (10 steps):

```
gather-input → discover → clarify → spec-write → research → plan → implement → review → doc-sync → complete
```

Artifact map:

| Step | Outputs |
|------|---------|
| `gather-input` | `feature-input.md` |
| `discover` | `discovery.md`, `scout-report.md` |
| `clarify` | `clarifications.md` |
| `spec-write` | `spec.md` |
| `research` | `research.md` |
| `plan` | `plan.md`, `service-dirs.json` |
| `implement` | `implementation-notes.md` |
| `review` | `review-findings.md` |
| `doc-sync` | `docs.md` |
| `complete` | `summary.md` and service reference docs |

## Development

```bash
npm test                        # Run unit tests
npm run validate                # Validate agent manifests
npm run scaffold:agent -- my-agent --approval   # Create main agent template
npm run scaffold:agent -- worker --subagent     # Create subagent template
```

## Key Decisions

- The engine is **domain-agnostic**: no hardcoded phase enums.
- Workflows are frozen at `flow_start` through `flow_snapshot`.
- Approval is **post-run**: a step completes, then a gate may pause the flow.
- Missing approval blocks fail fast during validation/start.
- **Subagents never advance workflow state**; only the supervisor (LLM) submits step results.
- Expected outputs are checked as non-blocking warnings on successful step completion.

## Related

- **project-builder** was previously split into a pure engine library (`project-builder`) and a separate Pi extension (`project-builder-ui`). They are now merged into a single self-contained package. The `project-builder-ui` extension has been removed.

# Project Builder - Declarative Generic Flow Engine

A Pi extension that provides a domain-agnostic flow orchestration engine. Define workflows as ordered lists of agents, each self-described in markdown. The engine advances steps based on supervisor-submitted results and user approval gates.

## Architecture

Three layers:

1. **Flows** (`flows/*.ts`) define order, retries, and whether a step needs approval.
2. **Agents** (`agents/*.md`) define tools, subagents, parallel fan-out, approval UI, expected outputs, and the prompt.
3. **Orchestrator** (`src/orchestrator/`) persists `workflow.json` and advances the state machine.

Flows say **when**. Agents say **how**.

## Tools

| Tool | Purpose |
|------|---------|
| `flow_start` | Start a workflow run and create `.temp/{featurePath}/workflow.json`. |
| `flow_step` | Get the current agent prompt, tools, subagent prompts, parallel config, and expected outputs. |
| `flow_step_complete` | Submit `success` or `error`. Can include `metadata.service_dirs`. |
| `flow_record_gate` | Answer an approval gate in non-UI mode. |
| `flow_status` | Show workflow status. |
| `flow_list` | List registered flows and workflow runs. |
| `flow_abort` | Mark a workflow as abandoned without deleting files. |

## Registered Flows

### `feature-build`

Full product build:

```text
gather-input -> discover -> clarify -> spec-write -> research -> plan -> implement -> review -> doc-sync -> complete
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

The `plan` step writes `service-dirs.json`; the supervisor passes that list as `flow_step_complete.metadata.service_dirs`. The engine stores it in `workflow.json.service_dirs` for implementation fan-out and completion docs.

## Development

```bash
npm test
npm run validate
```

Useful scripts:

- `npm run validate` checks all registered flows and agent manifests.
- `npm run scaffold:agent -- my-agent --approval` creates a main agent template.
- `npm run scaffold:agent -- worker --subagent` creates a subagent template.

## Key Decisions

- The engine is domain-agnostic: no hardcoded phase enums.
- Workflows are frozen at `flow_start` through `flow_snapshot`.
- Approval is post-run in v1: a step completes, then a gate may pause the flow.
- Missing approval blocks fail fast during validation/start.
- Subagents never advance workflow state; only the supervisor submits step results.
- Expected outputs are checked as non-blocking warnings on successful step completion.

---
name: project-builder-agent
description: |
  Build agents (agents/*.md) for the project-builder declarative flow engine.
  Use when creating, editing, or validating agent manifest files — including
  tool declarations, subagent wiring, parallel fan-out config, approval UI,
  and adding steps to a flow definition (flows/*.ts). Covers the full agent
  authoring lifecycle: scaffolding, manifest validation, flow integration,
  and testing.
---

# Project Builder — Agent Authoring

You are helping the user build agents for the **project-builder** declarative flow engine. This engine runs ordered steps; each step points to a self-describing `agents/*.md` file. Use this skill any time the user wants to create a new agent, modify an existing one, add a step to a flow, or debug agent loading.

## Quick Reference: File Layout

```
~/.pi/agent/extensions/project-builder/
  flows/
    index.ts           ← flow definitions (ordered agent steps)
  agents/
    my-agent.md        ← main agent (can have approval, subagents, parallel)
    subagents/
      worker.md        ← subagent (no approval, no subagents)
  src/
    orchestrator/
      agent-loader.ts  ← validates manifests; source of truth for allowed tools
      engine.ts        ← initEngine(agentsDir), start/step/step_complete/record_gate
    shared/
      types.ts         ← AgentManifest, FlowDefinition, FlowStep, etc.
  skills/
    project-builder-agent/
      SKILL.md         ← this file
```

---

## Part 1: Agent Manifest (`agents/*.md`)

Every agent `.md` file has **YAML frontmatter** (between `---` delimiters) followed by a **prompt body**. The frontmatter declares the agent's contract; the body is the prompt the supervisor sees when the step runs.

### Template: Main Agent

```markdown
---
id: my-agent
version: 1
tools: ["read", "write", "edit", "bash"]
outputs: ["output-file.md"]
approval: {"header": "My Step", "preview": "output-file.md", "options": [{"label": "Approve", "description": "Looks good", "advance": true}, {"label": "Revise", "description": "Needs changes", "advance": false}]}
---

You are the **my-agent** agent. Your job is to...

## Instructions

1. Do step one.
2. Do step two.
3. When complete, the supervisor will submit `step-result: success`.
```

### Template: Main Agent with Subagents + Parallel

```markdown
---
id: worker-orchestrator
version: 1
tools: ["subagent", "read", "write", "edit", "bash"]
subagents: {"worker": "subagents/worker.md"}
parallel_over: service_dirs
parallel_subagent: worker
parallel_concurrency: 4
---

You are the **worker-orchestrator** agent. Coordinate parallel workers.

## Instructions

1. Identify work units.
2. Use the `subagent` tool to fan out `worker` subagents.
3. Synthesize results and verify integration.
4. When complete, the supervisor will submit `step-result: success`.

Do NOT ask for user approval in this step.
```

### Template: Subagent

```markdown
---
id: worker
version: 1
tools: ["read", "write", "edit", "bash"]
---

You are a **worker** subagent. Implement the assigned task.

Do NOT ask user questions. Do NOT launch other subagents.
```

### Template: Gate-only Agent (Pre-run Choice Pattern)

Per RFC §9.1, pre-run choices use a two-step pattern: a thin gate agent followed by the real work agent.

```markdown
---
id: review-gate
version: 1
tools: ["ask_user_question"]
approval: {"header": "Review?", "options": [{"label": "Run review", "description": "Proceed with code review", "advance": true}, {"label": "Skip", "description": "Skip the review step", "advance": true}]}
---

You are the **review-gate** agent. Ask the user whether to run code review.

Use `ask_user_question` to present the choice. If the user picks "Skip", still submit `step-result: success` — the gate will advance. The next step (`review`) will run normally if they picked "Run", or the user's gate answer will advance past it if they picked "Skip".

Note: Both options have `advance: true` because this is a pre-run gate — either way the flow advances. The work step that follows is what the user chose to run or not.
```

---

## Part 2: Manifest Field Reference

Every field in the YAML frontmatter. All fields except `id`, `version`, and `tools` are optional.

| Field | Type | Main Agent | Subagent | Description |
|-------|------|------------|----------|-------------|
| `id` | string | ✅ required | ✅ required | Unique identifier. Must match filename stem convention. |
| `version` | integer | ✅ required | ✅ required | Agent version (for tracking changes). |
| `tools` | JSON array | ✅ required | ✅ required | Pi tools available to this agent. |
| `subagents` | JSON object | ✅ optional | ❌ forbidden | `"name": "path/to/subagent.md"` mapping. |
| `parallel_over` | string | ✅ optional | ❌ forbidden | Identifier for fan-out iteration (e.g. `service_dirs`). |
| `parallel_subagent` | string | ✅ optional | ❌ forbidden | Subagent name to fan out. Must be in `subagents`. |
| `parallel_concurrency` | integer | ✅ optional | ❌ forbidden | Max concurrent workers (default: 4). |
| `outputs` | JSON array | ✅ optional | ✅ optional | Expected output files (relative to feature path). |
| `approval` | JSON object | ✅ optional | ❌ forbidden | Approval dialog. Required if the flow step has `requestApproval: true`. |

### Allowed Tools

The engine validates these at load time. Invalid tools cause a hard error.

```
subagent          ask_user_question   read
write             edit                bash
web_search        code_search         fetch_content
get_search_content  mcp
```

**Subagent restrictions:**
- `subagent` — ❌ not allowed (subagents cannot launch subagents)
- `ask_user_question` — ❌ not allowed (only main agents interact with user)

If a main agent declares `parallel_over` / `parallel_subagent`, it **must** include `subagent` in its `tools` list.

### Approval Object

```json
{
  "header": "Label shown as the gate question header",
  "preview": "optional-path-to-artifact.md",
  "options": [
    {
      "label": "Approve",
      "description": "Proceed to next step",
      "advance": true
    },
    {
      "label": "Request changes",
      "description": "Re-run this step",
      "advance": false
    },
    {
      "label": "Exit",
      "description": "Abort the workflow",
      "advance": false,
      "abort": true
    }
  ]
}
```

**Rules:**
- At least one option must have `advance: true`.
- `advance: true` → flow proceeds to next step.
- `advance: false` (without `abort`) → step resets for re-run.
- `advance: false` + `abort: true` → workflow is abandoned immediately.
- If the flow step has `requestApproval: true` but the agent has no `approval` block → **engine rejects at `start` time**.

---

## Part 3: Flow Integration (`flows/*.ts`)

Once the agent `.md` exists, add it to a flow definition.

### FlowStep Fields

```typescript
export type FlowStep = {
  id?: string;           // defaults to agent id
  agent: string;         // → agents/{agent}.md
  requestApproval?: boolean;  // pause for user gate after success
  attempts?: number;     // auto-retry on error (default: 1)
};
```

### Adding a Step to an Existing Flow

Edit `flows/index.ts`. Locate the flow's `steps` array and insert your step:

```typescript
export const featureBuild: FlowDefinition = {
  id: "feature-build",
  version: 1,
  description: "...",
  steps: [
    { agent: "gather-input", requestApproval: true },
    { agent: "discover", requestApproval: true },
    // ...existing steps...
    { agent: "my-new-agent", requestApproval: true },  // ← ADD HERE
    // ...remaining steps...
  ],
};
```

### Creating a Brand New Flow

```typescript
import type { FlowDefinition } from "../src/shared/types.ts";

export const myWorkflow: FlowDefinition = {
  id: "my-workflow",
  version: 1,
  description: "What this workflow does",
  steps: [
    { agent: "first-step", requestApproval: true },
    { agent: "second-step", attempts: 2 },
    { agent: "final-step" },
  ],
};
```

Then export it from `flows/index.ts` and add it to `allFlows`. The extension builds its registry from `allFlows`.

---

## Part 4: Validation Checklist

Before declaring an agent done, verify:

- [ ] `id` field present and matches filename (without `.md`)
- [ ] `version` is a positive integer
- [ ] `tools` is a valid JSON array of allowed tool names
- [ ] If main agent: `subagent` and `ask_user_question` may be in `tools`
- [ ] If subagent: no `subagent`, no `ask_user_question`, no `subagents` field, no `parallel_*` fields, no `approval` field
- [ ] If `parallel_over` declared: `subagent` is in `tools`, `parallel_subagent` is present and exists in `subagents`
- [ ] If `approval` declared: `header` is non-empty, `options` has at least one entry, at least one option has `advance: true`
- [ ] If the flow step has `requestApproval: true`: the agent **must** have an `approval` block (engine rejects at start otherwise)
- [ ] If the flow step has `attempts > 1`: the agent's prompt should handle re-execution gracefully (idempotent or aware it's a retry)
- [ ] If the agent declares `outputs`, the prompt instructs the agent to write each output under `.temp/{featurePath}/`
- [ ] If the agent produces service boundaries, it writes `service-dirs.json` and tells the supervisor to submit `metadata.service_dirs`
- [ ] The prompt body is clear about what the agent should produce

### Run the Tests

```bash
cd ~/.pi/agent/extensions/project-builder
npm test
```

The orchestrator integration tests create temp agents and exercise the full lifecycle. Your new agent won't break them, but if you modify `agent-loader.ts` or `types.ts`, run the tests to verify.

---

## Part 5: Common Patterns

### Pattern: Gather → Approve → Work

```typescript
steps: [
  { agent: "gather-input", requestApproval: true },   // user provides input
  { agent: "do-work" },                                // agent does work
  { agent: "review-results", requestApproval: true },  // user approves output
]
```

### Pattern: Pre-run Gate (Two-Step)

User chooses whether to run a step before the agent executes:

```typescript
steps: [
  { agent: "review-gate", requestApproval: true },  // thin agent: asks "Review or skip?"
  { agent: "review" },                               // runs only if gate answer was "run"
]
```

Per RFC §9.1, the gate agent uses `ask_user_question` and both options have `advance: true`. The flow always advances — the user's choice determines whether the *next* step has meaningful work.

### Pattern: Parallel Worker Fan-out

```typescript
steps: [
  { agent: "implement", attempts: 2 },  // orchestrates parallel workers
]
```

The `implement` agent `.md` declares `parallel_over` and `parallel_subagent`. The supervisor invokes the agent, which uses the `subagent` tool to fan out workers. If any worker fails, the supervisor can re-run the step (up to `attempts`).

### Pattern: Service Directory Metadata

The `plan` step writes `service-dirs.json`:

```json
{
  "service_dirs": ["services/api", "packages/web"]
}
```

The supervisor parses that file and submits the same list in `flow_step_complete.metadata.service_dirs`. The engine stores it in `workflow.json.service_dirs`, and later steps use that field for parallel fan-out and reference documentation.

### Current Feature Build Flow

```typescript
steps: [
  { agent: "gather-input", requestApproval: true },
  { agent: "discover" },
  { agent: "clarify", requestApproval: true },
  { agent: "spec-write", requestApproval: true },
  { agent: "research", requestApproval: true },
  { agent: "plan", requestApproval: true },
  { agent: "implement", attempts: 3 },
  { agent: "review", requestApproval: true },
  { agent: "doc-sync" },
  { agent: "complete" },
]
```

### Pattern: Retry on Flaky Operations

```typescript
steps: [
  { agent: "run-checks", attempts: 3 },      // flaky check suite? auto-retry
  { agent: "publish-release", requestApproval: true },  // always gate releases
]
```

---

## Part 6: Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Agent "X" not found at ...` | Missing `.md` file or wrong filename | Create `agents/X.md` with correct `id` field |
| `missing required field "tools"` | Main agent has no `tools` in frontmatter | Add `tools: ["read", "write"]` |
| `unknown tool "X"` | Tool name typo or unsupported tool | Use only tools from the allowed list |
| `Subagent "X" cannot use tool "subagent"` | Subagent has `subagent` in `tools` | Remove it; subagents cannot launch subagents |
| `Subagent "X" cannot declare subagents` | Subagent has `subagents` field | Remove it; only main agents orchestrate |
| `requires user approval but no approval block` | Flow step has `requestApproval: true` but agent has no `approval` | Add `approval:` block to the agent, or remove `requestApproval` from flow |
| `approval block must have at least one option with advance: true` | All options have `advance: false` | Add at least one "approve/proceed" option with `advance: true` |
| `parallel requires both "parallel_over" and "parallel_subagent"` | Missing one of the two fields | Declare both |
| `parallel but "subagent" is not in tools` | `parallel_over` declared without `subagent` tool | Add `"subagent"` to `tools` |
| `parallel_subagent "X" but it is not present in subagents` | Parallel points to an unknown subagent name | Add the subagent mapping or fix the name |
| `Multiple active workflows found` | `featurePath` was omitted while multiple runs are active | Pass the desired `featurePath` explicitly |

---

## Part 7: Tutorial — Build an Agent from Scratch

Walk through with the user step by step.

### Step 1: Decide what the agent does

Is it a main agent (interacts with user, can have subagents)? Or a subagent (does one focused task, no user interaction, no subagents)?

### Step 2: Choose tools

What does the agent need to do its job? `read` files? `write` or `edit` them? Run `bash` commands? Search the web with `web_search`? Use only what's necessary.

### Step 3: Does it need approval?

If the agent's output needs human review before the flow continues → `requestApproval: true` on the flow step + `approval:` block on the agent.

If the agent is an internal step that always runs → no approval.

### Step 4: Does it need subagents?

If the work can be parallelized (multiple files, services, modules) → declare `subagents` + `parallel_over` + `parallel_subagent`.

If the work is sequential and simple → no subagents needed.

### Step 5: Write the agent `.md`

Use the templates in Part 1. The prompt body is what the supervisor sees — write clear, step-by-step instructions. End with "When complete, the supervisor will submit `step-result: success`."

### Step 6: Add to a flow

Edit `flows/index.ts` and insert the step where it belongs in the sequence.

### Step 7: Test

The engine validates the manifest at `start` time. If something is wrong, the error message tells you exactly what.

---

## Files You May Need to Read

When debugging or understanding the agent system, read these source files:

- `src/shared/types.ts` — all type definitions (FlowStep, AgentManifest, WorkflowState, etc.)
- `src/orchestrator/agent-loader.ts` — parses frontmatter, validates manifests, enforces tool rules
- `src/orchestrator/transitions.ts` — state machine logic (success/error/retry/gate transitions)
- `src/orchestrator/engine.ts` — orchestrator API (initEngine, start, step, stepComplete, recordGate)
- `flows/index.ts` — existing flow definitions
- `agents/` — existing agent `.md` files for reference

# Architecture — Project Builder Engine

## Table of Contents

1. [Architectural Philosophy](#1-architectural-philosophy)
2. [Layered Architecture](#2-layered-architecture)
3. [Critical Invariants](#3-critical-invariants)
4. [Data Flow: Step Lifecycle](#4-data-flow-step-lifecycle)
5. [Data Flow: Approval Gate Lifecycle](#5-data-flow-approval-gate-lifecycle)
6. [Agent Loading & Resolution](#6-agent-loading--resolution)
7. [Persistence & File Layout](#7-persistence--file-layout)
8. [Subagent Activity Correlation](#8-subagent-activity-correlation)
9. [UI Layer Architecture](#9-ui-layer-architecture)
10. [Error Handling & Recovery](#10-error-handling--recovery)
11. [Key Files & Their Responsibilities](#11-key-files--their-responsibilities)
12. [Common Anti-Patterns to Avoid](#12-common-anti-patterns-to-avoid)

---

## 1. Architectural Philosophy

The engine is built around three core design principles:

### 1.1 Separation of Concerns

| Concern | Where | Why |
|---------|-------|-----|
| **State machine rules** | `transitions.ts` | Pure functions, no I/O, no Pi deps. Easy to test and reason about. |
| **Agent contract** | `agents/*.md` (YAML frontmatter) | Self-describing steps. The agent says what tools it needs and what prompt to use. |
| **Orchestration** | `engine.ts` | Reads state, calls pure transitions, writes state back. The I/O boundary. |
| **Pi integration** | `src/ui/` | Register custom tools, TUI widgets, slash commands. The only layer with Pi imports. |

### 1.2 Domain Agnosticism

The engine has **zero** knowledge of:
- What "implement" or "plan" means
- How many steps a flow has
- What artifact filenames are expected
- What approval options mean semantically

Everything is driven by the agent .md manifest and the flow definition JSON. To add a new behavior, add a new agent .md file.

### 1.3 Frozen Workflows

At `flow_start` time, the flow definition is **deep-cloned** into `workflow.json.flow_snapshot`. Mid-run mutations to the original flow definition have no effect. This ensures idempotent replay and debugging.

---

## 2. Layered Architecture

```
┌────────────────────────────────────────────────────────────┐
│                     Pi Integration (src/ui/)                │
│  tools.ts  ·  ui.ts  ·  commands.ts  ·  engine-context.ts  │
│  Registers: 9 flow_* tools, TUI dashboard, /pb commands    │
│  Depends on: @earendil-works/pi-* packages                 │
├────────────────────────────────────────────────────────────┤
│                    Engine Layer (src/engine/)                │
│  engine.ts  ·  transitions.ts  ·  agent-loader.ts           │
│  workflow-renderer.ts  ·  subagent-activity.ts              │
│  Pure Node.js — no Pi imports                               │
├────────────────────────────────────────────────────────────┤
│                    Shared Layer (src/shared/)                │
│  types.ts  ·  persistence.ts  ·  frontmatter.ts             │
│  Shared types, atomic file I/O, YAML frontmatter parser     │
└────────────────────────────────────────────────────────────┘
```

### 2.1 Shared Layer (`src/shared/`)

**`types.ts`** — All TypeScript interfaces. This is the **single source of truth** for:
- `FlowDefinition` / `FlowStep` — what the user submits
- `AgentManifest` — what the .md frontmatter parses to
- `WorkflowState` — what's persisted to disk
- `StepInstruction` — what the supervisor receives
- `GateAnswer` / `StepResult` — what the supervisor submits back

**`persistence.ts`** — File I/O for `workflow.json`:
- Feature path generation: `DD-MM-YYYY-{slug}`
- Atomic writes: write to `.workflow.json.tmp`, then `renameSync`
- Active workflow resolution: auto-detect single active workflow, or error on ambiguity

**`frontmatter.ts`** — YAML frontmatter parser:
- Parses `---` delimited blocks from agent .md files
- All values are flat strings (arrays/objects encoded as JSON in values)
- `parseArrayValue()` and `parseRecordValue()` for JSON decoding

### 2.2 Engine Layer (`src/engine/`)

**`transitions.ts`** — Pure state machine functions:
- `createWorkflowState()` — initialize from a FlowDefinition
- `startStep()` — mark current step as running
- `updateStepActivity()` — merge supervisor-submitted incremental update
- `applyStepResult()` — core transition: advance, gate, retry, or block
- `applyGateAnswer()` — resolve gate: advance, retry, abort, or block

**`engine.ts`** — Public API (I/O boundary):
- Loads state from disk, calls pure transitions, writes state back
- Injects workspace prefix and completion suffix into agent prompts
- Validates approval blocks exist before starting
- Loads subagent manifests and wraps them with prompts
- `validateFlows()` is the only function that doesn't touch disk

**`agent-loader.ts`** — Agent manifest loading:
- Reads agents/*.md, parses frontmatter, validates schema
- Validates tool names against a whitelist (`VALID_TOOLS`)
- Prevents subagents from using `ask_user_question` or `subagent`
- Validates parallel configuration consistency
- `loadFlowAgents()` recursively loads all referenced subagents
- `validateFlowApproval()` checks every `requestApproval: true` step has an approval block

**`workflow-renderer.ts`** — Text rendering for TUI:
- Compact mode: current step summary + subagent status
- Expanded mode: full step list with agent details, tool calls, tokens
- Child run rendering from `WorkflowChildRun` data
- Line budget fitting for TUI widget sizing

**`subagent-activity.ts`** — Async run correlation:
- Scans Pi subagent async run directories
- Matches runs to steps via `child_run_ids` or `workflow` metadata
- Returns `WorkflowChildRun[]` for TUI rendering

### 2.3 UI Layer (`src/ui/`)

**`index.ts`** — Extension entry point:
- Creates `EngineContext` (binds agentsDir)
- Calls `registerTools()`, `registerDashboard()`, `registerCommands()`

**`engine-context.ts`** — Lifecycle wrapper:
- `resolveAgentsDir()`: project agents/ → built-in agents/
- Creates closures that bake `agentsDir` into engine function calls
- Wraps `start`, `step`, `stepComplete` to auto-supply `agentsDir`

**`tools.ts`** — 9 custom Pi tools:
- Each tool wraps an engine function with input validation and error formatting
- Uses `typebox` for parameter schemas
- Enriches responses with `renderWorkflowStatus()` and `listCorrelatedSubagentRuns()`

**`ui.ts`** — TUI dashboard widget:
- Spinner animation, compact/expanded toggle
- Auto-refresh for running steps (200ms interval)
- Auto-detects most recent active workflow
- Line truncation to terminal width

**`commands.ts`** — Slash commands:
- `/pb` — workflow hub: list, start, resume, hide dashboard
- `/pb-list` — list all runs
- `/pb-status` — show current step status
- `/pb-expand` — toggle dashboard compact/expanded

---

## 3. Critical Invariants

These invariants MUST be preserved by any modification to the engine:

### 3.1 Supervisor-Only Advancement

```
CORRECT:  Supervisor → flow_step_complete → engine advances state
WRONG:    Subagent → flow_step_complete → ❌ NEVER HAPPENS
WRONG:    engine auto-advances without supervisor submitting a result
```

Subagents return text to the supervisor. Only the supervisor (LLM) calls `flow_step_complete`. The engine and subagents enforce this:
- `applyStepResult` checks `step.status === "running"` before accepting a result
- The gate dialog explicitly tells the supervisor to use `ask_user_question`

### 3.2 Transitions Are Pure

```
transitions.ts:
  ✓ Pure functions: (state, params) → { state, action }
  ✓ No fs.readFileSync, fs.writeFileSync, or any I/O
  ✓ No Pi API imports or Pi type dependencies
  ✓ No console.log or side effects

engine.ts:
  ✓ Loads state (I/O side)
  ✓ Calls transitions (pure)
  ✓ Writes state (I/O side)
```

**Never import `engine.ts` or `persistence.ts` into `transitions.ts`.**

### 3.3 Atomic Writes

```
persistence.ts writeWorkflow():
  1. Write to .workflow.json.tmp
  2. renameSync(.workflow.json.tmp → workflow.json)

This prevents:
  ✗ Partial/corrupted workflow.json from crash mid-write
  ✗ Concurrent write races
```

### 3.4 Frozen Flow Snapshots

```
flow_start → deep clone → flow_snapshot
Mid-run flow mutations → no effect on snapshot
```

### 3.5 Missing Approval Blocks Fail Fast

```
At flow_start:   validateFlowApproval() → throws if missing
At stepComplete: applyStepResult() returns "block" action if gate missing
```

### 3.6 AgentsDir Resolution Chain

```
1. Explicit agentsDir parameter (from Pi config)
2. {projectRoot}/agents/
3. Built-in agents/ directory in project-builder package
```

### 3.7 Agent Tool Whitelist

Only these tools can be declared by agents:

```typescript
const VALID_TOOLS = [
  "subagent", "ask_user_question", "read", "write", "edit",
  "bash", "web_search", "code_search", "fetch_content",
  "get_search_content", "mcp", "flow_step_update"
];

// Subagents CANNOT use: "subagent", "ask_user_question"
// Subagents CANNOT declare subagents or parallel execution
// Subagents CANNOT have approval blocks
```

---

## 4. Data Flow: Step Lifecycle

```
1. START
   ┌──────────────────────────────────────────────────┐
   │ User calls flow_start with inline FlowDefinition │
   │ Engine: validateFlows() → start()                │
   │         → createWorkflowState()                  │
   │         → writeWorkflow() → workflow.json        │
   │ Returns: state + featurePath                     │
   └──────────────────────┬───────────────────────────┘
                          │
2. STEP (repeated per step)
   ┌──────────────────────────────────────────────────┐
   │ User/LLM calls flow_step                         │
   │ Engine: resolveWorkflow() → readWorkflow()       │
   │         → startStep() → mark step "running"      │
   │         → loadAgent() → load subagent manifests  │
   │         → writeWorkflow()                        │
   │ Returns: StepInstruction (agent, prompt, tools)  │
   └──────────────────────┬───────────────────────────┘
                          │
3. EXECUTE (LLM works)
   ┌──────────────────────────────────────────────────┐
   │ LLM executes the agent's instructions            │
   │ May call subagent, read, write, edit, bash, etc. │
   │ May call flow_step_update to report progress     │
   │ Engine: updateStepActivity() → merge activity    │
   │         → writeWorkflow()                        │
   └──────────────────────┬───────────────────────────┘
                          │
4. COMPLETE
   ┌──────────────────────────────────────────────────┐
   │ LLM calls flow_step_complete(result)             │
   │ Engine: resolveWorkflow() → readWorkflow()       │
   │         → applyStepResult(state, result)         │
   │         → writeWorkflow()                        │
   │                                                  │
   │ applyStepResult() returns one of:                │
   │   "advance" → current_step_index++               │
   │   "gate"    → pause for user approval            │
   │   "retry"   → reset step for re-run              │
   │   "block"   → workflow blocked                   │
   │   "done"    → workflow complete                  │
   └──────────────────────────────────────────────────┘
```

---

## 5. Data Flow: Approval Gate Lifecycle

```
1. GATE ENTRY (after step_complete with result: "success" on gated step)
   ┌────────────────────────────────────────────────────┐
   │ Engine: status = "awaiting_user"                   │
   │         awaiting = "user_gate"                     │
   │         gate = buildGate(agent manifest approval)  │
   │ Returns: action="gate", gate={header, options}     │
   └──────────────────────┬─────────────────────────────┘
                          │
2. GATE DISPLAY (via flow_continue or flow_status)
   ┌────────────────────────────────────────────────────┐
   │ Engine returns gate options to LLM                  │
   │ LLM MUST use ask_user_question to present options   │
   │ LLM MUST NOT call flow_record_gate without asking   │
   └──────────────────────┬─────────────────────────────┘
                          │
3. GATE ANSWER (user picks option)
   ┌────────────────────────────────────────────────────┐
   │ LLM calls flow_record_gate(answer)                 │
   │ Engine: applyGateAnswer(state, answer)             │
   │         → writeWorkflow()                          │
   │                                                    │
   │ applyGateAnswer() returns one of:                  │
   │   "advance" → current_step_index++, next step      │
   │   "retry"   → reset current step to "pending"       │
   │              (preserves last_feedback)             │
   │   "abort"   → status = "abandoned"                 │
   │   "done"    → last step approved, workflow done    │
   │   "block"   → invalid answer (e.g., missing        │
   │               required feedback)                   │
   └────────────────────────────────────────────────────┘
```

---

## 6. Agent Loading & Resolution

### 6.1 File Format

Agent manifests are markdown files with YAML frontmatter:

```markdown
---
id: my-agent
version: 2
tools: ["read", "write", "bash", "subagent"]
subagents: {"worker": "subagents/worker.md"}
parallel_over: service_dirs
parallel_subagent: worker
parallel_concurrency: 4
outputs: ["artifact.md"]
approval: {"header": "Review", "options": [...]}
---

You are the **my-agent** agent. Your job is to...

## Instructions

1. Do X
2. Produce Y
```

### 6.2 Resolution Path

```
loadAgent(agentsDir, "orchestrator")
  → agentsDir/orchestrator.md

loadAgent(agentsDir, "subagents/scout.md", isSubagent=true)
  → agentsDir/subagents/scout.md

loadAgent(agentsDir, "subagents/scout", isSubagent=true)
  → agentsDir/subagents/scout.md  (.md appended automatically)
```

### 6.3 Validation Performed

| Check | When | Error |
|-------|------|-------|
| File exists | `loadAgent()` | `Agent "x" not found at ...` |
| Required frontmatter fields | `parseManifest()` | Missing `id` or `version` |
| Tool names whitelist | `parseManifest()` | Unknown tool `"foo"` |
| Subagent tool restrictions | `parseManifest()` | Subagent cannot use `ask_user_question` |
| Subagent nesting | `parseManifest()` | Subagent cannot declare subagents |
| Parallel consistency | `parseManifest()` | Must have both `parallel_over` and `parallel_subagent` |
| Parallel subagent exists | `parseManifest()` | Referenced subagent not in `subagents` map |
| Approval block structure | `parseManifest()` | Invalid JSON, missing `header`, empty `options`, no `advance: true` |
| Approval on subagents | `parseManifest()` | Subagent cannot have approval block |

### 6.4 Prompt Assembly

The engine wraps the agent's .md body with:

1. **Workspace prefix** — tells the LLM where to write output files
2. **Approval instruction** — only if `flowStep.requestApproval === true`
3. **Completion suffix** — tells the LLM when to stop

```typescript
prompt = workspacePrefix(featurePath) + "\n\n" +
         loaded.prompt +
         (flowStep.requestApproval ? APPROVAL_INSTRUCTION : "") +
         COMPLETION_SUFFIX;
```

---

## 7. Persistence & File Layout

### 7.1 Directory Structure

```
{PROJECT_ROOT}/
  .temp/
    DD-MM-YYYY-feature-name/          ← featurePath for each run
      workflow.json                   ← frozen workflow state
      feature-input.md                ← step outputs
      discovery.md
      ...
    DD-MM-YYYY-another-feature/
      workflow.json
      ...
```

### 7.2 Atomic Write Protocol

```typescript
function writeWorkflow(projectRoot, featurePath, state) {
  const dir  = getWorkflowDir(projectRoot, featurePath);  // .temp/{featurePath}/
  const file = path.join(dir, "workflow.json");
  const tmp  = path.join(dir, ".workflow.json.tmp");

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, file);  // atomic on same filesystem
}
```

### 7.3 Feature Path Generation

```typescript
resolveFeaturePath("user-auth")
  // → "27-05-2026-user-auth"
  // Format: DD-MM-YYYY-{slugified-name}
```

### 7.4 Active Workflow Resolution

`resolveWorkflow(projectRoot, featurePath?)`:

- **With `featurePath`** — read that specific workflow
- **Without `featurePath`** — auto-detect the single active workflow
  - If 0 active → return null
  - If 1 active → return it
  - If >1 active → throw with list of feature paths

---

## 8. Subagent Activity Correlation

### 8.1 How It Works

1. LLM calls `flow_step_update({ childRunIds: ["abc123", "def456"] })`
2. Engine stores these IDs in `step.activity.child_run_ids`
3. `listCorrelatedSubagentRuns()` scans `SUBAGENT_ASYNC_RUNS_DIR`
4. Matches runs to steps by:
   - Direct ID match in `child_run_ids`
   - Workflow metadata match (`projectRoot`, `featurePath`, `stepIndex`)

### 8.2 Data Path

```
Pi subagent async run directories:
  /tmp/pi-subagents-uid-{XXX}/async-subagent-runs/
    abc123/status.json    ← has workflow.metadata
    def456/status.json    ← has workflow.metadata
    ...

status.json structure:
{
  runId: "abc123",
  mode: "parallel",
  state: "running" | "complete" | "failed",
  agents: ["worker", "worker", "worker"],
  steps: [ { agent, status, toolCount, turnCount, ... } ],
  workflow: { projectRoot, featurePath, stepIndex }
}
```

---

## 9. UI Layer Architecture

### 9.1 Tool Registration Pattern

Each tool in `tools.ts` follows this pattern:

```typescript
pi.registerTool({
  name: "flow_xxx",
  description: "...",
  promptSnippet: "The snippet shown in the LLM's tool definitions",
  parameters: Type.Object({ ... }),   // typebox schema
  async execute(...): Promise<AgentToolResult> {
    // 1. Resolve projectRoot (default: cwd)
    // 2. Call engine API
    // 3. Format result as text
    // 4. Return { content: [{ type: "text", text }], details }
  }
});
```

### 9.2 Dashboard Widget

- **Compact mode** (default): shows current step + subagent activity
- **Expanded mode** (Ctrl+O): full step list with agent details, tools, tokens
- Spinner animation updates every 200ms while any step is running
- Auto-refresh via `setTimeout(() => tui.requestRender(), 200)`
- Auto-detects the most recent active workflow
- Line truncation to terminal width to prevent TUI crash

### 9.3 Engine Context

`engine-context.ts` creates a closure that binds `agentsDir`:

```typescript
const engine = createEngineContext(agentsDir);
// engine.step(projectRoot, opts)  →  step(projectRoot, { ...opts, agentsDir })
```

This separation means tools.ts never directly imports agentsDir — it goes through the context.

---

## 10. Error Handling & Recovery

### 10.1 Step Retry

- Configured via `FlowStep.attempts` (default: 1)
- Supervisor submits `{ result: "error", retryable: true }`
- Engine resets step → pending, increments attempt counter
- When attempts exhausted → workflow status = "blocked"

### 10.2 Gate Rejection Recovery

- User rejects with feedback → step reset to "pending"
- `last_feedback` is persisted on the step
- On re-run, `StepInstruction.lastFeedback` is populated
- LLM should incorporate feedback into the fix

### 10.3 Gate Validation

| Invalid State | Error |
|--------------|-------|
| Answering gate when no gate is active | `No active gate to answer` |
| Step index mismatch | `gate answer does not match the current step` |
| Unknown option label | `unknown gate option "X"` |
| advance/abort mismatch | `advance value does not match the answer` |
| Missing required feedback | `requires feedback` |
| Multiple gate options match without label | `Pass chosenLabel with the exact option label` |

### 10.4 Step Completion Validation

| Invalid State | Error |
|--------------|-------|
| Workflow is awaiting user | `awaiting user approval; answer the gate first` |
| Step is not running | `call flow_step before submitting a result` |
| Gate missing on approval step | `no approval block found` |

---

## 11. Key Files & Their Responsibilities

| File | Lines | Responsibility | Pi Deps? |
|------|-------|---------------|----------|
| `src/shared/types.ts` | ~180 | All interfaces, type definitions, constants | No |
| `src/shared/persistence.ts` | ~130 | Atomic read/write of workflow.json, feature path resolution | No |
| `src/shared/frontmatter.ts` | ~100 | YAML frontmatter parser for agent .md files | No |
| `src/engine/transitions.ts` | ~280 | Pure state machine: start, complete, gate, activity updates | No |
| `src/engine/agent-loader.ts` | ~280 | Load/validate agent manifests, build gates | No |
| `src/engine/engine.ts` | ~270 | Public API: validateFlows, start, step, stepComplete, etc. | No |
| `src/engine/workflow-renderer.ts` | ~230 | TUI text rendering for workflow status | No |
| `src/engine/subagent-activity.ts` | ~90 | Correlate Pi async subagent runs to workflow steps | No |
| `src/ui/index.ts` | ~25 | Extension entry point | Yes |
| `src/ui/engine-context.ts` | ~50 | Engine lifecycle wrapper, agentsDir resolution | Yes |
| `src/ui/tools.ts` | ~550 | 9 custom Pi flow_* tool registrations | Yes |
| `src/ui/ui.ts` | ~160 | TUI dashboard widget | Yes |
| `src/ui/commands.ts` | ~150 | Slash commands | Yes |

---

## 12. Common Anti-Patterns to Avoid

### ❌ Adding I/O to transitions.ts

```typescript
// WRONG — transitions.ts must be pure
function applyStepResult(state, result) {
  const file = fs.readFileSync("workflow.json");  // ❌ NO I/O!
  // ...
}
```

**Instead:** I/O belongs in `engine.ts`. The pattern is always:

```typescript
// engine.ts
const state = readWorkflow(projectRoot, featurePath);
const result = applyStepResult(state, ...);  // pure call
writeWorkflow(projectRoot, featurePath, result.state);
```

### ❌ Adding domain-specific logic to the engine

```typescript
// WRONG — engine is domain-agnostic
function startFeatureBuild(featureName) {  // ❌ Domain-specific!
  // ...
}
```

**Instead:** The reference agents and flows define the domain. The engine works with any flow.

### ❌ Letting subagents advance workflow state

```typescript
// WRONG — subagents must NOT call flow_step_complete
// Only the supervisor (LLM) can advance state
```

**Enforced by:** `applyStepResult` checks `step.status === "running"`. Subagents don't hold running step status.

### ❌ Mutating the original flow definition after start

```typescript
// WRONG — flow was deep-cloned at start
const flow = { id: "feature-build", steps: [...] };
engine.start(flow, ...);
flow.steps.push({ agent: "extra" });  // ❌ No effect on snapshot!
```

### ❌ Writing workflow.json without temp-file atomicity

```typescript
// WRONG — risk of partial writes on crash
fs.writeFileSync("workflow.json", data);  // ❌ Not atomic!
```

### ❌ Importing Pi types into the engine layer

```typescript
// WRONG — engine has no Pi dependencies
import { ExtensionAPI } from "@earendil-works/pi-coding-agent";  // ❌
```

**The engine layer (`src/engine/` and `src/shared/`) must have zero Pi imports.**

### ❌ Putting approval logic in the flow definition

```typescript
// WRONG — approval UI is owned by the agent manifest, not the flow
const flow = {
  steps: [{
    agent: "plan",
    approval: { header: "Review", options: [...] }  // ❌ Flow doesn't own this!
  }]
};
```

**Instead:** The flow only sets `requestApproval: true`. The agent .md file owns the approval dialog structure.

### ❌ Skipping validation on subagent manifest loading

```typescript
// WRONG — subagents have their own validation requirements
// They cannot: ask_user_question, subagent tool, parallel, approval, nested subagents
```

**Always validate subagent manifests with the same rigor as main agents.**

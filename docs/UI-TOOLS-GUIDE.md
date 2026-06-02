# Project Builder — UI Tools & Commands Guide

> **Audience:** New users learning the workflow lifecycle, and contributors planning feature changes.
> **Scope:** Every UI entry point (`/project-builder`, all 9 `flow_*` tools, the TUI Step Summary Widget) traced through all 5 layers.

---

## 1. Architecture Overview

### The Five Layers

Every UI entry point descends through these layers:

```
┌──────────────────────────────────────────────────┐
│ 1. Tools / Commands / Widget  (src/ui/)          │  ← User/LLM calls this
│    tools.ts  ·  commands.ts  ·  step-summary-widget.ts
├──────────────────────────────────────────────────┤
│ 2. Engine  (src/engine/engine.ts)                │  ← I/O boundary, orchestration
│    start()  step()  stepComplete()  recordGate()  │
│    stepUpdate()  status()  list()  abort()         │
├──────────────────────────────────────────────────┤
│ 3. Transitions  (src/engine/transitions.ts)      │  ← Pure state machine (no I/O)
│    createWorkflowState()  startStep()             │
│    applyStepResult()  applyGateAnswer()           │
├──────────────────────┬───────────────────────────┤
│ 4. Persistence       │ 5. Agent Loader             │
│    (src/shared/      │    (src/engine/             │
│     persistence.ts)  │     agent-loader.ts)        │
│    readWorkflow()    │    loadAgent()              │
│    writeWorkflow()   │    loadFlowAgents()         │
│    (atomic tmp→rename)│   validateFlowApproval()    │
└──────────────────────┴───────────────────────────┘
```

Layers 2–5 are **pure Node.js — zero Pi imports**. Only Layer 1 depends on Pi packages.

### All 11 Entry Points

| # | Entry Point | Type | What it does |
|---|------------|------|-------------|
| 1 | `/project-builder` | Slash command | Interactive flow selection, naming, start/resume |
| 2 | `flow_start` | Tool | Start new workflow — freezes `flow_snapshot` |
| 3 | `flow_step` | Tool | Load step instructions, mark step `running` |
| 4 | `flow_step_update` | Tool | Report incremental progress (phase, child runs) |
| 5 | `flow_step_complete` | Tool | Submit `success`/`error` — advances state machine |
| 6 | `flow_record_gate` | Tool | Answer an approval gate (user's choice) |
| 7 | `flow_continue` | Tool | Auto-detect state: gate → present, in_progress → step |
| 8 | `flow_status` | Tool | Read current state (also renders TUI lines) |
| 9 | `flow_list` | Tool | List all runs in `.temp/` |
| 10 | `flow_abort` | Tool | Mark workflow as `abandoned` |
| 11 | Step Summary Widget | TUI widget | Live expanded view of current step + subagent runs |

### The Complete Lifecycle (Beginner's Journey)

```
 /project-builder
      │
      ▼
 flow_start ──── writes workflow.json, freezes snapshot
      │
      ▼
 flow_step ◄──────────────────────────────────────┐
      │                                            │
      ▼                                            │
 [LLM executes agent, may call flow_step_update]   │
      │                                            │
      ▼                                            │
 flow_step_complete ──────────────────────────────┤ (retry)
      │                                            │
   ┌──┴──────────┐                                 │
   ▼             ▼                                 │
[advance]    [gate → ask_user_question]            │
   │             │                                 │
   │        flow_record_gate ──────────────────────┘
   │             │
   ▼             ▼
flow_step    [done/abort]

Throughout: TUI Widget auto-updates live step status
             flow_status / flow_list available anytime
```

---

## 2. Per-Tool Reference

Each tool section follows this format:

- **When & why** — beginner context
- **Layer trace** — exact call chain through all 5 layers
- **State before/after** — concrete `WorkflowState` diff
- **Connections** — what precedes and follows
- **Error handling** — what can go wrong

---

### 2.1 `/project-builder` (Slash Command)

**When & why:** First thing a user does. Start an interactive Pi session, type `/project-builder`, pick a flow, name the feature, and either start a new run or resume an existing one.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Commands** | `ctx.ui.select("Select a flow", ...)` → `ctx.ui.input("Project name", ...)` → either resumes or calls `startNewWorkflow()`. On resume: sends `flow_continue` message to LLM. On start: sends `flow_step` message. |
| **Engine** | `engine.list(projectRoot)` to discover runs. `engine.status(projectRoot, fp)` per run. If starting new: `engine.validateFlows([flow])` → `engine.start(flow, featureName, projectRoot)`. |
| **Transitions** | `createWorkflowState(flow, featureName, featurePath, projectRoot, serviceDirs)` — deep-clones flow, initializes steps as `pending`. |
| **Persistence** | `writeWorkflow()` — atomic write to `.temp/{featurePath}/workflow.json`. |
| **Agent Loader** | `validateFlowApproval()` — checks every `requestApproval: true` step has an approval block. Throws at start if missing. |

**State before/after:** Creates the first `workflow.json`:

```jsonc
// AFTER: workflow.json
{
  "schema_version": 1,
  "feature": "user-auth",
  "feature_path": "01-06-2026-user-auth",
  "status": "in_progress",
  "current_step_index": 0,
  "steps": [
    { "index": 0, "agent": "gather-input", "status": "pending", "attempt": 0 },
    { "index": 1, "agent": "discover",      "status": "pending", "attempt": 0 },
    // ... 6 more
  ],
  "flow_snapshot": { /* deep-cloned FlowDefinition */ }
}
```

**Connections:** After this, the LLM must call `flow_step` (or `flow_continue`) to load the first step.

**Error handling:** Flow validation failure (missing approval block, invalid agent reference, unknown tool) throws before any file is written. Multiple active workflows without an explicit `featurePath` throws an ambiguity error.

---

### 2.2 `flow_start` (Tool)

**When & why:** Programmatic alternative to `/project-builder`. The LLM calls this directly with an inline `FlowDefinition` and `featureName`. Less common — `/project-builder` is the primary entry point.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | Validates `projectRoot` (defaults to `cwd`). Calls `engine.validateFlows([flow])` then `engine.start(flow, name, projectRoot, { serviceDirs })`. Returns step list with current step marked. Triggers `onStateChange()` for TUI widget refresh. |
| **Engine** | `validateFlows()` → `loadFlowAgents()` (all agent .md + subagents) → `validateFlowApproval()`. Then `start()` → `resolveFeaturePath("user-auth")` → `createWorkflowState()` → `writeWorkflow()`. |
| **Transitions** | `createWorkflowState(flow, feature, path, projectRoot, serviceDirs)` — `JSON.parse(JSON.stringify(flow))` deep clone, maps each `FlowStep` to `WorkflowStep` with `status: "pending"`, `attempt: 0`. |
| **Persistence** | `resolveFeaturePath("user-auth")` → `"01-06-2026-user-auth"`. `writeWorkflow()` → `.workflow.json.tmp` → `renameSync`. |
| **Agent Loader** | `loadFlowAgents(agentsDir, flow)` — loads every agent .md referenced in the flow's steps and their subagents. Validates tool whitelists, parallel config, approval blocks. |

**State before/after:** Same as `/project-builder` — creates the initial `workflow.json`.

**Connections:** Must precede `flow_step`. Cannot be called twice for the same feature (creates a new date-stamped directory).

**Error handling:** Same validation errors as `/project-builder`. Also: `agentsDir` resolution failure (no `agents/` directory found, no built-in fallback available).

---

### 2.3 `flow_step` (Tool)

**When & why:** Called at the start of every step. Loads the current step's agent manifest, builds the `StepInstruction` (prompt + tools + subagents), and marks the step `running`. This is the gate between steps — you can't execute without it.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | `engine.step(projectRoot, { featurePath })`. Returns `StepInstruction` as text + full details in metadata (prompt, tools, subagents, expectedOutputs, lastFeedback, etc.). Triggers `onStateChange()`. |
| **Engine** | `step()` → `resolveWorkflow()` → `startStep(state)` → `writeWorkflow()` → `getCachedAgent(agentsDir, flowStep.agent)` → wraps prompt with `workspacePrefix()` + optional `APPROVAL_INSTRUCTION` + `completionSuffix()`. Loads all subagent manifests via `getCachedAgent(agentsDir, subagentPath, true)` and wraps each with `SUBAGENT_COMPLETION_SUFFIX`. Returns `StepInstruction`. |
| **Transitions** | `startStep(state)` — marks current step `pending → running`. Sets `started_at`, clears `completed_at` and `result`, initializes `activity: { status: "working", phase: "starting", message: "Starting {agent}" }`, increments `attempt`. Idempotent if already `running`. |
| **Persistence** | `resolveWorkflow(projectRoot, featurePath?)` — without explicit path, auto-detects single active workflow. `writeWorkflow()` persists the `running` status. |
| **Agent Loader** | `getCachedAgent()` — reads .md from disk, caches by mtime. Parses frontmatter → `AgentManifest`. For subagents: same but with subagent tool restrictions enforced. |

**State before/after:**

```diff
  "current_step_index": 0,
  "steps": [
-   { "index": 0, "agent": "gather-input", "status": "pending", "attempt": 0 }
+   { "index": 0, "agent": "gather-input", "status": "running", "attempt": 1,
+     "started_at": "2026-06-01T10:00:00.000Z",
+     "activity": { "status": "working", "phase": "starting",
+                   "message": "Starting gather-input", "updated_at": "..." }
+   }
  ]
```

**Connections:** Must follow `flow_start` (or previous `flow_step_complete` with `advance`). Must precede `flow_step_complete`. May be interleaved with multiple `flow_step_update` calls.

**Error handling:** Workflow is `awaiting_user` → throws "answer the active gate first". Workflow not `in_progress` → returns null. No active workflow found → returns null with message.

---

### 2.4 `flow_step_update` (Tool)

**When & why:** Called mid-step to report progress. Use this before starting a major phase, fanning out subagents, or when blocked. The TUI widget reads this activity to show live status. Can be called many times per step.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | `engine.stepUpdate({ phase, message, status, childRunIds, currentTool, currentPath }, projectRoot, featurePath)`. Enriches result with `listCorrelatedSubagentRuns()`. Triggers `onStateChange()`. |
| **Engine** | `stepUpdate()` → `resolveWorkflow()` → `updateStepActivity()` → `writeWorkflow()`. |
| **Transitions** | `updateStepActivity(state, update)` — validates workflow is `in_progress` and step is `running`. Merges partial fields into `step.activity`: `phase`, `message`, `status`, `child_run_ids` (deduplicated), `current_tool`, `current_path`. Sets `updated_at` to now. Returns error if stepIndex mismatch. |
| **Persistence** | `writeWorkflow()` after each update. |
| **Agent Loader** | Not invoked. |

**State before/after:**

```diff
  "activity": {
-   "status": "working", "phase": "starting", "message": "Starting gather-input"
+   "status": "working", "phase": "reading plan",
+   "message": "Loaded plan.md, preparing implementation",
+   "current_tool": "read", "current_path": ".temp/01-06-2026-user-auth/plan.md",
+   "child_run_ids": ["abc123", "def456"],
+   "updated_at": "2026-06-01T10:05:00.000Z"
  }
```

**Connections:** Can only be called while a step is `running` (after `flow_step`, before `flow_step_complete`). The TUI widget and `flow_status` both consume this activity data.

**Error handling:** Workflow not `in_progress` → error. Step not `running` → error ("call flow_step first"). StepIndex mismatch → error.

---

### 2.5 `flow_step_complete` (Tool)

**When & why:** The supervisor calls this after finishing the step's work. Accepts `"success"` or `"error"`. This is the **only tool that advances the state machine** — it's the most critical transition point.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | `engine.stepComplete({ result, message, retryable, metadata }, projectRoot, { featurePath })`. On gate: returns gate header + instructions to use `ask_user_question`. On done/block: renders full status via `renderWorkflowStatus()`. Triggers `onStateChange()`. |
| **Engine** | `stepComplete()` → `resolveWorkflow()` → **Strict output check**: if `result === "success"` and `strictOutputs` (default `true`), calls `verifyExpectedOutputs()` → checks agent's declared `outputs` exist on disk. Missing → blocks with error. Then builds `loadGate` closure (caches agent), calls `applyStepResult(state, result, loadGate)` → `writeWorkflow()`. |
| **Transitions** | `applyStepResult(state, result, loadGate)` — the core transition: <br>• **Success + no approval**: step → `completed`, `current_step_index++`, return `"advance"`. If last step → `"done"`. <br>• **Success + approval**: step → `completed`, workflow → `awaiting_user`, builds gate via `loadGate()`, returns `"gate"`. <br>• **Error + retryable + attempts remain**: step → `failed` → reset to `pending`, return `"retry"`. <br>• **Error + non-retryable or exhausted**: step → `failed`, workflow → `blocked`, return `"block"`. |
| **Persistence** | `writeWorkflow()` after transition. |
| **Agent Loader** | `loadGate()` closure calls `getCachedAgent(agentsDir, agent)` → `buildGate(manifest, stepIndex)`. Validates gate exists (returns null if missing → `"block"`). |

**State before/after (success + advance):**

```diff
  "current_step_index": 0 → 1,
  "steps": [
-   { "index": 0, "status": "running", "attempt": 1 }
+   { "index": 0, "status": "completed", "attempt": 1,
+     "result": { "result": "success", "message": "Gathered input" },
+     "completed_at": "2026-06-01T10:10:00.000Z" }
  ]
```

**State before/after (success + gate):**

```diff
- "status": "in_progress",
+ "status": "awaiting_user",
+ "awaiting": "user_gate",
+ "gate": {
+   "header": "Feature Input",
+   "options": [{ "label": "Proceed", "advance": true }, ...],
+   "stepIndex": 0
+ }
```

**State before/after (error + retry):**

```diff
- { "index": 4, "status": "running", "attempt": 1 }
+ { "index": 4, "status": "pending",  "attempt": 1,
+   "result": { "result": "error", "message": "Build failed" }
+ }
  // Next flow_step will increment attempt to 2
```

**Connections:** Must follow `flow_step`. If returns `"advance"` → next call is `flow_step`. If `"gate"` → next is `ask_user_question` then `flow_record_gate`. If `"retry"` → next is `flow_step` (re-run same step). If `"done"` → no further calls. If `"block"` → manual intervention.

**Error handling:** Workflow `awaiting_user` → blocked (must answer gate first). Step not `running` → blocked (must call `flow_step` first). Missing approval block on gated step → blocked. Strict output files missing → blocked with list of missing files. Non-strict mode → warnings only, still advances.

---

### 2.6 `flow_record_gate` (Tool)

**When & why:** After the LLM presents gate options via `ask_user_question` and the user picks one, the LLM calls this to record the answer. Critical: must only be called **after** the user explicitly answers — never auto-answered.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | Reads current state via `engine.status()`. Validates gate exists. If no `chosenLabel` but exactly 1 option matches `advance`/`abort`, auto-resolves. Calls `engine.recordGate({ stepIndex, chosenLabel, advance, abort, feedback }, projectRoot, featurePath)`. Triggers `onStateChange()`. |
| **Engine** | `recordGate()` → `resolveWorkflow()` → `applyGateAnswer(state, answer)` → `writeWorkflow()`. |
| **Transitions** | `applyGateAnswer(state, answer)` — validates workflow is `awaiting_user` with a gate, stepIndex matches, chosen option exists, `advance`/`abort` match option values, feedback present if required. <br>• **advance: true** → `current_step_index++`, workflow → `in_progress` (or `done` if last step). <br>• **advance: false, abort: true** → workflow → `abandoned`. <br>• **advance: false** → step reset to `pending`, `last_feedback` persisted, workflow → `in_progress` (retry). |
| **Persistence** | `writeWorkflow()` after transition. |
| **Agent Loader** | Not invoked (gate was already built at `flow_step_complete` time). |

**State before/after (approve):**

```diff
  "status": "awaiting_user" → "in_progress",
- "awaiting": "user_gate",
- "gate": { "header": "Feature Input", ... },
  "current_step_index": 0 → 1
```

**State before/after (reject with feedback):**

```diff
  "status": "awaiting_user" → "in_progress",
- "awaiting": "user_gate",
- "gate": { ... },
  "steps": [{
-   "status": "completed", "result": { "result": "success", ... }
+   "status": "pending", "last_feedback": "Missing edge cases in error handling",
+   "result": undefined, "completed_at": undefined, "activity": undefined
  }]
```

**State before/after (abort):**

```diff
- "status": "awaiting_user",
+ "status": "abandoned",
+ "build_status": "BLOCKED"
```

**Connections:** Must follow `flow_step_complete` with `action: "gate"` + `ask_user_question`. On advance → next is `flow_step`. On retry → next is `flow_step` (LLM sees `lastFeedback` in `StepInstruction`). On abort → terminal.

**Error handling:** No active gate → "No active gate to answer". Step index mismatch → blocked. Unknown option label → blocked. `advance`/`abort` mismatch with option → blocked. Missing required feedback → blocked. Multiple matching options without `chosenLabel` → "Pass chosenLabel".

---

### 2.7 `flow_continue` (Tool)

**When & why:** Convenience tool that auto-detects the workflow state and does the obvious next thing. If `awaiting_user` → returns gate options for presentation. If `in_progress` → calls `flow_step`. If `done`/`blocked`/`abandoned` → returns status. The `/project-builder` resume flow sends this to the LLM.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | `engine.status()` → branches: <br>• `awaiting_user` → renders gate options, instructs LLM to use `ask_user_question`. <br>• not `in_progress` → renders full status. <br>• `in_progress` → `engine.step()` (same as `flow_step`). |
| **Engine** | Either `status()` only, or `step()` (same trace as `flow_step`). |
| **Transitions** | Either none (read-only), or `startStep()` (if stepping). |
| **Persistence** | `readWorkflow()` for status; `writeWorkflow()` if stepping. |
| **Agent Loader** | `getCachedAgent()` if stepping (same as `flow_step`). |

**State before/after:** Read-only for gate/done/blocked. If stepping: same as `flow_step`.

**Connections:** The `/project-builder` resume path. Can be called at any point as a "what do I do next?" query.

**Error handling:** No active workflow → message to start one. `in_progress` but `step()` returns null (terminal step) → message.

---

### 2.8 `flow_status` (Tool)

**When & why:** Read-only inspection of the current workflow state. Use any time to check progress, see which step is active, or view gate options. The TUI widget calls the same engine function internally.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | `engine.status(projectRoot, featurePath)`. If `in_progress` → returns concise current step + child runs from `listCorrelatedSubagentRuns()`. Otherwise → renders full status via `renderWorkflowStatus()`. |
| **Engine** | `status()` → `resolveWorkflow()` → `readWorkflow()`. Pure read — no mutations. |
| **Transitions** | Not invoked. |
| **Persistence** | `readWorkflow()` only. |
| **Agent Loader** | Not invoked. |

**State before/after:** No state change (read-only).

**Connections:** Available at any time, any workflow state. Used by TUI widget for live rendering. Used by tools to discover current state before acting.

**Error handling:** No active workflow → message to start one. Invalid featurePath → "No workflow found".

---

### 2.9 `flow_list` (Tool)

**When & why:** List all workflow runs in the project. Shows feature paths with status icons (✅ done, ❌ blocked, ◦ in progress). Useful for discovering what runs exist.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | `engine.list(projectRoot)` → for each path, `engine.status(projectRoot, fp)` to get status icon. |
| **Engine** | `list()` → `listWorkflows()` → reads `.temp/` directory. `status()` per path → `readWorkflow()` each. |
| **Transitions** | Not invoked. |
| **Persistence** | `listWorkflows()` — reads `.temp/` directory entries, filters to directories containing `workflow.json`. `readWorkflow()` per run. |
| **Agent Loader** | Not invoked. |

**State before/after:** No state change (read-only).

**Connections:** Used by `/project-builder` to discover active runs for the resume menu.

**Error handling:** Empty `.temp/` → "No workflow runs found."

---

### 2.10 `flow_abort` (Tool)

**When & why:** Mark a workflow as `abandoned`. Does not delete files — artifacts remain in `.temp/{featurePath}/`. Use when the user chooses to exit via an abort gate option, or to manually kill a blocked workflow.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Tools** | `engine.abort(projectRoot, featurePath)`. Triggers `onStateChange()` to clear the TUI widget. |
| **Engine** | `abort()` → `resolveWorkflow()` → sets `state.status = "abandoned"` → `writeWorkflow()`. |
| **Transitions** | Not invoked (direct state mutation in engine.ts). |
| **Persistence** | `writeWorkflow()` with `status: "abandoned"`. |
| **Agent Loader** | Not invoked. |

**State before/after:**

```diff
- "status": "in_progress" | "awaiting_user" | "blocked"
+ "status": "abandoned"
```

**Connections:** Terminal — no further engine calls except `flow_status`/`flow_list`. The `flow_record_gate` with `abort: true` achieves the same result through the state machine.

**Error handling:** No active workflow → "No active workflow to abort."

---

### 2.11 Step Summary Widget (TUI)

**When & why:** A live dashboard widget rendered above the editor during Pi sessions. Shows the current step's phase, tool, path, model, and child subagent activity tree. Auto-refreshes every 200ms while a step is running.

**Layer trace:**

| Layer | Call |
|-------|------|
| **Widget** | Registered via `ctx.ui.setWidget()` on `session_start`. Render loop: `engine.status(projectRoot)` → `listCorrelatedSubagentRuns(state, 8)` → builds ASCII tree of step details + child run status. `requestRender` callback wired to tool `onStateChange()`. |
| **Engine** | `status()` — same as `flow_status`. |
| **Subagent Activity** | `listCorrelatedSubagentRuns(state, limit)` — scans `/tmp/pi-subagents-{uid}/async-subagent-runs/`, reads `status.json` per run, matches to current workflow via `child_run_ids` or `workflow` metadata (projectRoot, featurePath, stepIndex). Returns `WorkflowChildRun[]` with step-level detail (agent, status, tool count, tokens, duration, current tool). |
| **Transitions** | Not invoked. |
| **Persistence** | Reads `workflow.json` via `readWorkflow()`. Reads subagent `status.json` files from Pi's temp directories. |
| **Agent Loader** | Not invoked. |

**State before/after:** Read-only — widget never mutates state.

**Rendered layout:**
```
━ Step 4/8: implement · working · 32s
 ┃ Phase: fanning out workers
 ┃ Tool: subagent · Path: src/auth/
 ┃
 ┃ Child runs · 3/5 done · 1 running · 12k tokens:
 ┃  ✓ worker · 3/5 done · 1 running · 12k
 ┃    ✓ step 1: worker · complete · 8s · 3 tools · 4k tokens
 ┃    > step 1: worker · running · 5s · tool: read src/auth/login.ts
 ┃    ◦ step 2: worker · pending
```

**Connections:** `onStateChange` callback is called by every mutating tool (`flow_start`, `flow_step`, `flow_step_update`, `flow_step_complete`, `flow_record_gate`, `flow_abort`). The widget invalidates its cache and requests a TUI re-render.

---

## 3. Connection Map

### Allowed Sequences

```
flow_start ──→ flow_step ──→ flow_step_update* ──→ flow_step_complete
                  ▲                                      │
                  │                    ┌──────────────────┤
                  │                    ▼                  ▼
                  │              [advance]           [gate]
                  │                    │                  │
                  │                    │           ask_user_question
                  │                    │                  │
                  │                    │          flow_record_gate
                  │                    │            ┌───┼───┐
                  │                    │            ▼   ▼   ▼
                  │                    │       [advance][retry][abort]
                  │                    │            │   │    │
                  └────────────────────┴────────────┘   │    │
                                                        │    │
                                              flow_step─┘    │
                                                          terminal

flow_continue  ──→  (acts as flow_step or gate-presenter depending on state)
flow_status    ──→  (available in ANY state)
flow_list      ──→  (available in ANY state)
flow_abort     ──→  (available in in_progress / awaiting_user / blocked)
```

### State-Dependent Availability

| Tool | `in_progress` | `awaiting_user` | `blocked` | `done` | `abandoned` |
|------|:---:|:---:|:---:|:---:|:---:|
| `flow_start` | N/A (creates new) | N/A | N/A | N/A | N/A |
| `flow_step` | ✅ | ❌ throws | ❌ null | ❌ null | ❌ null |
| `flow_step_update` | ✅ | ❌ error | ❌ error | ❌ error | ❌ error |
| `flow_step_complete` | ✅ | ❌ blocked | ❌ blocked | ❌ null | ❌ null |
| `flow_record_gate` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `flow_continue` | ✅ (steps) | ✅ (presents gate) | ✅ (status) | ✅ (status) | ✅ (status) |
| `flow_status` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `flow_list` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `flow_abort` | ✅ | ✅ | ✅ | ❌ | ❌ |

---

## 4. Future Feature Guidance

For each common feature request, here's exactly which layers to change:

### Adding a new tool (e.g., `flow_pause`, `flow_resume`)

| Layer | What to do |
|-------|-----------|
| **Tools** (`tools.ts`) | Add `pi.registerTool({ name: "flow_pause", ... })` with TypeBox schema, `renderCall`, `renderResult`, and `execute`. |
| **Engine** (`engine.ts`) | Add `pause(projectRoot, featurePath?)` — reads state, calls transition, writes state. |
| **Transitions** (`transitions.ts`) | Add `pauseWorkflow(state)` — pure function returning new state with maybe a new `WorkflowStatus`. |
| **Persistence** | No change (uses existing `writeWorkflow`). |
| **Types** (`types.ts`) | Add new `WorkflowStatus` variant if needed. |

### Adding a new workflow status (e.g., `paused`)

| Layer | What to do |
|-------|-----------|
| **Types** | Add `"paused"` to `WorkflowStatus` union. |
| **Transitions** | Handle `"paused"` in all transition functions (what happens if you `step`/`stepComplete` while paused?). Update `cloneState` if new fields needed. |
| **Workflow Renderer** | Add glyph/status rendering for `"paused"`. |
| **Tools** | Update `flow_status` and `flow_list` to handle the new status in rendering. |
| **Widget** | Handle `"paused"` in step summary rendering. |
| **Persistence** | Update `findActiveWorkflows()` if `"paused"` should be treated as active. |

### Changing the approval gate behavior

| Layer | What to do |
|-------|-----------|
| **Agent Manifest** (`agents/*.md`) | Change the `approval` block — add/remove options, change labels, change `advance`/`abort`/`feedback` flags. No code changes needed. |
| **Agent Loader** | If adding new `ApprovalOption` properties, update validation in `parseManifest()` and the `ApprovalManifest` type. |
| **Transitions** | If adding new gate action types beyond `advance`/`retry`/`abort`, update `applyGateAnswer()`. |

### Adding pre-step validation hooks

| Layer | What to do |
|-------|-----------|
| **Transitions** | Add validation logic in `startStep()` or a new function called before `startStep()`. |
| **Engine** | Call the new validation in `step()` before `startStep()`. If it fails, return error instead of `StepInstruction`. |
| **Types** | Add validation error types if structured errors are needed. |

### Changing persistence (e.g., SQLite instead of JSON files)

| Layer | What to do |
|-------|-----------|
| **Persistence** (`persistence.ts`) | Replace file I/O functions with SQLite queries. Keep the same function signatures (`readWorkflow`, `writeWorkflow`, `listWorkflows`, `resolveWorkflow`). |
| **Engine** | No change — engine only calls persistence functions, doesn't know about file vs. DB. |
| **All other layers** | No change. |

### Adding TUI widget features

| Layer | What to do |
|-------|-----------|
| **Widget** (`step-summary-widget.ts`) | Add rendering logic for new data. |
| **Workflow Renderer** (`workflow-renderer.ts`) | If new rendering helpers are needed for text-mode display (used by both widget and `flow_status`). |
| **Subagent Activity** (`subagent-activity.ts`) | If new subagent metadata fields are needed, update `listCorrelatedSubagentRuns()` to extract them from `status.json`. |

### Adding a new slash command (e.g., `/pb-status`)

| Layer | What to do |
|-------|-----------|
| **Commands** (`commands.ts`) | Add `pi.registerCommand("pb-status", { ... })`. Use `engine.status()` and `engine.list()`. |
| **All other layers** | No change — the command consumes existing engine APIs. |

### Key Design Invariants (never break these)

1. **`transitions.ts` must stay pure** — no I/O, no Pi imports. If you need I/O, put it in `engine.ts`.
2. **Subagents never call `flow_step_complete`** — only the supervising LLM advances state.
3. **Workflows are frozen at `flow_start`** — the `flow_snapshot` is a deep clone. Mid-run mutations to the original `FlowDefinition` have no effect.
4. **Atomic writes** — always write to `.tmp` then rename.
5. **Missing approval blocks fail fast** — validated at `flow_start` (and caught again at `stepComplete` as a safety net).

---

## 5. Quick Reference: Engine API → Tool Mapping

| Engine Function | Called by which tool(s) |
|----------------|------------------------|
| `validateFlows()` | `flow_start`, `/project-builder` |
| `start()` | `flow_start`, `/project-builder` |
| `step()` | `flow_step`, `flow_continue` |
| `stepComplete()` | `flow_step_complete` |
| `stepUpdate()` | `flow_step_update` |
| `recordGate()` | `flow_record_gate` |
| `status()` | `flow_status`, `flow_list`, `flow_continue`, `flow_record_gate`, Step Summary Widget |
| `list()` | `flow_list`, `/project-builder` |
| `abort()` | `flow_abort` |

## 6. Quick Reference: Transition → Tool Mapping

| Transition Function | Called when | Action Return Values |
|--------------------|-------------|---------------------|
| `createWorkflowState()` | `flow_start` | Returns `WorkflowState` |
| `startStep()` | `flow_step`, `flow_continue` | Mutates state in place, returns new state |
| `updateStepActivity()` | `flow_step_update` | Returns `{ state, error? }` |
| `applyStepResult()` | `flow_step_complete` | Returns `{ action: "advance"\|"retry"\|"gate"\|"block"\|"done" }` |
| `applyGateAnswer()` | `flow_record_gate` | Returns `{ action: "advance"\|"retry"\|"block"\|"done"\|"abort" }` |

---

## 7. Quick Reference: Files Touched Per Operation

| Operation | `types.ts` | `persistence.ts` | `transitions.ts` | `agent-loader.ts` | `engine.ts` | `workflow-renderer.ts` | `subagent-activity.ts` |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `flow_start` | ✅ types | ✅ write | ✅ create | ✅ load+validate | ✅ orchestrate | | |
| `flow_step` | ✅ types | ✅ read+write | ✅ startStep | ✅ load agent | ✅ orchestrate | | |
| `flow_step_update` | ✅ types | ✅ read+write | ✅ updateActivity | | ✅ orchestrate | | |
| `flow_step_complete` | ✅ types | ✅ read+write | ✅ applyResult | ✅ loadGate | ✅ orchestrate | | |
| `flow_record_gate` | ✅ types | ✅ read+write | ✅ applyGate | | ✅ orchestrate | | |
| `flow_continue` | ✅ types | ✅ read (+write if stepping) | ✅ startStep (if stepping) | ✅ load agent (if stepping) | ✅ orchestrate | | |
| `flow_status` | ✅ types | ✅ read | | | ✅ orchestrate | ✅ render | ✅ correlate |
| `flow_list` | ✅ types | ✅ read | | | ✅ orchestrate | | |
| `flow_abort` | ✅ types | ✅ write | | | ✅ orchestrate | | |
| TUI Widget | ✅ types | ✅ read | | | ✅ status() | ✅ render | ✅ correlate |

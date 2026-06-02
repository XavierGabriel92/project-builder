# Engine State Machine

This document describes the workflow state machine in `src/engine/transitions.ts` — the **pure function core** that determines how workflow state advances.

---

## 1. Workflow States

```
                        ┌──────────┐
               ┌─────── │ in_progress│ ◀──────────────┐
               │        └─────┬─────┘                │
               │              │                      │
               │              ▼                      │
               │        ┌──────────┐                 │
               │        │   gate   │                 │
               │        │ (success │                 │
               │        │  + user  │                 │
               │        │ approval)│                 │
               │        └────┬─────┘                 │
               │             │                       │
               │             ▼                       │
               │        ┌──────────────┐             │
               ├─────── │ awaiting_user │ ────────────┘
               │        └──────┬───────┘  (user approves → advance)
               │               │
               │               │ (user rejects → retry)
               │               ▼
               │          ┌──────────┐
               │          │  retry   │
               │          └────┬─────┘
               │               │
               └───────────────┘

               ┌──────────┐
               │  blocked │  (error, non-retryable, or retries exhausted)
               └──────────┘

               ┌──────────┐
               │   done   │  (all steps completed)
               └──────────┘

               ┌────────────┐
               │ abandoned  │  (user chose abort in gate)
               └────────────┘
```

### State Descriptions

| State | Meaning | Transition Out |
|-------|---------|----------------|
| `in_progress` | A step is currently executing or ready to execute | `startStep` marks step running |
| `awaiting_user` | Step completed with success + `requestApproval`, waiting for user gate answer | `applyGateAnswer` → advance/retry/abort |
| `blocked` | Non-retryable error, or retries exhausted | Manual intervention only (no engine transition out) |
| `done` | All steps completed successfully | Terminal |
| `abandoned` | User chose an abort option in gate | Terminal |

---

## 2. Step States

```
              ┌──────────────┐
              │    pending    │ ◀─────────────────────────┐
              └───────┬──────┘                           │
                      │ startStep()                      │
                      ▼                                  │
              ┌──────────────┐                            │
              │   running    │                            │
              └───────┬──────┘                            │
                      │ applyStepResult()                 │
                      ▼                                   │
              ┌──────────────┐   ┌───────────┐            │
              │   completed  │   │  failed   │────────────┘
              │   (success)  │   │ (error)   │  (retryable
              └──────────────┘   └─────┬─────┘   or gate
                                       │          rejection)
                                       │ (non-retryable
                                       │  or exhausted)
                                       ▼
                                  ┌───────────┐
                                  │  failed   │
                                  │ (terminal)│
                                  └───────────┘
```

**Retry paths:**
- **Error retry**: `running` → `failed` (retryable) → resets to `pending` with incremented attempt counter
- **Gate rejection retry**: step resets from `completed` (gate) → `pending` with `last_feedback` persisted

---

## 3. State Machine Functions

### 3.1 `createWorkflowState(flow, feature, featurePath, projectRoot, serviceDirs?)`

Creates the initial `WorkflowState` from a `FlowDefinition`.

**Behavior:**
- Deep-clones `flow` into `flow_snapshot` (prevents mutation leaks)
- Creates `WorkflowStep[]` with all statuses initialised to `"pending"` and `attempt: 0`
- Sets `current_step_index: 0`, `status: "in_progress"`

**Key detail:** The deep clone uses `JSON.parse(JSON.stringify(flow))`. This means the snapshot is frozen at start time.

### 3.2 `startStep(state)`

Marks the current step as running.

**State transitions:**
- `pending` → `running`
- `running` → `running` (idempotent, no-op)
- Not `"pending"` → no-op

**Side effects on state:**
- `started_at` set to `new Date().toISOString()`
- `completed_at` cleared
- `result` cleared
- `activity` initialized with `{ status: "working", phase: "starting", message: "Starting {agent}" }`
- `attempt` incremented by 1

### 3.3 `updateStepActivity(state, update)`

Merges supervisor-submitted incremental activity into the current running step.

**Validation:**
- Workflow must be `"in_progress"`
- Step must be `"running"` (must call `flow_step` first)
- `stepIndex` must match `current_step_index`

**Behavior:**
- Merges partial fields: `phase`, `message`, `status`, `childRunIds`, `currentTool`, `currentPath`
- `childRunIds` are deduplicated and trimmed
- `updated_at` is always set to current time

### 3.4 `applyStepResult(state, result, loadGate)`

The **core transition function**. Submitting a step result triggers the main state machine logic.

```typescript
function applyStepResult(
  state: WorkflowState,
  result: StepResult,
  loadGate: (agent: string, stepIndex: number) => WorkflowGate | null
): StepTransition
```

**Validation:**
- Current step must exist
- Workflow must not be `"awaiting_user"` (gate must be answered first)
- Step must be `"running"` (must call `flow_step` first)

**On success (`result.result === "success"`):**
1. Step status → `"completed"`
2. If `flowStep.requestApproval === true`:
   - Calls `loadGate(agent, stepIndex)` to build the gate
   - If gate is null → return `{ action: "block", error: "no approval block found" }`
   - Otherwise → `status = "awaiting_user"`, `awaiting = "user_gate"`, return `{ action: "gate", gate }`
3. If no approval needed:
   - `current_step_index++`
   - If index >= steps.length → `status = "done"`, `build_status = "DONE"`, return `{ action: "done" }`
   - Otherwise → return `{ action: "advance" }`

**On error (`result.result === "error"`):**
1. Step status → `"failed"`
2. If `result.retryable !== false` AND `step.attempt < maxAttempts`:
   - Step status → `"pending"` (reset for re-run)
   - `completed_at` cleared
   - Return `{ action: "retry" }`
3. Otherwise (non-retryable or exhausted):
   - `status = "blocked"`, `build_status = "BLOCKED"`
   - Return `{ action: "block" }`

**Metadata merge:**
On success, `result.metadata.service_dirs` (if present) is merged into `state.service_dirs` (deduplicated). This is how the `plan` step communicates service directories to `implement`.

### 3.5 `applyGateAnswer(state, answer)`

Processes the user's answer to an approval gate.

```typescript
function applyGateAnswer(
  state: WorkflowState,
  answer: GateAnswer
): GateTransition
```

**Validation:**
- Workflow must be `"awaiting_user"` with a gate
- `answer.stepIndex` must match `current_step_index`
- The chosen option label must exist in the gate's options
- `advance` and `abort` values must match the chosen option
- If the option requires `feedback`, the answer must provide non-empty feedback (after trimming)

**On advance (`answer.advance === true`):**
1. Clear `awaiting` and `gate`
2. `current_step_index++`
3. If index >= steps.length → `status = "done"`, `build_status = "DONE"`, return `{ action: "done" }`
4. Otherwise → `status = "in_progress"`, return `{ action: "advance" }`

**On rejection (`answer.advance === false`):**
1. Clear `awaiting` and `gate`
2. If `answer.abort === true`:
   - `status = "abandoned"`, `build_status = "BLOCKED"`
   - Return `{ action: "abort" }`
3. Otherwise:
   - Reset step: `status = "pending"`, clear `result`, `completed_at`, `activity`
   - Persist `feedback` trimmed as `last_feedback`
   - `status = "in_progress"`
   - Return `{ action: "retry" }`

---

## 4. Retry Logic

```
Step configured with attempts: 2

attempt 1: result: "error", retryable: true
  → step.status = "failed" → "pending"
  → attempt counter still 1 (incremented at startStep)
  → flow_step → startStep → attempt: 2, step: "running"

attempt 2: result: "error", retryable: true
  → step.attempt (2) >= maxAttempts (2)
  → step.status = "failed", workflow = "blocked"
  → return { action: "block" }
```

**Key detail:** `retryable` defaults to `true` when omitted. To prevent retry, explicitly set `retryable: false`.

---

## 5. Gate Feedback Flow

```
Step with requestApproval: true completes successfully

1. Workflow → "awaiting_user"
2. LLM presents gate options via ask_user_question
3. User chooses "Revise" (advance: false, feedback: true)
4. User types: "The error handling is missing edge cases"
5. LLM calls flow_record_gate({ advance: false, feedback: "The error handling is missing edge cases" })
6. Engine resets step, stores last_feedback = "The error handling is missing edge cases"
7. flow_step returns StepInstruction.lastFeedback = "The error handling is missing edge cases"
8. LLM incorporates feedback into the re-execution
```

---

## 6. Sequence Diagram: Full Workflow Lifecycle

```
┌──────┐   ┌──────────┐   ┌───────────┐   ┌──────────────┐   ┌─────────────┐   ┌───────────┐   ┌────────────┐
  User         LLM           Engine         Transitions        Persistence         Agent          Subagent   
   │        supervisor     (engine.ts)      (transitions      (persistence        (agent-         (scout,    
   │            │               │               .ts)              .ts)          loader.ts)        worker,    
   │            │               │                │                  │                │           reviewer)   
└──┬───┘   └────┬─────┘   └─────┬─────┘   └──────┬───────┘   └──────┬──────┘   └─────┬─────┘   └─────┬──────┘

   │            │ 1. START WORKFLOW              │                  │                │               │       
   │            │──flow_start───►                │                  │                │               │       
   │            │               │validateFlow()──►                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │────────────────│loadFlowAgents()──│────────────────►               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │reateWorkflow()─►                  │                │               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │──────────writeWorkflow()──────────►                │               │       
   │            ◄               │                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │          2. GET STEP INSTRUCTIONS           │                  │                │               │       
   │            │───flow_step───►                │                  │                │               │       
   │            │               │──────────readWorkflow()───────────►                │               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │──startStep()───►                  │                │               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │──────────writeWorkflow()──────────►                │               │       
   │            │               │                │                  │                │               │       
   │            │               │────────────────│───loadAgent()────│────────────────►               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            ◄               │                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │ 3. AGENT EXECUTES              │                  │                │               │       
   │            │───────────────│─────────────dispatch──────────────│────────────────►─────exec──────►       
   │            │               │                │                  │                │worker works...│       
   │            │───────────────│──────────────result───────────────│────────────────◄───────────────◄       
   │            │               │                │                  │                │               │       
   │            │low_step_update►                │                  │                │               │       
   │            │               │pdateActivity()─►                  │                │               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │──────────writeWorkflow()──────────►                │               │       
   │            ◄               │                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │ 4. COMPLETE STEP               │                  │                │               │       
   │            │ow_step_complet►                │                  │                │               │       
   │            │               │──────────readWorkflow()───────────►                │               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │─applyResult()──►                  │                │               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │──────────writeWorkflow()──────────►                │               │       
   │            ◄               │                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │ 5. APPROVAL GATE               │                  │                │               │       
   ◄            │               │                │                  │                │               │       
   │──answer────►               │                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │low_record_gate►                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │applyGateAns()──►                  │                │               │       
   │            │               ◄                │                  │                │               │       
   │            │               │                │                  │                │               │       
   │            │               │──────────writeWorkflow()──────────►                │               │       
   │            ◄               │                │                  │                │               │       
   ◄            │               │                │                  │                │               │       
```

---

## 7. Action Return Types

### StepTransition.action

| Action | Meaning | State Changes | Next Caller Action |
|--------|---------|---------------|-------------------|
| `advance` | Step succeeded, moving to next step | `current_step_index++`, status→`in_progress` | Call `flow_step` for next step |
| `gate` | Step succeeded but needs user approval | status→`awaiting_user`, gate set | Show gate via `ask_user_question` |
| `retry` | Step failed but can retry | Step reset to `pending` | Call `flow_step` for retry |
| `block` | Step failed, no retry possible | status→`blocked` | Manual intervention |
| `done` | All steps complete | status→`done` | No further action needed |

### GateTransition.action

| Action | Meaning | State Changes | Next Caller Action |
|--------|---------|---------------|-------------------|
| `advance` | User approved | `current_step_index++`, status→`in_progress` | Call `flow_step` |
| `retry` | User rejected with feedback | Step reset to `pending`, `last_feedback` set | Call `flow_step` (will see feedback) |
| `abort` | User chose exit | status→`abandoned` | Workflow ended |
| `block` | Invalid gate answer | No state change | Fix the answer and retry |
| `done` | Last step approved | status→`done` | Workflow complete |

---

## 8. State Snapshot Schema

```typescript
interface WorkflowState {
  schema_version: number;          // Always 1 (increment on breaking schema change)
  feature: string;                  // Human-readable name (e.g. "user-auth")
  feature_path: string;             // Directory in .temp/ (e.g. "27-05-2026-user-auth")
  project_root: string;             // Absolute path to project
  flow_id: string;                  // From FlowDefinition
  flow_version: number;             // From FlowDefinition
  flow_snapshot: FlowDefinition;    // Deep-cloned at start time
  current_step_index: number;       // Zero-based index into steps[]
  status: WorkflowStatus;           // "in_progress" | "blocked" | "awaiting_user" | "abandoned" | "done"
  awaiting: AwaitingState;          // null | "user_gate"
  gate?: WorkflowGate;              // Present when awaiting === "user_gate"
  steps: WorkflowStep[];            // One per flow step
  service_dirs?: string[];          // Accumulated across steps
  build_status?: "DONE" | "BLOCKED" | null;
}
```

---

## 9. Key Implementation Details

### 9.1 State Cloning

All transition functions clone state deeply before mutation to avoid side effects:

```typescript
function cloneState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    steps: state.steps.map((s) => ({
      ...s,
      activity: s.activity ? { ...s.activity, child_run_ids: s.activity.child_run_ids ? [...s.activity.child_run_ids] : undefined } : undefined,
    })),
    gate: state.gate ? { ...state.gate, options: [...state.gate.options] } : undefined,
    flow_snapshot: { ...state.flow_snapshot, steps: [...state.flow_snapshot.steps] },
    service_dirs: state.service_dirs ? [...state.service_dirs] : undefined,
  };
}
```

### 9.2 Metadata Accumulation

`service_dirs` accumulate across steps (deduplicated on merge). This lets the `plan` step set service directories and the `implement` and `complete` steps read them without repeating the work.

### 9.3 Feedback Persistence

When a gate is rejected with feedback, the feedback is stored on the specific step (not the workflow). This means if the same step is rejected multiple times, only the most recent feedback is preserved.

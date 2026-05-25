---
name: project-builder-supervisor
description: |
  Run project-builder workflows as the supervisor. Use when starting, stepping,
  completing, gating, or resuming flows through the flow_* tools.
---

# Project Builder Supervisor Runtime

Use this skill when supervising a `project-builder` flow. The orchestrator owns state; you own executing each returned agent prompt and submitting truthful step results.

## Runtime Loop

1. Start a workflow with `flow_start`.
   - Save the returned `featurePath`.
   - Pass `featurePath` explicitly on later tool calls when more than one workflow may be active.

2. Call `flow_step`.
   - Read the returned agent prompt.
   - Respect the returned `tools`, `subagentInstructions`, `parallel`, and `expectedOutputs`.
   - If subagents are returned, use the embedded subagent prompts rather than guessing file paths.

3. Execute the step.
   - Write artifacts into `.temp/{featurePath}/`.
   - Before completing, verify the declared `expectedOutputs` exist.
   - If the step cannot complete, submit `flow_step_complete` with `result: "error"` and set `retryable` truthfully.

4. Complete the step with `flow_step_complete`.
   - Only the supervisor submits step results.
   - Do not let subagents call flow tools.
   - If the step produced `service-dirs.json`, parse it and submit:

```json
{
  "result": "success",
  "message": "Plan approved and service directories recorded",
  "metadata": {
    "service_dirs": ["services/api", "packages/web"]
  }
}
```

5. Handle gates.
   - When UI is available, the extension presents the gate directly.
   - Never fabricate approval decisions.
   - In non-UI mode, ask the user which gate option to choose, then call `flow_record_gate`.

6. Repeat until the workflow is `done`, `blocked`, or `abandoned`.

## Feature Build Artifact Map

| Step | Produces |
|------|----------|
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

## Rules

- Do not call `flow_step` while a gate is awaiting user approval.
- Do not call `flow_step_complete` for a step that was not run.
- Do not mark success if declared outputs are missing unless the missing output is intentionally not applicable and you explain why.
- When multiple workflows are active, always pass `featurePath`.

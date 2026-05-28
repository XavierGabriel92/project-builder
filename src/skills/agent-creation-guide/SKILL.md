---
id: project-builder-agent-creation
description: "Comprehensive guide for creating new agents (main and subagent) in the project-builder flow engine. Covers YAML frontmatter schema, tool selection, subagent wiring, parallel execution, approval gates, prompt design, output declarations, and common pitfalls."
---

# Agent Creation Guide — Project Builder

This skill is the authoritative reference for anyone creating a **new agent** (main or subagent) in the project-builder extension. It covers every frontmatter field, tool selection rules, subagent constraints, parallel execution configuration, approval gates, prompt writing best practices, and the most common pitfalls to avoid.

---

## 1. Three Conceptual Layers

Before creating an agent, understand where it fits:

| Layer | Says | Lives In | Example |
|-------|------|----------|---------|
| **Flows** | *When* (order, retries, approval flag) | Inline JSON in `flow_start` call | `{ agent: "implement", attempts: 2 }` |
| **Agents** | *How* (tools, subagents, prompt, approval) | `agents/*.md` with YAML frontmatter | `agents/implement.md` |
| **Engine** | *State machine* (persists + advances) | `src/engine/` (no Pi deps) | `transitions.ts`, `engine.ts` |

Flows say **when**. Agents say **how**. The engine says **what happens next**.

---

## 2. Agent File Anatomy

### 2.1 File Locations

```
agents/
├── {agent-id}.md              ← Main agent (e.g. "discover.md", "implement.md")
└── subagents/
    ├── {subagent-id}.md       ← Subagent (e.g. "scout.md", "worker.md")
    └── ...
```

### 2.2 File Format

Every agent file is a **Markdown file with YAML frontmatter**:

```markdown
---
{frontmatter-key}: {value}
---

You are the **{agent-id}** agent. Your job is to...

## Instructions

1. ...
```

- The `---` delimiters are required for frontmatter
- If no `---` is found, the entire file is treated as the prompt body
- The body text after frontmatter is the **LLM prompt** (engine wraps it with workspace prefix, approval instructions, and completion suffix)

---

## 3. Frontmatter Field Reference

### 3.1 Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | `string` | Unique identifier — must match the filename without `.md` | `"implement"` |
| `version` | `number` | Schema version — **increment when you change the manifest** | `2` |
| `tools` | `string[]` | JSON array of allowed Pi tool names | `'["read", "write", "bash"]'` |

### 3.2 Optional Fields

| Field | Type | Description | Applies To |
|-------|------|-------------|------------|
| `subagents` | `Record<string, string>` | JSON object mapping name → relative `.md` path | Main agents only |
| `parallel_over` | `string` | Variable name to iterate over (e.g. `"service_dirs"`) | Main agents only |
| `parallel_subagent` | `string` | Subagent name to fan out to | Main agents only |
| `parallel_concurrency` | `number` | Max concurrent workers | Main agents only |
| `outputs` | `string[]` | Expected output file paths (relative to `.temp/{featurePath}/`) | Any agent |
| `approval` | `ApprovalManifest` | JSON object defining the approval gate dialog | Main agents only |

---

## 4. Tool Selection Guide

### 4.1 Available Tools

```typescript
type AgentTool =
  // File & code tools
  | "read"               // Read files (nearly all agents need this)
  | "write"              // Write output files
  | "edit"               // Edit existing files (implementation agents)
  | "bash"               // Run shell commands, tests, linters

  // Subagent tools — MAIN AGENTS ONLY
  | "subagent"           // Launch subagents
  | "ask_user_question"  // Ask the user questions

  // Research tools
  | "web_search"         // Web search
  | "code_search"        // Code search / API documentation search
  | "fetch_content"      // Fetch URLs, YouTube transcripts, video content
  | "get_search_content" // Retrieve stored search content

  // Flow & integration tools
  | "mcp"                // MCP server tools
  | "flow_step_update"   // Report incremental progress + child run IDs
```

### 4.2 When to Include Each Tool

| Tool | Typical Use Case | Agents That Need It |
|------|-----------------|---------------------|
| `read` | Reading project files, artifacts from prior steps | Nearly all agents |
| `write` | Producing output artifacts (`spec.md`, `plan.md`, etc.) | Agents that produce deliverables |
| `edit` | Modifying source code | `implement` |
| `bash` | Running build, lint, tests, git operations | `implement`, `plan`, `research`, `review` |
| `subagent` | Delegating work to subagents | `discover`, `implement`, `review` |
| `ask_user_question` | Asking the user for input or approval | `gather-input`, `clarify` |
| `web_search` | External research | `research` |
| `code_search` | Finding API patterns, docs | `research`, `plan`, `discover` |
| `fetch_content` | Fetching docs, videos, URLs | `research` |
| `get_search_content` | Getting stored search results | `research` |
| `mcp` | Accessing MCP tools | Agents needing external tooling |
| `flow_step_update` | **Registering subagent run IDs for TUI visibility** | **Any agent that calls `subagent`** |

### 4.3 ⚠️ CRITICAL: The `flow_step_update` Requirement

Any agent that launches subagents **MUST**:

1. **Include `flow_step_update` in its `tools` list**
2. **Call `flow_step_update({ childRunIds: [...] })`** after launching subagents, passing the run IDs returned by the subagent tool

**Why:** The Step Summary Widget (`step-summary-widget.ts`) reads `step.activity.child_run_ids` to find and display subagent activity. If these IDs are never registered, the widget shows an **empty child activity tree** — even though the subagents ran successfully.

**Affected built-in agents:** `discover` (scout), `implement` (worker), `review` (reviewer)

---

## 5. Subagent Rules (Hard Constraints)

These are **enforced by `agent-loader.ts`** at load time:

| # | Rule | Error If Violated |
|---|------|-------------------|
| 1 | Subagents **CANNOT** use the `subagent` tool | `Subagent "{id}" cannot use tool "subagent"` |
| 2 | Subagents **CANNOT** use `ask_user_question` | `Subagent "{id}" cannot use tool "ask_user_question"` |
| 3 | Subagents **CANNOT** declare their own `subagents` | `Subagent "{id}" cannot declare subagents` |
| 4 | Subagents **CANNOT** have `parallel_*` configuration | Validated by manifest parser |
| 5 | Subagents **CANNOT** have an `approval` block | `Subagent "{id}" cannot have an approval block` |

**Additionally:** Subagents communicate results by **returning text to the parent agent**. They do not write workflow artifacts directly (the parent synthesizes their outputs).

---

## 6. Parallel Execution Configuration

Fan-out lets a main agent delegate work to multiple subagent instances in parallel:

```yaml
tools: ["subagent", "read", "write", "edit", "bash"]
subagents: {"worker": "subagents/worker.md"}
parallel_over: service_dirs
parallel_subagent: worker
parallel_concurrency: 4
```

| Field | Required | Description |
|-------|----------|-------------|
| `parallel_over` | Yes | Variable/array to iterate over (e.g. `service_dirs`) |
| `parallel_subagent` | Yes | Must match a key in the `subagents` object |
| `parallel_concurrency` | No | Max concurrent workers (default: engine config, typically 4) |

**Validation rules:**
- `parallel_over` and `parallel_subagent` must both be present, or both absent
- The `subagent` tool must be in the tools list
- The referenced subagent must exist in the `subagents` map
- Only main agents can declare parallel execution

---

## 7. Approval Gates

### 7.1 How Gates Work

1. The flow step declares `requestApproval: true`
2. The agent manifest defines the approval dialog structure
3. When the agent completes with `result: "success"`, the engine pauses the workflow
4. The LLM presents the gate options to the user via `ask_user_question`
5. The user chooses: **approve** (advance), **reject with feedback** (retry), or **exit** (abort)

### 7.2 Manifest Schema

```yaml
approval: {"header": "Step Name", "preview": "artifact.md", "options": [
  {"label": "Approve", "description": "Proceed to next step", "advance": true},
  {"label": "Revise", "description": "Re-run this step with changes", "advance": false, "feedback": true},
  {"label": "Exit", "description": "Stop the workflow", "advance": false, "abort": true}
]}
```

### 7.3 Rules

- Only main agents can have approval blocks (subagents cannot)
- The flow definition's step **must** set `requestApproval: true` (validated at `flow_start`)
- At least one option must have `advance: true`
- `feedback: true` shows a text input — the answer must provide non-empty feedback
- `abort: true` marks the workflow as abandoned
- Approval is **post-run**: the step completes with `success`, then the gate pauses
- The `preview` field points to an output artifact shown in the gate dialog

### 7.4 Reference Examples

**Simple approve/reject:**
```yaml
approval: {"header": "Feature Input", "preview": "feature-input.md", "options": [
  {"label": "Proceed", "description": "Input is complete enough to start discovery", "advance": true},
  {"label": "Refine", "description": "Ask more questions or gather more context", "advance": false, "feedback": true}
]}
```

**With abort option:**
```yaml
approval: {"header": "Spec", "preview": "spec.md", "options": [
  {"label": "Approve", "description": "Proceed with this specification", "advance": true},
  {"label": "Request changes", "description": "Revise before continuing", "advance": false, "feedback": true},
  {"label": "Exit", "description": "Stop the workflow", "advance": false, "abort": true}
]}
```

---

## 8. Prompt Writing Best Practices

### 8.1 Structure

```
You are the **{agent-id}** agent. Your job is to...

## Instructions

1. Read these input files...
2. Do this work...
3. Produce these outputs...

[Output template if applicable]
```

### 8.2 Guidelines

| Guideline | Why | Example |
|-----------|-----|---------|
| **Start with "You are..."** | Sets role and expectations | `You are the **plan** agent. Your job is to turn the approved spec into an executable plan.` |
| **Numbered instructions** | Clear ordering reduces ambiguity | `1. Read spec.md\n2. Identify files to change\n3. Write plan.md` |
| **Specify input files** | Agent reads from `.temp/{featurePath}/` | `Read spec.md, research.md, and discovery.md.` |
| **Define output format inline** | Agent produces consistent structured artifacts | Include markdown templates with headings |
| **Include acceptance criteria** | Agent knows when it's done | `Each task must have: file, changes, approach, acceptance` |
| **End with completion instruction** | Agent knows when to stop | The engine auto-appends this for main agents. For subagents: `Do not ask user questions. Do not launch other subagents.` |

### 8.3 Subagent Prompt Convention

Subagents always end with:

```
Do not ask user questions. Do not launch other subagents.
```

---

## 9. Output Artifact Declaration

### 9.1 Declaration

```yaml
outputs: ["plan.md", "service-dirs.json"]
```

- Paths are relative to `.temp/{featurePath}/`
- The engine checks they exist on `stepComplete` with `result: "success"`
- Missing outputs produce **non-blocking warnings** (workflow continues)

### 9.2 Artifact Flow in the Built-in Pipeline

| Step | Outputs | Read By |
|------|---------|---------|
| `gather-input` | `feature-input.md` | `discover`, `spec-write`, `complete` |
| `discover` | `discovery.md`, `scout-report.md`, `clarifications.md` | `spec-write`, `plan`, `complete` |
| `spec-write` | `spec.md`, `research.md` | `plan`, `implement`, `review`, `complete` |
| `plan` | `plan.md`, `service-dirs.json` | `implement`, `review`, `complete` |
| `implement` | `implementation-notes.md` | `review`, `complete` |
| `review` | `review-findings.md` | `complete` |
| `doc-sync` | `docs.md` | `complete` |
| `complete` | `summary.md` | — |

---

## 10. Common Pitfalls Checklist

### ❌ 1. Missing `flow_step_update` for subagent visibility

```yaml
# WRONG — TUI won't show subagent activity
tools: ["subagent", "read", "bash", "code_search", "write"]

# RIGHT
tools: ["subagent", "read", "bash", "code_search", "write", "flow_step_update"]
```

And the agent prompt **must instruct** calling `flow_step_update({ childRunIds: [...] })` after launching subagents.

### ❌ 2. Subagent calling `flow_step_complete`

Subagents **never** advance workflow state. Only the supervising LLM (main agent) can call `flow_step_complete`. The engine enforces this by checking `step.status === "running"`.

### ❌ 3. I/O in `transitions.ts`

State transition functions in `transitions.ts` must be **pure** — no `fs.readFileSync`, `fs.writeFileSync`, or any I/O. All I/O belongs in `engine.ts`.

### ❌ 4. Missing approval block on gated step

If `requestApproval: true` is set on a flow step but the agent has no `approval` frontmatter, `validateFlowApproval()` throws at `flow_start`. The gate is also checked at `stepComplete`.

### ❌ 5. Subagents with `ask_user_question` or `subagent` tool

Subagents cannot interact with the user or nest other subagents. These are validated and rejected by `agent-loader.ts`.

### ❌ 6. Not incrementing `version`

When you change the frontmatter of an agent manifest, **bump the `version` field**. This ensures the engine and caching layers use the latest schema.

### ❌ 7. Forgetting to declare all needed tools

The engine validates tools against a whitelist. If you reference a tool not in the list, loading the agent throws an error.

### ❌ 8. Putting approval JSON in the flow definition

Approval dialog structure belongs in the agent `.md` file's frontmatter, not in `flows/index.ts`. The flow only sets `requestApproval: true`.

### ❌ 9. Subagent trying to declare parallel config or subagents

Subagents cannot have `parallel_over`/`parallel_subagent`/`parallel_concurrency` or nested `subagents`. This is validated by the agent loader.

### ❌ 10. Agents lacking `outputs` when downstream steps depend on their artifacts

If another agent reads files produced by your agent (via `read` tool referencing `.temp/{featurePath}/...`), your agent **must** declare those outputs so the engine validates they exist.

---

## 11. Complete Agent Manifest Example

```markdown
---
id: my-custom-agent
version: 1
tools: ["subagent", "read", "write", "bash", "flow_step_update"]
subagents: {"helper": "subagents/helper.md"}
parallel_over: service_dirs
parallel_subagent: helper
parallel_concurrency: 3
outputs: ["my-output.md"]
approval: {"header": "Review Output", "preview": "my-output.md", "options": [
  {"label": "Proceed", "description": "Output looks good, continue", "advance": true},
  {"label": "Revise", "description": "Fix issues and re-run", "advance": false, "feedback": true},
  {"label": "Exit", "description": "Stop the workflow", "advance": false, "abort": true}
]}
---

You are the **my-custom-agent** agent. Your job is to produce a custom analysis using helper subagents.

## Instructions

1. Read `spec.md` and `plan.md` from the workspace.
2. Launch one `helper` subagent per service directory.
3. After launching subagents, call `flow_step_update({ childRunIds: [<run IDs from the subagent calls>] })`.
4. Collect helper results and synthesize them into `my-output.md`.
5. Run any relevant validation checks.

When complete, the supervisor will submit `step-result: success`.
```

---

## 12. Subagent Manifest Example

```markdown
---
id: helper
version: 1
tools: ["read", "bash"]
---

You are a **helper** subagent. Your job is to analyze one specific service directory.

## Instructions

1. Read the relevant files in the assigned directory.
2. Report findings in a structured format.
3. Return your results to the parent agent.

Do not ask user questions. Do not launch other subagents.
```

---

## 13. Adding a New Flow

To wire your new agent into a flow:

```typescript
// flows/index.ts

export const MY_FLOW: FlowDefinition = {
  id: "my-flow",
  version: 1,
  description: "Description of my custom flow",
  steps: [
    { agent: "my-custom-agent", requestApproval: true, attempts: 2 },
    { agent: "another-agent" },
  ],
};

// Then register in the allFlows array
export const allFlows: FlowDefinition[] = [
  FEATURE_BUILD_FLOW,
  MY_FLOW,
];
```

Flow step options:
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | `string` | required | Agent id matching an `agents/{id}.md` file |
| `requestApproval` | `boolean` | `false` | Pause for user approval after success |
| `attempts` | `number` | `1` | Max retry attempts on error |
| `model` | `string` | — | Optional model override for this step |

---

## 14. Testing and Validation

```bash
# Validate all agent manifests (checks frontmatter, tools, subagents, approval)
npm run validate

# Run unit tests
npm test

# Create a new agent from template
npm run scaffold:agent -- my-agent          # Main agent with read/write/bash
npm run scaffold:agent -- my-agent --approval # Main agent with approval gate
npm run scaffold:agent -- helper --subagent   # Subagent
```

The `validate` script runs `loadFlowAgents()` and `validateFlowApproval()` on the `feature-build` flow, catching all manifest errors at development time rather than at workflow start.

---

## 15. Quick Reference: Tool Whitelist

```
Valid for main agents:   subagent, ask_user_question, read, write, edit,
                         bash, web_search, code_search, fetch_content,
                         get_search_content, mcp, flow_step_update

Valid for subagents:     read, write, edit, bash, web_search, code_search,
                         fetch_content, get_search_content, mcp, flow_step_update

Blocked for subagents:   subagent, ask_user_question
```

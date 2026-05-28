# Agent Manifest Schema

Every agent in the project-builder system is defined by a markdown file with YAML frontmatter. This document is the **authoritative reference** for the frontmatter schema.

---

## 1. File Format

```
agents/
├── {agent-id}.md              ← Main agent
├── subagents/
│   ├── {subagent-id}.md       ← Subagent
│   └── ...
└── ...
```

Each `.md` file has:

```
---
{frontmatter-key}: {value}
---
## Agent Prompt
Body text...
```

The `---` delimiters are required for frontmatter. If no `---` is found, the entire file is treated as the prompt body with empty frontmatter.

---

## 2. Frontmatter Fields

### 2.1 Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | `string` | Unique identifier for the agent | `"implement"` |
| `version` | `number` | Schema version (increment when manifest changes) | `2` |
| `tools` | `string[]` | JSON array of allowed Pi tool names | `'["read", "write", "bash"]'` |

### 2.2 Optional Fields

| Field | Type | Description | Applies to |
|-------|------|-------------|------------|
| `subagents` | `Record<string, string>` | JSON object mapping name → relative .md path | Main agents only |
| `parallel_over` | `string` | Variable name to iterate over (e.g. `"service_dirs"`) | Main agents only |
| `parallel_subagent` | `string` | Subagent name to fan out to | Main agents only |
| `parallel_concurrency` | `number` | Max concurrent workers (default: engine config) | Main agents only |
| `outputs` | `string[]` | Expected output file paths (relative to feature path) | Any |
| `approval` | `ApprovalManifest` | JSON object defining the approval dialog | Main agents only |

---

## 3. Valid Tools

The whitelist of tool names that can appear in `tools`:

```typescript
type AgentTool =
  | "subagent"           // Launch subagents (main agents only)
  | "ask_user_question"  // Ask user questions (main agents only)
  | "read"               // Read files
  | "write"              // Write files
  | "edit"               // Edit files
  | "bash"               // Execute shell commands
  | "web_search"         // Web search
  | "code_search"        // Code search
  | "fetch_content"      // Fetch URLs / video content
  | "get_search_content" // Retrieve stored search content
  | "mcp"                // MCP tools
  | "flow_step_update";  // Report incremental progress (any agent)
```

### Subagent Tool Restrictions

Subagents **CANNOT** use:
- `"subagent"` — subagents cannot nest other subagents
- `"ask_user_question"` — subagents communicate only to the parent agent

---

## 4. Subagents Field

Maps subagent names to relative .md paths:

```yaml
subagents: {"worker": "subagents/worker.md", "scout": "subagents/scout.md"}
```

Paths are resolved against the `agents/` directory. The loader automatically appends `.md` if missing.

**Rules:**
- Only main agents can declare subagents
- Subagents cannot declare their own subagents
- Referenced subagent files must exist at load time (fail-fast)

---

## 5. Parallel Configuration

Parallel fan-out lets a main agent delegate work to multiple subagent instances:

```yaml
tools: ["subagent", "read", "write", "edit", "bash"]
subagents: {"worker": "subagents/worker.md"}
parallel_over: service_dirs
parallel_subagent: worker
parallel_concurrency: 4
```

| Field | Required | Description |
|-------|----------|-------------|
| `parallel_over` | Yes | The name of a variable/array the supervisor knows about. The supervisor reads this at runtime from workflow state or artifacts. |
| `parallel_subagent` | Yes | Must match a key in the `subagents` object |
| `parallel_concurrency` | No | Max concurrent workers (default: Pi subagent concurrency) |

**Validation:**
- `parallel_over` and `parallel_subagent` must both be present, or both absent
- The `subagent` tool must be in the tools list
- The referenced subagent must exist in the `subagents` map
- Only main agents can declare parallel execution

---

## 6. Outputs

Expected output files that the agent should produce:

```yaml
outputs: ["plan.md", "service-dirs.json"]
```

Paths are relative to `.temp/{featurePath}/`.

On `stepComplete` with `result: "success"`, the engine checks each expected output file. Missing files produce **non-blocking warnings** — the workflow continues.

---

## 7. Approval Manifest

Defines the approval gate dialog presented to the user after the supervisor reports success.

### Schema

```typescript
interface ApprovalManifest {
  /** Shown as the gate header (e.g. "Spec Review") */
  header: string;

  /** Optional: path to preview file (e.g. "plan.md") */
  preview?: string;

  /** Options the user can choose (min 1, must have at least one with advance: true) */
  options: ApprovalOption[];
}

interface ApprovalOption {
  /** Display label */
  label: string;

  /** Explanation shown to the user */
  description: string;

  /** If true → advance to next step. If false → retry or abort. */
  advance: boolean;

  /** If true and advance is false → abandon the entire workflow */
  abort?: boolean;

  /** If true → a text input is shown for user feedback */
  feedback?: boolean;
}
```

### Validation

- Must be valid JSON
- Must have a `header` string
- `options` must be a non-empty array
- At least one option must have `advance: true`
- `feedback` must be boolean (if present)
- Subagents cannot have an approval block

### Reference Examples

**Simple approve/reject:**
```yaml
approval: {"header": "Feature Input", "preview": "feature-input.md", "options": [{"label": "Proceed", "description": "Input is complete enough to start discovery", "advance": true}, {"label": "Refine", "description": "Ask more questions or gather more context", "advance": false, "feedback": true}]}
```

**With abort option:**
```yaml
approval: {"header": "Spec", "preview": "spec.md", "options": [{"label": "Approve", "description": "Proceed with this specification", "advance": true}, {"label": "Request changes", "description": "Revise before continuing", "advance": false, "feedback": true}, {"label": "Exit", "description": "Stop the workflow", "advance": false, "abort": true}]}
```

---

## 8. Complete Agent Manifest Example

```markdown
---
id: implement
version: 2
tools: ["subagent", "read", "write", "edit", "bash"]
subagents: {"worker": "subagents/worker.md"}
parallel_over: service_dirs
parallel_subagent: worker
parallel_concurrency: 4
outputs: ["implementation-notes.md"]
---

You are the **implement** agent. Your job is to coordinate implementation using worker subagents and verify the integrated result.

## Instructions

1. Read `spec.md`, `research.md`, `plan.md`, `service-dirs.json`, and `workflow.json`.
2. Use `workflow.json.service_dirs` as the authoritative fan-out list.
...
```

---

## 9. Subagent Manifest Example

```markdown
---
id: worker
version: 2
tools: ["read", "write", "edit", "bash"]
---

You are a **worker** subagent. You implement one bounded work unit assigned by the `implement` agent.

## Instructions

1. Read the provided spec, research, plan, and task context.
2. Implement only the assigned files or module.
...
```

**Note:** No `approval`, no `subagents`, no `ask_user_question`, no `subagent` tool.

---

## 10. Agent Prompt Assembly

When the engine loads an agent, it wraps the body with:

1. **Workspace prefix** (injected by `engine.ts`):
   ```
   ## Workspace
   Write all output files to .temp/{featurePath}/.
   Read inputs from the same directory.
   ```

2. **Approval instruction** (only if `flowStep.requestApproval === true`):
   ```
   ## Approval Gate
   After you submit `flow_step_complete` with `result: "success"`, this step will
   pause for user approval before the workflow advances.
   ...
   ```

3. **Completion suffix** (always appended):
   ```
   ## Completion
   When you have finished all the work described above, stop.
   Do not ask what to do next. Do not offer to continue.
   The workflow will advance automatically.
   ```

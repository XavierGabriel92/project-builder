---
id: complete
version: 24
tools: ["read", "write", "edit", "bash"]
outputs: ["feature-summary.md", "learnings.md", "maintenance.md"]
approval: {"header": "Completion", "preview": "summary.md", "options": [{"label": "Approve", "description": "Documentation is complete and correct. Mark workflow as done.", "advance": true}, {"label": "Request changes", "description": "Documentation needs revisions before completing", "advance": false, "feedback": true}, {"label": "Exit", "description": "Stop the workflow", "advance": false, "abort": true}]}
---

You are the **complete** agent. Write the feature's permanent reference docs into the project tree.

## Core Rule
> **All writes use bash with full absolute paths. Construct every path from the variables you read in Phase 1. Never write to the current directory.**
> **This step has 5 mandatory phases. You MUST complete ALL of them before calling `flow_step_complete`. The engine will block if declared outputs are missing.**

---

## Phase 1: Read variables

Read `workflow.json`. Store these values:
- `ROOT` = the `project_root` field (e.g. `/Users/.../apps`)
- `FP` = the `feature_path` field (e.g. `15-06-2026-refactor-wrong-code-behavior`)
- `FEATURE` = the `feature` field

Read `service-dirs.json`. Store:
- `SVC` = the service directory name (e.g. `application`)

Read `spec.md`, `implementation-notes.md`, `plan.md`, `review-findings.md`, `docs.md`.

---

## Phase 2: Create directory

Construct this path by substituting the variables you stored: `ROOT/SVC/references/features/FP`

```bash
mkdir -p $ROOT/$SVC/references/features/$FP
```

Note: use `$ROOT` not `{project_root}`. The `$` means "the value I stored."

---

## Phase 3: Write the three docs

Construct each path as: `ROOT/SVC/references/features/FP/FILENAME`

Feature summary:
```bash
cat > $ROOT/$SVC/references/features/$FP/feature-summary.md << 'EOF'
# Feature Summary
> **Breaking Changes:** yes or no

## Feature
one-line description

## Changes
- files created and why
- files modified and what changed
- new patterns or dependencies

## Verification
- TypeScript, lint, test results
EOF
```

Learnings:
```bash
cat > $ROOT/$SVC/references/features/$FP/learnings.md << 'EOF'
# Learnings

## topic
what was learned, why a decision was made, what trade-off was accepted
EOF
```

Maintenance:
```bash
cat > $ROOT/$SVC/references/features/$FP/maintenance.md << 'EOF'
# Maintenance

## Watch Points
- file or module: what could go wrong

## Known Follow-Ups
- what should be done next
EOF
```

---

## Phase 4: Update the index

Read `$ROOT/$SVC/references/features/README.md`. Add this row at the top of its table:
```
| [FEATURE](FP/feature-summary.md) | today's date | one-line description |
```

If README.md doesn't exist, create it:
```bash
cat > $ROOT/$SVC/references/features/README.md << 'EOF'
# Features

| Feature | Date | Description |
|---------|------|-------------|
| FEATURE | date | description |
EOF
```

---

## Phase 5: Verify

Run every command. All must succeed:
```bash
ls -la $ROOT/$SVC/references/features/$FP/feature-summary.md
ls -la $ROOT/$SVC/references/features/$FP/learnings.md
ls -la $ROOT/$SVC/references/features/$FP/maintenance.md
grep "$FP" $ROOT/$SVC/references/features/README.md
```

---

## Gate Check
- [ ] Three docs exist at $ROOT/$SVC/references/features/$FP/
- [ ] README index contains $FP
- [ ] All files have content (not empty)
- [ ] Nothing was written to the current directory

## Never
- ❌ Write to the current directory (that's .temp/)
- ❌ Use relative paths like `./feature-summary.md`
- ❌ Skip the `mkdir -p`
- ❌ Skip verification
- ❌ Skip any phase — all 5 phases are mandatory
- ❌ Call `flow_step_complete` before Phase 5 verification passes

---
id: complete-reference
version: 1
tools: ["read", "write", "bash"]
---

You are a **complete-reference** subagent. Your ONLY job: write 3 project tree reference files + update the README index for each service directory.

## 1. Read inputs

The parent agent will provide:
- `feature_path` (e.g. `14-06-2026-construction-site`)
- `feature` name (e.g. `construction site`)
- Service directories (e.g. `application`)
- Date (e.g. `2026-06-14`)

## 2. For EACH service directory, write all 3 files

### 2a. Create directory
```bash
mkdir -p ../{service_dir}/references/features/{feature_path}
```

### 2b. Write feature-summary.md
Write to `../{service_dir}/references/features/{feature_path}/feature-summary.md`:

```markdown
# Feature Summary

> **Breaking Changes:** {Yes/No}
> **API Changes:** {Description}

## Feature
{One-line description}

## Changes
- {key change}
- {key change}

## Verification
{How it was verified}
```

### 2c. Write learnings.md
Write to `../{service_dir}/references/features/{feature_path}/learnings.md`:

```markdown
# Learnings

## {Topic}
{Lesson learned}
```

### 2d. Write maintenance.md
Write to `../{service_dir}/references/features/{feature_path}/maintenance.md`:

```markdown
# Maintenance

## Watch Points
- {fragile area}

## Known Follow-Ups
- {deferred work}
```

### 2e. Update README index
Read `../{service_dir}/references/features/README.md`.

Insert a new row at the TOP of the table:
```markdown
| [{slug}]({feature_path}/feature-summary.md) | {date} | {description} |
```

If README doesn't exist, create it with the table header + your row.

## 3. Verify yourself

Run ALL of these and check output:
```bash
ls -la ../{service_dir}/references/features/{feature_path}/feature-summary.md
ls -la ../{service_dir}/references/features/{feature_path}/learnings.md
ls -la ../{service_dir}/references/features/{feature_path}/maintenance.md
grep "{feature_path}" ../{service_dir}/references/features/README.md
```

If any file is missing or size 0, fix it before returning.

## 4. Return report

```markdown
## Status: success

## Files Written
| File | Size |
|------|------|
| ../application/references/features/{path}/feature-summary.md | {N} bytes |
| ../application/references/features/{path}/learnings.md | {N} bytes |
| ../application/references/features/{path}/maintenance.md | {N} bytes |
| ../application/references/features/README.md | Updated |
```

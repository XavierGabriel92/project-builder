# Project-Builder Agents vs TLC Spec-Driven: Comparative Analysis

**Date:** 2026-05-28
**Analyzed:** `/Users/gabrielxavier/.pi/agent/extensions/project-builder/agents/` vs `/Users/gabrielxavier/Documents/tcl-spec/tlc-spec-driven/`
**Goal:** Identify gaps and improvement opportunities in project-builder's prompts, behavior, and subagent orchestration.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture](#2-current-architecture)
3. [Comparative Analysis by Dimension](#3-comparative-analysis-by-dimension)
4. [Specific Prompt-Level Recommendations](#4-specific-prompt-level-recommendations)
5. [Subagent Improvement Opportunities](#5-subagent-improvement-opportunities)
6. [Priority Implementation Roadmap](#6-priority-implementation-roadmap)

---

## 1. Executive Summary

The **project-builder agents** implement a solid linear workflow (Gather → Discover → Spec → Plan → Implement → Review → Doc-Sync → Complete) with three specialized subagents (scout, worker, reviewer). However, compared to **TLC Spec-Driven**, there are significant gaps in:

| Gap Area | Impact |
|----------|--------|
| **No auto-sizing** — every feature hits every stage | Small changes get heavy ceremony |
| **No quick mode** — no express path for ≤3 file changes | User friction for trivial tasks |
| **No task granularity validation** — tasks can be too coarse | Wasted context, parallelization failures |
| **No pre-approval validation gates** for tasks | Inconsistent task quality |
| **No RED-GREEN test pattern** | Weaker test discipline |
| **No requirement traceability** (requirement IDs, spec→task→commit links) | Lost history, hard to validate completeness |
| **No context management strategy** | Risk of context overload |
| **No Knowledge Verification Chain** | Risk of hallucinated APIs/patterns |
| **No persistent state** (decisions, blockers, deferred ideas) | No session continuity |
| **No scope guardrails** | Risk of scope creep during implementation |
| **No commit convention enforcement** | Inconsistent git history |
| **No SPEC_DEVIATION markers** | Silent deviations from spec |
| **No coding principles reference** | Inconsistent agent behavior |
| **Subagent context strategy undocumented** | Worker/scout may get too much/little context |
| **No diagram-definition cross-checks** | Incorrect dependency graphs |

---

## 2. Current Architecture

### Pipeline Flow

```
gather-input → discover → spec-write → plan → implement → review → doc-sync → complete
   (approval)               (approval)                                 (approval)
```

### Subagents

```
discover → scout (focused reconnaissance)
implement → worker (bounded implementation)
review → reviewer (focused code review)
```

### Output Artifacts

| Agent | Outputs |
|-------|---------|
| gather-input | `feature-input.md` |
| discover | `discovery.md`, `scout-report.md`, `clarifications.md` |
| spec-write | `research.md`, `spec.md` |
| plan | `plan.md`, `service-dirs.json` |
| implement | `implementation-notes.md` |
| review | `review-findings.md` |
| doc-sync | `docs.md` |
| complete | `summary.md` + per-service reference docs |

---

## 3. Comparative Analysis by Dimension

### 3.1 Auto-Sizing & Quick Mode

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Complexity-based pipeline | ❌ No — every feature runs every stage | ✅ Yes — Small/Medium/Large/Complex auto-sizing | **Critical** |
| Quick/express mode | ❌ No | ✅ Quick mode for ≤3 files, one-sentence scope | **Critical** |
| Phase skipping | ❌ No | ✅ Design/Tasks skipped when unnecessary | **High** |

**Recommendation:** Add a `complexity` field to the workflow context. Before gather-input, assess whether the task qualifies as "quick" (≤3 files, well-understood) and if so, route to a simplified skip-pipeline flow.

---

### 3.2 Task Decomposition & Validation

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Atomic task definition | ✅ Yes (implement agent decomposes plan) | ✅ Yes — much more detailed templates | **Medium** |
| Task granularity check | ❌ No | ✅ Three pre-approval validation checks | **High** |
| [P] parallel markers | ✅ Used (dependency levels) | ✅ Used — plus parallelism assessment from test matrix | **Medium** |
| Diagram-definition cross-check | ❌ No | ✅ Validates execution diagram matches task deps | **High** |
| Test co-location validation | ❌ No | ✅ Every task's Tests field validated against coverage matrix | **High** |
| Pre-approval task validation | ❌ No | ✅ 3 mandatory gates before presenting to user | **High** |
| Dependency level grouping | ✅ Yes (Level 0, 1, 2) | ✅ Yes — with formal execution phases | **None** |

**Concrete Prompt Improvement (implement.md):**

The `implement` agent needs explicit validation instructions before dispatching workers:

```markdown
### Pre-Dispatch Validation (MANDATORY)

Before dispatching workers, validate each task:

1. **Granularity Check** — Is each task ONE deliverable (one component, one function, one endpoint)?
   - ✅ 1 file = Good
   - ❌ Multiple components = Split it

2. **Test Co-location Check** — Does every task that creates/modifies code include appropriate tests?

3. **Dependency Consistency Check** — Do the dependency levels match actual task deps?

4. **Parallel Safety Check** — Can [P] tasks truly run in parallel? Shared mutable state?
```

---

### 3.3 Test-First Discipline

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Test-first (RED) pattern | ❌ No — "Run checks when practical" (optional language) | ✅ Mandatory RED → GREEN → Gate cycle | **Critical** |
| Gate check standardization | ❌ No | ✅ Tiered gates (Quick/Full/Build) from TESTING.md | **High** |
| Test integrity enforcement | ❌ No | ✅ No silent deletions, no weakened assertions, no skips | **High** |
| Pre-commit verification | ❌ Weak | ✅ 6-step post-gate review | **High** |

**Concrete Prompt Improvement (worker.md):**

The worker.md currently says: *"Run the checks requested by the parent when practical."* This MUST be changed to a mandatory instruction:

```markdown
### 1. Implement
Write the minimum implementation to satisfy the task's success criteria.

### 2. Gate Check (MANDATORY — not "when practical")
- Run the specified verification checks
- Non-zero exit code = STOP. Fix and re-run.
- Do not proceed until green.

### 3. Post-Gate Review
- [ ] No scope creep — only touched listed files
- [ ] No weakened test assertions
- [ ] Would a senior engineer approve this?
```

---

### 3.4 Requirement Traceability

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Requirement IDs | ❌ No | ✅ IDs like AUTH-01, CART-03 | **High** |
| Spec→Task→Commit links | ❌ No | ✅ Each task references requirement ID | **High** |
| Requirement status tracking | ❌ No | ✅ Pending → Designing → Tasks → Implementing → Verified | **High** |

**Recommendation:** Add a `Requirement` field to each task in `plan.md` and have `implement.md` reference it. Add a status tracking table at the end of `spec.md`.

---

### 3.5 Knowledge Verification & Research

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Knowledge Verification Chain | ❌ No | ✅ Codebase → Docs → Context7 → Web → Flag uncertain | **Critical** |
| Anti-hallucination guardrails | ❌ No | ✅ "Never assume or fabricate — say 'I don't know'" | **Critical** |
| Research before design | ✅ part of spec-write | ✅ Dedicated research phase with chain | **Medium** |

**Concrete Prompt Improvement (spec-write.md):**

Add to spec-write's instructions:

```markdown
### Knowledge Verification Chain (STRICT ORDER)

When researching any technical decision, follow this chain. Never skip steps.

1. **Codebase** — Check existing code, conventions, and patterns already in use
2. **Project docs** — README, docs/, inline comments
3. **Code search tools** — grep/rg/sg for specific patterns
4. **Web search** — Official docs, reputable sources
5. **Flag as uncertain** — "I'm not certain about X — here's my reasoning, but verify"

**NEVER assume or fabricate.** If you cannot find an answer, say "I don't know" or
"I couldn't find documentation for this". Inventing APIs, patterns, or behaviors
causes cascading failures across design → tasks → implementation.
```

---

### 3.6 Context Management

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Base loading strategy | ❌ No | ✅ ~15k tokens (PROJECT.md + ROADMAP.md + STATE.md) | **High** |
| On-demand loading | ❌ No | ✅ Only load current feature's spec/design/tasks | **High** |
| File size limits | ❌ No | ✅ Per-document token limits with warning zones | **Medium** |
| Context monitoring | ❌ No | ✅ Zones (🟢<40k, 🟡40-60k, 🔴>60k) with footers | **Medium** |

**Recommendation:** Add `context-limits.md` reference and include context monitoring instructions in the main workflow. Each agent should note its expected reading and output token budgets.

---

### 3.7 State Management & Session Continuity

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Persistent decisions log | ❌ No | ✅ STATE.md with AD-NNN entries | **High** |
| Blockers tracking | ❌ No | ✅ B-NNN with impact, workaround, resolution | **High** |
| Lessons learned | ❌ No | ✅ L-NNN entries | **Medium** |
| Deferred ideas | ❌ No | ✅ Captured to prevent scope creep, preserved for later | **Medium** |
| Session handoff | ❌ No | ✅ HANDOFF.md for pause/resume | **High** |
| Quick task tracking | ❌ No | ✅ Quick tasks table in STATE.md | **Medium** |

**Recommendation:** Add a `memory.md` or equivalent state document to the workflow artifacts. The `complete` agent should also initialize a decision log.

---

### 3.8 Scope Guardrails

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| "Touch ONLY listed files" | ❌ Not explicitly stated | ✅ Surgical changes principle | **High** |
| No scope creep during implement | ❌ Not documented | ✅ "If it's not in the task, don't touch it" | **High** |
| Deferred ideas capture | ❌ No | ✅ Captures ideas without acting on them | **Medium** |
| "While I'm here" prevention | ❌ No | ✅ Explicitly forbidden | **High** |

**Concrete Prompt Improvement (worker.md):**

Add a scope guardrail section:

```markdown
### Scope Guardrail

During implementation, you will notice things that could be improved, refactored,
or added. **Do not act on them.** Instead:

- If it's a bug in the task's area: flag it as a blocker
- If it's an improvement: note it in your report under "Follow-Up Work"
- If it's unrelated: ignore it entirely

**The rule:** "Is this in my task definition?" If no, don't touch it.

Do NOT:
- "Improve" adjacent code, comments, or formatting
- Refactor things that aren't broken
- Add "flexibility" or "configurability" not requested
- Remove imports/variables YOU didn't orphan
```

---

### 3.9 Commit Convention

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Commit message convention | ❌ Not specified | ✅ Conventional Commits 1.0.0 | **Medium** |
| One task = one commit | ❌ Not specified | ✅ Mandatory — never batch tasks | **Medium** |
| Commit message templates | ❌ No | ✅ Full type table + scope + description rules | **Medium** |

**Recommendation:** Add to `worker.md`:

```markdown
### Commit Convention

Each task gets its own atomic commit immediately after verification:

<type>(<scope>): <description>

Types: feat, fix, refactor, docs, test, style, perf, build, ci, chore
Scope: feature name or module area, lowercase
Description: Imperative mood, lowercase, no period

Examples:
- feat(auth): add email validation to login form
- fix(cart): prevent negative quantity on item decrement
```

---

### 3.10 Review & Validation Depth

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Acceptance criteria verification | ❌ Not explicitly | ✅ Each WHEN/THEN confirmed PASS/FAIL | **High** |
| Interactive UAT | ❌ No | ✅ User-facing features get walkthrough testing | **Medium** |
| Severity inference | ❌ No | ✅ Infers severity from user language (blocker/major/minor/cosmetic) | **Medium** |
| Fix plan generation | ❌ No | ✅ Creates task definitions for each issue found | **Medium** |
| Maximum diagnostic iterations | ❌ No | ✅ Max 3 per issue, then flag for human | **Medium** |
| Edge case verification | ❌ No | ✅ Documented edge case checklist from spec | **High** |
| Requirement traceability update | ❌ No | ✅ Updates spec.md status after validation | **Medium** |
| Code quality checklist | ❌ No | ✅ 7-point checklist from coding principles | **High** |

**Concrete Prompt Improvement (review.md + reviewer.md):**

Add to the review agent:

```markdown
### Validation Checklist

1. **Task Completion** — All tasks marked done? Any blocked/partial?
2. **Acceptance Criteria** — For each user story in spec.md, verify every WHEN/THEN:
   - PASS/FAIL per criterion
   - Record any failures with details
3. **Edge Cases** — Check all documented edge cases from spec.md
4. **Build-Level Gate Check** — Run the full build/lint/test suite. Non-zero exit = STOP.
5. **Test Integrity** — Compare test count before/after feature. Any decrease must be justified.
6. **Code Quality** — Verify against principles:
   - No features beyond what was asked
   - Only touched files required for task
   - Matches existing patterns
   - Would senior engineer approve?
7. **SPEC_DEVIATION** — Check for deviation markers in changed files
8. **Scope** — Ensure no "while I'm here" changes snuck in
```

---

### 3.11 Subagent Context Strategy

| Aspect | Project-Builder | TLC Spec-Driven | Gap |
|--------|----------------|-----------------|-----|
| Subagent receives only its task definition | ❌ Not specified | ✅ Yes — no other tasks, no chat history | **High** |
| Subagent receives coding principles | ❌ Not specified | ✅ Always includes coding-principles.md | **Medium** |
| Subagent receives TESTING.md | ❌ Not specified | ✅ Yes for gate check commands | **Medium** |
| Subagent receives spec/design context | ✅ Implicit (parent sends context) | ✅ Explicitly documented | **Low** |
| Documentation of what subagents return | ✅ Structured output | ✅ More detailed (status + files + gates + deviations + issues) | **Medium** |

**Concrete Prompt Improvement (implement.md):**

Add to the context construction for workers:

```markdown
### Subagent Context Packing

When dispatching a worker, provide ONLY:
1. The specific task definition from plan.md (What, Where, Depends on, Acceptance)
2. Relevant spec/design context the task references
3. Key interfaces and contracts this task must conform to
4. Integration points with other workers' code (shared types, interfaces)

Do NOT include:
- Other tasks' definitions
- Accumulated chat history
- Full spec.md (only relevant sections)
- Previous workers' results (unless needed for integration)
```

---

## 4. Specific Prompt-Level Recommendations

### 4.1 `gather-input.md` Improvements

**Current gap:** No complexity assessment, no quick mode detection.

```diff
+ ## Pre-Flight: Complexity Assessment
+
+ Before diving into full requirements, determine the scope:
+ - **Quick** (≤3 files, one-sentence change, no design decisions) → Skip pipeline, use quick mode
+ - **Small/Medium** → One or two stages
+ - **Large/Complex** → Full pipeline
+
+ Check: "Can this be described in one sentence AND touches ≤3 files?"
+ If yes, flag as quick mode and skip the full pipeline.
```

### 4.2 `discover.md` Improvements

**Current gap:** No Knowledge Verification Chain, no structured research approach.

```diff
+ ### Knowledge Collection Protocol
+
+ When investigating code areas, follow this chain in order:
+ 1. Local codebase (grep/rg/sg)
+ 2. Project documentation (README, docs/, inline comments)
+ 3. Code search tools for patterns across the codebase
+ 4. Web search if external library/API behavior is relevant
+ 5. Flag explicitly: "I'm not certain about X — verify this"
+
+ Never fabricate. Never guess. Flag unknowns explicitly.
```

### 4.3 `spec-write.md` Improvements

**Current gap:** No requirement traceability, no WHEN/THEN format enforcement, no gray area detection.

```diff
+ ### Requirements Format
+
+ Each requirement MUST use WHEN/THEN/SHALL format:
+ - WHEN [event] THEN system SHALL [response]
+
+ ### Requirement Traceability
+
+ Assign each requirement a unique ID: [CATEGORY]-[NN]
+ Examples: AUTH-01, CART-03, NOTIF-02
+
+ ### Gray Area Detection
+
+ If the spec contains ambiguous user-facing decisions (layout, interaction patterns,
+ error handling style), pause and ask the user structured questions before finalizing.
+ Do NOT proceed with assumptions about user-facing behavior.
```

### 4.4 `plan.md` Improvements

**Current gap:** No task granularity validation, no dependency diagram, no test co-location.

```diff
+ ### Pre-Approval Validation (MANDATORY)
+
+ Before presenting the plan, run ALL three checks:
+
+ **Check 1: Task Granularity**
+ Each task must be ONE deliverable (one component, one function, one endpoint).
+ ❌ "Create form" → ✅ T1: Create email input, T2: Add validation, T3: Create submit button
+
+ **Check 2: Dependency Cross-Check**
+ Verify execution diagram matches each task's "Depends on" field.
+
+ **Check 3: Test Co-location**
+ Every task that creates/modifies code must include appropriate tests.
+ "Tested in another task" is NOT valid justification for Tests: none.
+
+ Any ❌ → Restructure before presenting.
```

### 4.5 `implement.md` Improvements

**Current gap:** No RED-GREEN pattern, no gate check standardization, no commit convention, no SPEC_DEVIATION.

```diff
+ ### Worker Context Construction
+
+ Each worker receives:
+ - Its task definition (What, Where, Depends on, Acceptance)
+ - Relevant spec/design excerpts (not entire documents)
+ - Interface contracts with other workers' tasks
+ - Gate check command to run
+
+ ### Post-Worker Integration
+
+ After each dependency level completes:
+ 1. Verify workers didn't modify shared interfaces inconsistently
+ 2. Run build/lint to catch cross-worker issues
+ 3. Resolve integration conflicts between workers' outputs
+
+ ### Commit Convention
+
+ After each task (not batch), commit with:
+ <type>(<scope>): <description>
```

### 4.6 `review.md` Improvements

**Current gap:** No acceptance criteria verification, no test integrity check, no edge case checking.

```diff
+ ### Validation Scope
+
+ For each changed file, verify:
+ 1. ✅ Implementation matches spec acceptance criteria
+ 2. ✅ Edge cases from spec.md are handled
+ 3. ✅ No test assertions weakened or removed
+ 4. ✅ No scope creep (only listed files changed)
+ 5. ✅ SPEC_DEVIATION marked where spec couldn't be followed
+ 6. ✅ Code is maintainable and matches local patterns
```

---

## 5. Subagent Improvement Opportunities

### 5.1 `scout.md` (currently 14 lines of instructions)

**Improvements suggested:**
- Add research priority protocol (prefer grep/rg/sg over broad reads)
- Add explicit anti-hypothesis instruction ("do not extrapolate from partial evidence")
- Add "confidence level" reporting requirement per finding

### 5.2 `worker.md` (currently 25 lines of instructions)

**Improvements suggested:**
- Add mandatory gate check section (currently says "when practical")
- Add scope guardrails
- Add commit convention
- Add post-implementation complexity check
- Add SPEC_DEVIATION marker requirement
- Add status reporting template with explicit fields (see TLC implement.md)

### 5.3 `reviewer.md` (currently 13 lines of instructions)

**Improvements suggested:**
- Add specific checks: correctness, regressions, security, performance, missing tests
- Add edge case verification requirement
- Add test integrity check
- Add SPEC_DEVIATION audit

---

## 6. Priority Implementation Roadmap

### Phase 1 — Quick Wins (Minimal effort, high impact)

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 1 | Add **scope guardrails** to worker.md | `subagents/worker.md` | 10 min |
| 2 | Change "when practical" to **mandatory gate check** in worker.md | `subagents/worker.md` | 5 min |
| 3 | Add **Knowledge Verification Chain** to spec-write.md | `spec-write.md` | 10 min |
| 4 | Add **coding principles reference** to all subagent prompts | All subagent `.md` files | 15 min |
| 5 | Add **test-first (RED) pattern** to worker.md | `subagents/worker.md` | 10 min |

### Phase 2 — Structural (Medium effort, high impact)

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 6 | Add **task granularity validation** to implement.md | `implement.md` | 20 min |
| 7 | Add **pre-approval task validation** to plan.md | `plan.md` | 20 min |
| 8 | Add **requirement traceability** (IDs, status tracking) to spec-write.md + plan.md | `spec-write.md`, `plan.md` | 25 min |
| 9 | Add **state management** (STATE.md equivalent) as new agent or complete.md extension | New file or modify `complete.md` | 30 min |
| 10 | Add **commit convention** to worker.md | `subagents/worker.md` | 10 min |

### Phase 3 — Advanced (Larger effort)

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 11 | Add **auto-sizing** (quick mode detection) to gather-input.md | `gather-input.md` | 30 min |
| 12 | Implement **session handoff** (pause/resume artifacts) | New `handoff` agent + memory | 45 min |
| 13 | Add **context management strategy** with token budgets | Reference document + agent instructions | 30 min |
| 14 | Add **interactive UAT** with severity inference to review.md | `review.md` | 30 min |
| 15 | Add **SPEC_DEVIATION markers** and post-gate review | `implement.md`, `worker.md` | 15 min |

### Phase 4 — Polish

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 16 | Add **diagram-definition cross-check** to plan.md | `plan.md` | 20 min |
| 17 | Add **test co-location validation** to plan.md | `plan.md` | 15 min |
| 18 | Add **pre-commit verification checklist** to worker.md | `subagents/worker.md` | 10 min |
| 19 | Standardize all agent output templates with **size limits** and **quality criteria** | All agent `.md` files | 30 min |

---

## Appendix: Key Differences in Design Philosophy

| Philosophy | Project-Builder | TLC Spec-Driven |
|------------|----------------|-----------------|
| **Pipeline** | Fixed linear pipeline | Adaptive auto-sized pipeline |
| **Task granularity** | Plan-level decomposition | 3 validation gates before approval |
| **Testing** | "Run checks when practical" | Mandatory RED → GREEN → Gate cycle |
| **Context** | No management strategy | Base + on-demand loading, <40k target |
| **State** | Stateless (nothing persists between runs) | STATE.md + HANDOFF.md (decisions, blockers, lessons) |
| **Verification** | Subagent reports back | Post-gate review + complexity check + SPEC_DEVIATION |
| **Research integrity** | No guardrails | Strict Knowledge Verification Chain |
| **Commit discipline** | Not specified | Conventional Commits 1.0.0, one task = one commit |
| **Scope control** | Not explicitly documented | Surgical changes + Deferred Ideas + guardrails |
| **User interaction** | Approval gates at spec+review | Gray area discussion + interactive UAT + structured Q&A |

---

## Appendix: File-by-File Improvement Backlog

### Agent files needing updates:
1. `gather-input.md` — Add complexity assessment + quick mode detection
2. `discover.md` — Add Knowledge Verification Chain reference
3. `spec-write.md` — Add requirement IDs, WHEN/THEN format, gray area detection
4. `plan.md` — Add pre-approval validation (granularity, deps, test co-location)
5. `implement.md` — Add worker context strategy, post-level integration, task validation
6. `review.md` — Add acceptance criteria verification, edge case checks, test integrity
7. `doc-sync.md` — No major changes needed
8. `complete.md` — Add STATE.md initialization

### Subagent files needing updates:
1. `subagents/scout.md` — Add research protocol, confidence levels, anti-hypothesis instruction
2. `subagents/worker.md` — Add mandatory gate check, scope guardrails, commit convention, RED pattern
3. `subagents/reviewer.md` — Add expanded checklist, SPEC_DEVIATION audit, test integrity

### New reference files to create:
1. `references/coding-principles.md` — Import from TLC or write custom version
2. `references/context-limits.md` — Token budgets for each artifact
3. `references/state-management.md` — STATE.md template + update triggers
4. `references/session-handoff.md` — HANDOFF.md template

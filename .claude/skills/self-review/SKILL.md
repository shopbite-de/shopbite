---
name: self-review
description: Review a finished branch with a fresh reviewer that sees only the task and the diff, never the implementer's report. Use when a delegated agent reports done, before reporting to the user, or when the user asks for a self-review of a branch.
---

# Self-review in a fresh context

The implementer knows what it meant and reads that into the diff; so does the session that briefed it. The reviewer starts with no history: it gets the **task** and the **diff**, and checks every claim itself.

## Steps

1. **Collect** the inputs, nothing else:
   - Task: the goal and acceptance criteria as briefed, copied verbatim from the brief (not from the report).
   - Location: absolute worktree path, branch, base (usually `origin/main`).
   
   Withhold the implementer's report, its test results and your own opinion of the change: a reviewer handed a conclusion tends to confirm it.
2. **Spawn** a fresh `general-purpose` agent (never `fork`, which inherits this conversation) with the brief below, filled in. Done when it returns a verdict.
3. **Act** on the verdict:
   - `changes needed`: send the findings to the implementer (its agent, or a new one in the same worktree) to fix, then run a new self-review with a new reviewer. Two rounds at most; after that, bring the remaining findings to the user.
   - `ready`: report to the user with the reviewer's checks alongside the implementer's report.
   
   A finding you think is wrong goes to the user with your reason; do not drop it silently.

## Reviewer brief

```
You review a branch you did not write. Assume nothing in it is verified.

Task (what the branch must achieve):
<goal and acceptance criteria, verbatim>

Code: worktree <absolute path>, branch <branch>, base <base>. Work read-only: no commits, no pushes, no edits; build and test output goes to /tmp.

1. Read <worktree>/CLAUDE.md and every CLAUDE.md in its parent directories; they define the repo rules and which names must never appear in this repo.
2. Read `git log <base>..HEAD` and `git diff <base>...HEAD` in full.
3. Run the repo's own checks as its CLAUDE.md names them (lint, typecheck, tests, build). Record each command and its result.
4. Check, and give evidence (file:line, command output) for each finding:
   - Spec: every acceptance criterion met, with proof you produced, not a claim from a commit message. Anything the task did not ask for.
   - Correctness: bugs, edge cases, behaviour changes for users or operators; use the code-review skill on the diff if it is available.
   - Repo rules: each rule in the CLAUDE.md files that the diff touches (e.g. a registry or list a new piece must be added to, docs that must change with the code).
   - Public hygiene: code, comments, docs and commit messages in English; no names, paths or links the parent CLAUDE.md marks as private; no secrets or real customer data.
   - Follow-ups: documented behaviour that changed and needs a docs task elsewhere.
5. Report: verdict `ready` or `changes needed`; findings ranked most severe first, each with severity (blocker, should-fix, nit), evidence and a suggested fix; the checks you ran with results; what you could not verify and why.
```

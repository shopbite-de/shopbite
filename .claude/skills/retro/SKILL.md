---
name: retro
description: Retrospective after a batch of ShopBite work is merged: a fresh agent turns what went wrong into proposed edits of CLAUDE.md files, skills, lessons and memory. Use when a batch (feature, step, release, incident) is done, or when the user asks for a retro.
---

# Retro after a batch

A batch leaves lessons in the chat, where the next session never reads them. The retro moves the few that change future behaviour to the one place that next session will read, and prunes what has gone stale there. It runs once per batch, after the merge, never per review round.

## Steps

1. **Collect** the evidence, nothing else:
   - The session transcript path (`~/.claude/projects/<project>/<session>.jsonl`) and the time span of the batch.
   - PRs and commits of the batch, review verdicts and their findings, incidents and failed runs (CI, smoke, monitors).

   Withhold your own list of lessons: an agent handed conclusions confirms them.
2. **Spawn** a fresh `general-purpose` agent with the brief below, filled in. Done when it returns proposals.
3. **Present** the proposals to the user as diffs, grouped by target file. Apply only the approved ones; memory notes from the proposals may be written without asking. Commit doc and skill changes in their repos (local commit, pushed with the batch, private repos stay private: a lesson about a private repo goes into that repo or the workspace `CLAUDE.md`, never into a public one).

## Retro brief

```
You run a retrospective on a finished batch of work. You change nothing: you return proposals.

Evidence: <transcript path, time span>, <PRs/commits>, <review findings>, <incidents/failed runs>.
Workspace rules: ~/workspace/shopbite/CLAUDE.md and the CLAUDE.md of each repo touched.

1. Find every friction in the batch: a review finding, a failed check, a fix round, a wrong claim corrected later, a user correction, an incident, a step that had to be redone. Each needs evidence (quote, commit, finding, error line). Search the transcript with grep/jq rather than reading it whole.
2. For each friction ask: would a rule, written where the next agent reads it, have prevented it? Drop the ones where no rule would have (one-off, already covered and simply missed once, pure bad luck). Drop general advice the model follows anyway.
3. For each remaining lesson pick exactly one home, the place read at the moment it matters:
   - repo rule or contract → that repo's CLAUDE.md (or its ADR when it is a design rule)
   - how work is delegated, reviewed or retro'd → the skill in ~/workspace/shopbite/shopbite/.claude/skills/
   - operations → ~/workspace/shopbite/infra/docs/lessons.md
   - the user's preferences and working agreements → memory (~/.claude/projects/<project>/memory/)
   Prefer sharpening an existing line over adding one. Check the home does not already say it.
4. Prune: in every file you propose to touch, find lines that are stale (code or process changed), duplicated elsewhere, or no-ops, and propose removing them.
5. Return per proposal: target file, unified diff, the friction it prevents with its evidence, and for removals why the line is dead. Order by impact. Zero proposals is a valid result.
```

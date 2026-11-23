---
name: delegate
description: Delegate ShopBite work to Claude agents running in the target repositories (Herdr or background agents). Use when a task changes code outside this quickstart repo (storefront, Shopware plugin, Shopware project, order printer, backoffice) or spans several repos.
---

# Delegate to repo agents

This repo is the hub. Work in another repository runs in its own Claude agent, started in that repo (or a worktree of it), so the agent loads that repo's `CLAUDE.md` and commits there. You plan, brief, wait and verify; you do not edit other repos' files yourself.

## Setup

- Herdr when `test "${HERDR_ENV:-}" = 1` (run `herdr --skill` once for syntax and lifecycle states). Otherwise start a background `general-purpose` Agent per brief: create the worktree with `git -C "$WS/<repo>" worktree add -b <branch> "$WS/.worktrees/<repo>/<branch>" origin/main` (absolute paths), and have the brief name the worktree and tell the agent to read its `CLAUDE.md` first, because the agent's cwd stays in the hub.
- Workspace root: the directory that holds the main checkouts side by side. From any checkout or worktree: `WS=$(dirname "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")`. Repos are `$WS/<repo>`; the README table lists the public ones, a `CLAUDE.md` in `$WS` may list more.

## Steps

1. **Split** the task into one brief per repo. Order them by dependency: the provider first (plugin or Shopware API), then its consumers (storefront, backoffice, order printer). Done when every change the task needs belongs to exactly one brief.
2. **Worktree** per brief, branch named after the task: `herdr worktree create --cwd "$WS/<repo>" --branch <branch> --path "$WS/.worktrees/<repo>/<branch>" --no-focus`. Keep worktrees under `$WS/.worktrees/` so workspace-level instructions and git hooks apply. Take the pane id from the JSON response.
3. **Start** a Claude agent in that pane: `herdr agent start <repo>-<topic> --kind claude --pane <pane-id>`.
4. **Brief** it with `herdr agent prompt <name> "<brief>" --wait`. The brief is self-contained: goal, acceptance criterion, constraints, what other briefs depend on (e.g. the endpoint shape), and the report you want back (branch, commits, test commands run and their result, open questions). Agents commit on their branch, push it and open the PR with CI green; they never merge or release.
5. **Watch**: on `blocked`, read the agent (`herdr agent read <name> --source recent-unwrapped --lines 120`) and bring the question to the user. A notification that a background agent "is waiting on its own background work" is not a report: wait without telling the user. Independent briefs run in parallel; a dependent brief starts once its provider reports done.
6. **Verify** end to end where the stack allows it: build the changed images and run the quickstart check from this repo's `CLAUDE.md` (Verify a change). Done when every brief reported its acceptance criterion met and the end-to-end check passed, or you told the user which part could not be verified.
7. **Review** each branch with the `self-review` skill, passing the brief's goal and acceptance criterion, not the agent's report. Done when every branch has the verdict `ready` or its open findings are with the user.
8. **Report** to the user per repo: branch, worktree path, commits, verification and review result. Once the branch is merged or dropped, stop its agent (Herdr, or `TaskStop` for a background agent) and remove its worktree (`herdr worktree remove`, or `git worktree remove`): a finished agent left alive keeps its background jobs running in the repo.

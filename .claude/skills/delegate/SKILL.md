---
name: delegate
description: Delegate ShopBite work to Claude agents running in the target repositories via Herdr. Use when a task changes code outside this quickstart repo (storefront, Shopware plugin, Shopware project, order printer, backoffice) or spans several repos.
---

# Delegate to repo agents

This repo is the hub. Work in another repository runs in its own Claude agent, started in that repo (or a worktree of it), so the agent loads that repo's `CLAUDE.md` and commits there. You plan, brief, wait and verify; you do not edit other repos' files yourself.

## Setup

- Herdr only: `test "${HERDR_ENV:-}" = 1`. If that fails, tell the user to start the session inside Herdr and stop. Run `herdr --skill` once for exact command syntax and lifecycle states.
- Workspace root: the directory that holds the main checkouts side by side. From any checkout or worktree: `WS=$(dirname "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")`. Repos are `$WS/<repo>`; the README table lists the public ones, a `CLAUDE.md` in `$WS` may list more.

## Steps

1. **Split** the task into one brief per repo. Order them by dependency: the provider first (plugin or Shopware API), then its consumers (storefront, backoffice, order printer). Done when every change the task needs belongs to exactly one brief.
2. **Worktree** per brief, branch named after the task: `herdr worktree create --cwd "$WS/<repo>" --branch <branch> --path "$WS/.worktrees/<repo>/<branch>" --no-focus`. Keep worktrees under `$WS/.worktrees/` so workspace-level instructions and git hooks apply. Take the pane id from the JSON response.
3. **Start** a Claude agent in that pane: `herdr agent start <repo>-<topic> --kind claude --pane <pane-id>`.
4. **Brief** it with `herdr agent prompt <name> "<brief>" --wait`. The brief is self-contained: goal, acceptance criterion, constraints, what other briefs depend on (e.g. the endpoint shape), and the report you want back (branch, commits, test commands run and their result, open questions). Agents commit on their branch; pushing and PRs happen only when the user asks.
5. **Watch**: on `blocked`, read the agent (`herdr agent read <name> --source recent-unwrapped --lines 120`) and bring the question to the user. Independent briefs run in parallel; a dependent brief starts once its provider reports done.
6. **Verify** end to end where the stack allows it: build the changed images and run the quickstart check from this repo's `CLAUDE.md` (Verify a change). Done when every brief reported its acceptance criterion met and the end-to-end check passed, or you told the user which part could not be verified.
7. **Report** to the user per repo: branch, worktree path, commits, verification result. Remove worktrees (`herdr worktree remove`) only when the user says the branch is merged or dropped.

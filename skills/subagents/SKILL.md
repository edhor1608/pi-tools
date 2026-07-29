---
name: subagents
description: Use when the user asks to delegate work to Pi or Claude subagents.
---

# Subagents

Each child is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn more subagents. Give it a self-contained prompt with paths, constraints, and the expected report.

## Harnesses

Use `pi` by default. A Pi child inherits the parent model and thinking level unless `model` or `reasoning_effort` is supplied. Models are addressed as `provider/model-id` when ambiguity is possible.

Claude-family models always run through the `claude` harness. If a spawn requests `harness: "pi"` with a Claude model such as `opencode/claude-fable-5` or the Claude Code alias `fable`, the extension routes it to Claude Code and drops any provider prefix. This also applies when a Pi spawn would inherit a Claude model from its parent.

Use `claude` when the user asks for Claude Code or an independent Claude perspective is useful. Omit `model` and `reasoning_effort` to preserve Claude Code's current defaults. Claude requires the local Claude Code executable to be installed and authenticated.

Reasoning levels accepted by both harnesses are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Claude maps these to thinking-token budgets.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, and optional `working_dir`, `model`, and `reasoning_effort`. There is no extension-level concurrency limit.

- `subagent_check({ id })`: inspect progress without blocking.
- `subagent_list()`: list tracked runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: choose a run, inspect its transcript, steer it, or abort it.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.

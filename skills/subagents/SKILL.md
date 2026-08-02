---
name: subagents
description: Use when the user asks to delegate work to Pi or Claude subagents.
---

# Subagents

Each child is headless, has its own context window, cannot see the parent conversation, and cannot ask the user. Give it a self-contained prompt with paths, constraints, and the expected report. Ordinary workers are leaves; a Claude child explicitly started in `orchestrator` mode can autonomously manage host-visible descendants.

## Harnesses

Use `pi` by default. A Pi child inherits the parent model and thinking level unless `model` or `reasoning_effort` is supplied. Models are addressed as `provider/model-id` when ambiguity is possible.

Claude-family models from supported providers always run through the `claude` harness. Rating-table keys are translated centrally to executable Claude Code aliases: `fable-5` → `fable`, `opus-5` → `opus`, and `sonnet-5` → `sonnet`. If a spawn requests `harness: "pi"` with one of these keys, a Claude model such as `openrouter/anthropic/claude-fable-5`, or a native Claude Code alias, the extension routes it to Claude Code and drops any provider prefix. This also applies when a Pi spawn would inherit a Claude model from its parent. Retired OpenCode references are rejected before Claude routing.

Use `claude` when the user asks for Claude Code or an independent Claude perspective is useful. Omit `model` and `reasoning_effort` to preserve Claude Code's current defaults. Claude requires the local Claude Code executable to be installed and authenticated.

Paid OpenRouter is user-gated and never a fallback. Jonas must first set `"allowPaidOpenrouter": true` in `~/.pi/agent/pi-tools.json` and reload Pi. Even then, each root spawn requires an explicit `openrouter/<model-id>` and `allowPaidOpenrouter: true`. Never edit this user-owned gate yourself; ask Jonas to enable it. OpenRouter cannot be selected by a bare id, inheritance, nested spawn, or fallback. OpenCode providers (`opencode` and `opencode-*`) are retired and rejected explicitly.

Reasoning levels accepted by both harnesses are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Claude maps these to thinking-token budgets.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, and optional `working_dir`, `model`, `reasoning_effort`, `mode`, and per-spawn `allowPaidOpenrouter`. There is no extension-level concurrency limit.

Use `mode: "orchestrator"` when a Claude session should dynamically lead additional Pi or Claude agents. The orchestrator receives scoped `spawn`, `check`, `list`, `send`, `wait`, and `cancel` controls over its descendants. The host records the tree and routes results but does not prescribe a workflow or require approval. Nested orchestrators are possible by explicitly granting that mode again, up to the depth-eight runaway guard. A Pi descendant with no model inherits the root Pi environment rather than Claude's model.

- `subagent_check({ id })`: inspect progress without blocking.
- `subagent_list()`: list the complete ownership tree.
- `subagent_send({ id, message })`: steer or continue any tracked session.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs and their active descendant subtrees while preserving partial transcripts.
- `/subagents`: choose a run, inspect its transcript, steer it, or abort it.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.

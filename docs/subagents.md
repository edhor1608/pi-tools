# Subagents

## Purpose

The extension gives the parent Pi session autonomous background workers with isolated context, persistent native transcripts, automatic result delivery, and interactive takeover.

## Architecture

`extensions/subagents/index.ts` owns the Pi tools, lifecycle hooks, result delivery, and `/subagents` command. An Effect `ManagedRuntime` owns a manager whose scoped sessions normalize both backends into one event model:

- `pi` creates an in-process `AgentSession`, inherits the parent model and thinking level by default, loads resources for the child working directory, and writes a normal Pi session.
- `claude` drives the installed Claude Code executable through `@anthropic-ai/claude-agent-sdk`, preserving its login and defaults when model and reasoning parameters are omitted. Claude's native project transcript remains authoritative.

Claude-family model hints are strict routing signals. A Pi spawn that explicitly requests, or would inherit, a Claude model is sent to the Claude backend instead. Provider-qualified hints such as `opencode/claude-fable-5` become the Claude Code model name `claude-fable-5`; Claude Code aliases `fable`, `haiku`, `opus`, and `sonnet` route directly. An explicit Claude spawn with no model still preserves Claude Code's default rather than inheriting the parent model.

The manager imposes no concurrency limit. It retains at most 64 settled snapshots, but running sessions are never pruned. Effect scope finalizers interrupt and dispose children during cancellation, pruning, and parent shutdown.

Children cannot call the subagent management tools. Claude's native `Agent`, `Task`, and `AskUserQuestion` tools are disabled. Both backends otherwise retain normal host permissions.

## Interaction

`subagent_spawn` returns immediately. If the parent does not explicitly consume a result through `subagent_wait`, settlement is delivered as a follow-up message and can trigger the parent to continue. `/subagents` opens a compact picker and then a full-screen transcript; input steers the selected child, and the view can abort it.

Model-facing output is bounded separately for automatic delivery and multi-agent waits. Full output remains available in the backend session file.

## Origin

The implementation is ported from the subagent extension in `davis7dotsh/my-pi-setup`, as permitted by its author according to the user. The port removes the Codex backend, `/btw`, the concurrency cap, and custom trust gating while adapting package integration and checks to this repository.

## Verification

```bash
pnpm run check
pnpm run test:live:pi
pnpm run test:live:claude
```

The live Pi test uses the configured `openai-codex/gpt-5.6-sol` model when available. The live Claude test uses the local Claude Code authentication and covers completion plus mid-stream interruption.

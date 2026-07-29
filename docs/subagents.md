# Subagents

## Purpose

The extension gives the parent Pi session autonomous background workers with isolated context, persistent native transcripts, automatic result delivery, and interactive takeover.

## Architecture

`extensions/subagents/index.ts` owns the Pi tools, lifecycle hooks, result delivery, and `/subagents` command. An Effect `ManagedRuntime` owns a manager whose scoped sessions normalize both backends into one event model:

- `pi` creates an in-process `AgentSession`, inherits the parent model and thinking level by default, loads resources for the child working directory, and writes a normal Pi session.
- `claude` drives the installed Claude Code executable through `@anthropic-ai/claude-agent-sdk`, preserving its login and defaults when model and reasoning parameters are omitted. Claude's native project transcript remains authoritative.

Claude-family model hints are strict routing signals. A Pi spawn that explicitly requests, or would inherit, a Claude model is sent to the Claude backend instead. Provider-qualified hints such as `opencode/claude-fable-5` become the Claude Code model name `claude-fable-5`; Claude Code aliases `fable`, `haiku`, `opus`, and `sonnet` route directly. An explicit Claude spawn with no model still preserves Claude Code's default rather than inheriting the parent model.

The manager imposes no concurrency limit. It retains at most 64 settled leaf snapshots, but running sessions and tracked ancestors are never pruned. Effect scope finalizers interrupt and dispose children during cancellation, pruning, and parent shutdown.

A Claude spawn with `mode: "orchestrator"` receives an in-process SDK MCP server backed by the same manager. Its `spawn`, `check`, `list`, `send`, `wait`, and `cancel` controls are scoped to its descendant tree and can create either Pi or Claude children. Nested orchestrators require the caller to grant orchestrator mode explicitly again and are capped at depth eight as a runaway-recursion guard. Ordinary Claude workers and Pi children remain leaves. Pi descendants without a model inherit the root Pi environment, not the Claude orchestrator model.

The manager assigns immutable parent links and routes unawaited results to the immediate parent. A completed native orchestrator turn remains logically active while descendants run; their results restart or steer it, and only the final quiescent root settlement is delivered to Pi. Cancelling an orchestrator cancels its active subtree.

Claude's native `Agent`, `Task`, and `AskUserQuestion` tools remain disabled. Native agents can technically call the host MCP tools in Claude Code 2.1.220, but their task IDs and sidechain lifecycle would form a second tree not represented by the manager. Both supported backends otherwise retain normal host permissions.

## Interaction

`subagent_spawn` returns immediately. `subagent_send` lets the main model steer or continue any tracked session. If the immediate parent does not explicitly consume a result through `subagent_wait`, settlement is delivered to that parent and can trigger it to continue. `/subagents` opens a hierarchical picker and then a full-screen transcript; input steers the selected node, and the view can abort it.

Model-facing output is bounded separately for automatic delivery and multi-agent waits. Full output remains available in the backend session file.

## Origin

The implementation is ported from the subagent extension in `davis7dotsh/my-pi-setup`, as permitted by its author according to the user. The port removes the Codex backend, `/btw`, the concurrency cap, and custom trust gating while adapting package integration and checks to this repository.

## Verification

```bash
pnpm run check
pnpm run test:live:pi
pnpm run test:live:claude
```

The live Pi test uses the configured `openai-codex/gpt-5.6-sol` model when available. The live Claude tests use local Claude Code authentication and cover completion, mid-stream interruption, and a real Fable orchestrator delegating concurrently to Pi/Codex and Claude workers.

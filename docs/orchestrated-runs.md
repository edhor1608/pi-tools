# Orchestrated Runs

## Goal

Let the main Pi agent start an explicitly orchestrated Claude Code session. The Claude orchestrator may autonomously spawn, inspect, steer, wait for, and cancel host-managed Pi or Claude descendants. The main agent and `/subagents` remain able to observe and control the entire tree.

The host is a thin control plane, not a workflow engine: it records ownership, routes results, exposes controls, and tears sessions down. It does not impose plans, approvals, queues, roles, or a concurrency limit.

## Plan

- [x] Add parent ownership and explicit worker/orchestrator mode to the manager.
- [x] Route nested results to their immediate parent and keep orchestrators logically active while descendants run.
- [x] Expose scoped host-backed controls to Claude through an in-process SDK MCP server.
- [x] Add model-facing steering and hierarchical visibility to the main Pi surface.
- [x] Add manager, control-tool, UI, and live end-to-end coverage.
- [x] Update prompts, skill documentation, and the architecture record.
- [x] Submit, pass PR review, merge, and install.

## Variant 3 research

Claude Code 2.1.220 can run native `Agent` workers alongside host-backed MCP tools, and native sidechain/task events are observable through the Agent SDK. The current normalized event model does not represent native task IDs, sidechain transcripts, or native task cancellation. Enabling both systems now would create two agent trees and ambiguous control/result semantics. Native `Agent` and `Task` therefore remain disabled for this iteration; their coexistence can be revisited after native task events have a first-class host representation.

## Verification targets

- A real Claude orchestrator sees and invokes the host MCP controls.
- It can create both Pi and Claude descendants without a second manager.
- Descendants appear under the correct parent in manager snapshots and the TUI.
- Unawaited results wake the immediate parent; explicit waits do not duplicate delivery.
- Root completion is not delivered while descendants are still active.
- Main-agent and TUI steering work for nested nodes.
- Cancelling an orchestrator tears down its active subtree.

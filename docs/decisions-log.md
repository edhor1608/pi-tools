# Decisions Log

## 2026-04-11 Structured Compaction As Extension

### Context
Pi already exposes `session_before_compact` and `context` hooks. The goal is a Codex-like replacement-history pipeline without patching Pi core.

### Decision
Implement structured compaction as a pure extension that writes a versioned artifact to `CompactionEntry.details` during `session_before_compact` and rebuilds outbound history from that artifact in `context`.

### Rationale
This preserves Pi's core compaction triggers and session persistence while moving the compacted-history shape behind an extension-owned artifact boundary.

### Consequences
No Pi core patch is required for the first version. Later backends can change compaction generation without changing session format or context-rewrite plumbing.

## 2026-04-11 Separate Backend And Renderer

### Context
The user wanted the design to stay abstract so the compaction step can later be swapped for Codex-server compaction or another worker.

### Decision
Split the pipeline into a backend that produces summary output and a renderer that turns that output into `replacementMessages`.

### Rationale
This keeps the initial implementation small while leaving clear seams for replacing only the compaction engine, only the replacement-history shape, or both.

### Consequences
The first shipped path uses a `pi-model` backend and a `compaction-summary` renderer, but additional backends and renderers can be added without rewriting the extension entrypoint.

## 2026-04-12 Auto Remote Fallback

### Context
The next goal was to use server-side Codex/OpenAI compaction when possible, but keep local compaction as a safe fallback.

### Decision
Add an `auto` backend mode that tries `codex-remote` for compatible OpenAI/OpenAI-Codex models with compatible auth, then falls back to `pi-model` otherwise.

### Rationale
This keeps the default behavior safe while letting compatible sessions benefit from persisted remote replacement history without forcing all sessions onto one provider path.

### Consequences
Remote compaction becomes opportunistic instead of mandatory. Sessions on unsupported providers or unsupported auth still compact locally and continue to work.

## 2026-04-12 Persist Remote Replacement History

### Context
Codex compaction is valuable because the returned compacted history is reused directly on future requests, not just summarized into plain text.

### Decision
Persist raw remote compaction output in the extension artifact and inject it into later compatible `/responses` payloads via `before_provider_request`, while keeping a separate local summary for Pi-visible context.

### Rationale
This matches the important Codex semantics: replace the compacted span with returned compacted history and continue normally. Keeping the local summary separately preserves compatibility when switching to non-compatible providers.

### Consequences
The artifact now carries two layers: a human-readable summary for Pi context and a machine-readable remote replacement history for compatible OpenAI/Codex requests.

## 2026-04-12 Live Codex Remote Probe

### Context
The remote design was implemented from static repo analysis, but the real `openai-codex` endpoint behavior still needed to be confirmed on a live authenticated machine.

### Decision
Probe the live `openai-codex/gpt-5.4` backend directly and align the extension request builder to the live-accepted `/codex/responses/compact` body shape.

### Rationale
A live probe is the only way to verify auth compatibility, accepted request parameters, returned item shapes, and whether future `/codex/responses` calls can continue from the compacted history.

### Consequences
The proven behavior is:
- `POST https://chatgpt.com/backend-api/codex/responses/compact` succeeds with Codex OAuth auth from Pi
- the compact endpoint rejects the extension's earlier `stream` field
- the live-returned compact item shape is `compaction_summary`
- future `/codex/responses` calls must use `stream: true`
- both the raw returned `compaction_summary` item and a normalized `{ type: "compaction", encrypted_content }` item were accepted in a follow-up `/codex/responses` request and preserved the earlier decision context

## 2026-04-12 Full Pi Session Verification

### Context
After validating the endpoint directly, the remaining question was whether a real Pi session would hit the extension hooks in the right order and reuse the persisted remote artifact on a later request.

### Decision
Run a real multi-turn `pi -p` session in an isolated temp project with aggressive compaction settings and an observer extension that logs outbound provider payload shapes.

### Rationale
This validates the actual Pi wiring, not just the raw HTTP endpoint: session compaction, artifact persistence, context rewrite, and request-payload reinjection.

### Consequences
The successful end-to-end behavior observed was:
- a real Pi session wrote a `structured-replacement-history` compaction entry with `backend.kind = codex-remote`
- that compaction entry stored remote output types including `compaction_summary`
- the next outbound `/codex/responses` payload included the persisted compaction item
- the post-compaction follow-up response still answered from the earlier preserved decision context

## 2026-04-12 Flow Continuity Test

### Context
The remaining concern was not whether compaction artifacts exist, but whether a task that starts before compaction can continue cleanly after compaction without losing necessary context.

### Decision
Run a real three-turn coding task in Pi where:
- turn 1 starts a coding task and introduces a session-only codename that is not written to disk
- turn 2 continues the same coding task and forces compaction
- turn 3 continues the same task after compaction without restating the spec or codename

### Rationale
This tests practical continuity instead of raw endpoint correctness. It checks both file/task continuity and non-file conversational context continuity.

### Consequences
The observed continuity behavior was:
- Pi continued the same coding task after compaction and produced the requested follow-up code changes
- the session-only codename `amber-orbit`, which was not written to project files, was still preserved in the post-compaction reply
- the first post-compaction provider payload contained the persisted `compaction_summary` item
- the finished project still passed its test suite after the post-compaction turn

## 2026-04-12 Compaction Metrics Surface

### Context
After validating compaction quality, the next need was to make the reduction visible without manual session-file inspection.

### Decision
Store before/after heuristic compaction metrics in the structured artifact, prepend a short metrics header to the compaction summary shown in Pi, and add a standalone session analyzer script.

### Rationale
This keeps the important numbers close to where compaction happens in the TUI while still allowing offline analysis for any session file.

### Consequences
Compaction messages now show backend, before tokens, after heuristic estimate, saved tokens, and message-count reduction. The analyzer script can report the same numbers later from a saved session file.

## 2026-04-12 In-Chat Compaction Report Command

### Context
Once the analyzer existed, the remaining friction was having to leave Pi and run a separate script just to inspect the current session's latest compaction.

### Decision
Add `/compaction-report` to the structured compaction extension. It uses the same shared report builder as the analyzer script and posts the latest compaction report into the chat as a custom message.

### Rationale
This keeps the command tiny, avoids duplicated logic, and makes the current session's latest compaction report available from inside Pi.

### Consequences
There is now one shared reporting implementation with two surfaces: the standalone analyzer script and the in-chat `/compaction-report` command.

## 2026-04-12 Official Example Alignment Pass

### Context
After the first package version was working, the next step was to compare it against Pi's official extension examples to see whether any runtime patterns, command UX, or file-handling details should be tightened up.

### Decision
Keep the overall architecture, but align the implementation with Pi's official extension patterns in a few targeted ways:
- use `getAgentDir()` instead of manually constructing `~/.pi/agent`
- seed packaged defaults once per process and serialize those writes with `withFileMutationQueue()`
- expand `/compaction-report` into `latest|all` modes with a better collapsed renderer
- add `/trigger-compact` as a small manual companion command
- document clearly that prompt appending is implemented by composing `event.systemPrompt` in `before_agent_start`

### Rationale
These changes improve correctness and polish without changing the core design. The package still stays extension-only and Pi-native, but follows the same patterns used by Pi's own examples more closely.

### Consequences
The package now matches official extension conventions more closely, does less repeated bootstrap work on normal turns, and gives users a better report/compaction control surface inside Pi.

## 2026-04-12 Context Health Extension

### Context
The next useful UI/TUI addition was not more raw token telemetry, but a better signal for whether the current branch is healthy: subscription pressure, cache utilization, and context freshness/rot.

### Decision
Add a separate `context-health` extension that:
- contributes one compact footer status line via `ctx.ui.setStatus()`
- exposes `/context-health` for a detailed in-chat snapshot
- shows subscription usage as exact when a provider exposes it, otherwise as a clearly marked estimate
- computes cache health as a rolling cache-read ratio over recent assistant turns
- computes rot as a compound score from context usage, turns since compaction, and uncached input since compaction

### Rationale
This keeps Pi's default footer intact while surfacing the few context-quality signals Pi itself does not show well. It also keeps the feature separately toggleable inside the package.

### Consequences
`pi-tools` now has a third extension focused on live context health, not just prompt shaping and compaction mechanics.

## 2026-04-12 Workflow Todos Extension

### Context
The next missing workflow primitive was not another queue, but a way to park "do this next" work without auto-sending it to the agent while current work was still unresolved. The key failure mode to avoid was a blocked current task being replaced by an unrelated queued follow-up.

### Decision
Add a separate `workflow-todos` extension with a hybrid workflow model:
- do not use todos for trivial one-step work by default
- allow a workflow to appear naturally when work becomes multi-step or blocked
- let both the user and the agent manage workflow todos
- keep todo states explicit: `active`, `pending`, `blocked`, `done`, `cancelled`
- support dependency links through `dependTo`
- provide an editable custom UI via `/todos`
- provide quick commands via `/todo ...`
- expose a `workflow_todos` tool to the model
- append the workflow concept and current workflow state into the system prompt

### Rationale
This creates a third workflow primitive distinct from steering and follow-up queueing: a parked-next-work list that is editable, branch-aware, and safe when the current task is blocked. It also gives the agent a shared model of the workflow instead of keeping all of that state only in the user's head.

### Consequences
`pi-tools` now has a fourth extension that covers workflow state, not just prompt shaping, live health, and compaction.

## 2026-04-13 Notify Extension

### Context
Pi already had the extension hooks needed for terminal title changes and fire-and-forget notifications, but the default experience stayed comparatively quiet: little indication that the agent was actively working, and no native notification when it became ready or needed user input again.

### Decision
Add a separate `notify` extension that combines two simple official-example patterns:
- a title-bar spinner while the agent is working
- a native terminal notification when the agent stops and is actually waiting on the user

The extension also distinguishes between normal readiness, needs-input/question endings, error endings, and queued follow-up states.

### Rationale
This keeps the implementation small and Pi-native while making the terminal experience feel much more alive. The important improvement is not more telemetry, but better signalling at the exact moments when the user cares: working, ready, needs input, error.

### Consequences
`pi-tools` now has a fifth extension that improves terminal ergonomics and agent-state visibility without modifying Pi core.

## 2026-04-13 Workgraph Refactor

### Context
The original `workflow-todos` concept was useful, but the intended semantics had drifted away from a literal todo list. The real goal was a sparse issue-style planning layer: later work can be parked without queueing it to the model, and dependencies can be captured without turning the list into a step-by-step checklist.

### Decision
Refactor the workflow layer into a new `workgraph` extension that:
- keeps the same core states: `active`, `pending`, `blocked`, `done`, `cancelled`
- keeps dependency links through `dependTo`
- adds execution metadata per item: `local` or `parallel`
- adds item kinds: `work` and `merge`
- keeps the editable custom UI, but renames the surface to `/graph` and `/item ...`
- reads old `workflow-todos-state` entries so existing sessions still reconstruct, but persists new `workgraph-state` entries going forward
- updates the system prompt guidance to prefer sparse issue-style graphs instead of implementation-step subtasks

### Rationale
This keeps the lightweight, Pi-native workflow feel while making the concept match the actual intended use. The graph becomes a place to preserve structure and avoid drift, not a second-by-second task manager.

### Consequences
`pi-tools` now has a dedicated planning layer named for what it actually is. Existing workflow state can still be read, but the package surface now pushes users and the model toward sparse workgraph usage.

## 2026-04-13 Parallel Worktree Preparation

### Context
The next desired step was not full automatic parallel execution yet, but a clean way to prepare truly independent work in isolated git worktrees so the graph could evolve toward a real executor later.

### Decision
Add a separate `parallel` extension that:
- inspects the current `workgraph`
- prepares eligible `parallel` items into real git worktrees on dedicated branches
- stores the resulting `repoRoot`, `worktreePath`, `branchName`, and worker prompt back on the graph item
- exposes `/parallel prepare`, `/parallel list`, and `/parallel prompt <id>`
- keeps merges explicit as separate `merge` items rather than auto-merging work behind the user's back
- requires a clean working tree for preparation, because new worktrees branch from `HEAD`

### Rationale
This gives the package a real execution-oriented second layer without overcommitting to a subprocess model too early. It proves the graph/worktree/handoff flow end-to-end while keeping the future executor design open.

### Consequences
`pi-tools` now has six extensions total, and the planning layer is paired with a scaffold-only parallel preparation layer that can later grow into a real executor.

## 2026-04-14 Stash Extension

### Context
The original workflow pain point was not always a structured graph item. Sometimes the user simply had a full future prompt in mind and needed a place to save it without turning it into a steering message or a queued follow-up. That needed a separate primitive from both the follow-up queue and the workgraph.

### Decision
Add a separate `stash` extension that:
- stores full deferred prompts as custom session state instead of chat messages
- keeps stashed prompts entirely out of model context while they are waiting
- supports three release modes per item: `manual`, `draft`, `send`
- uses strict FIFO ordering by default, while still allowing manual reordering and editing
- auto-releases only from `agent_end` and only when a shared extension-side classifier says the agent ended in a true `ready` state
- blocks auto-release on `question`, `error`, `queued`, or `stopped` endings
- uses shortcuts for the common flow: stash current editor text or open the stash UI

### Rationale
This preserves the original idea as its own first-class interaction model instead of stretching the workgraph to cover a different problem. It also keeps the feature smooth and non-invasive: no system-prompt pollution, no hidden model calls, and no extra runtime dependency extension.

### Consequences
`pi-tools` now has seven extensions total. The package now covers both structured later work (`workgraph`) and raw deferred future prompts (`stash`) as separate concepts.

## 2026-04-14 Context Files Extension

### Context
Pi's built-in AGENTS.md and CLAUDE.md discovery is useful, but it is all-or-nothing. In practice, some inherited context files are useful to keep on disk and visible in discovery while still being too noisy or too broad for a specific project session.

### Decision
Add a separate `context-files` extension that:
- re-discovers the same AGENTS.md and CLAUDE.md files Pi core would load for the current cwd
- stores a project-local disabled-path list in `.pi/context-files.json`
- exposes `/context-files` as an interactive toggle UI
- filters disabled files out of the final `# Project Context` section in `before_agent_start`
- leaves Pi core discovery untouched, which means the startup context list still reflects discovery rather than extension-side filtering

### Rationale
This keeps the implementation small and extension-only while still solving the real problem: control over what actually reaches the model. Project-local persistence is the simplest default and avoids introducing global/project conflict rules in v1.

### Consequences
`pi-tools` now has eight extensions total. Users can keep Pi's normal context-file discovery and still disable specific inherited files for a given project without renaming or deleting them.

## 2026-04-14 Workgraph And Parallel Extraction

### Context
The `workgraph` and `parallel` extensions were useful, but they broadened the package away from its tighter core around prompt shaping, context control, deferred prompts, notifications, and compaction. The implementation should be preserved, but the main package should no longer ship those surfaces by default.

### Decision
Preserve the current implementation on a separate branch, `workgraph-parallel`, and remove the `workgraph` and `parallel` extensions from the main package branch.

### Rationale
This keeps the experimental planning and worktree-preparation work intact without making the main package carry a larger workflow surface than intended.

### Consequences
The main branch now returns to the smaller context-focused package surface, while `workgraph` and `parallel` continue to exist on the preserved branch for later reuse or extraction.

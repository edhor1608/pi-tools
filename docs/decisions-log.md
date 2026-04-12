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

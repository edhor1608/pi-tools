# Decisions Log

## 2026-08-01 External Session Transcript Migration

### Context

Claude Code and Codex keep structured local session histories, but Pi can only resume native Pi session files. Jonas wants to discover those external sessions from Pi and continue their work without returning to the originating harness.

### Decision

Add an external-session importer that discovers Claude Code and Codex sessions and migrates a selected transcript into a new native Pi session. `/resume-external` is the primary combined picker; `/resume-claude` and `/resume-codex` are source-filtered aliases.

Preserve user and assistant conversation content. Normalize external tool calls and results into provider-independent transcript representations rather than replaying their raw protocol objects as Pi tool calls. Retain provenance such as source harness, original session id and file, working directory, model, and import time as non-contextual Pi session metadata. The source session remains unchanged.

### Rationale

A native Pi session integrates with Pi's existing resume, tree, compaction, naming, and model-switching behavior. Normalized tool activity keeps the imported context valid across providers and changing external schemas, while provenance preserves traceability. This provides substantially more continuity than a summary-only handoff without the fragility of treating foreign files as writable Pi sessions.

### Consequences

Migration creates a snapshot rather than a live two-way sync. Exact external UI events, hidden reasoning, permissions, and provider-specific tool semantics may not survive, although their useful visible output should. Import adapters and fixtures are required separately for Claude Code and Codex, and repeated imports need an explicit duplicate/re-import policy before implementation.

## 2026-08-01 Pi-Native Personal Agent System

### Context

Jonas's fresh Claude Code setup defines orchestration roles, benchmark-driven model selection, shared findings and memory, Jonas Voice, lifecycle failure detection, personal linting, and review-fix loops. Pi should adopt those semantics without copying Claude Code's external Codex wrapper mechanics: Codex models run natively in Pi, while every Claude-family model runs through the existing Claude Code backend and subscription. OpenCode is paid per token and must remain a rare, explicit opt-in rather than a fallback.

The shared-memory contract is only partially initialized: `~/memories/findings/` has content, but `~/memories` is not yet a git repository and `memory/<repo>/` does not exist. Pi's custom statusline also replaces the built-in footer and currently hides statuses published by extensions such as subagents.

### Decision

Build the system in four phases:

1. **Foundation:** initialize `~/memories` as a local-only git repository, add the `findings/` index and `memory/<repo>/` structure, keep `tool-failures.jsonl` outside git, inspect existing Claude and Codex memory stores before creating links, and copy the selected fresh skills into each harness deliberately. Audit and then remove retired Pi Fabric, the orphaned `~/.pi/agent/model-system-prompts/` configuration, and obsolete or misplaced Pi worktrees without deleting unmerged work.
2. **Pi-native guards:** add strict model routing, compose extension statuses into the statusline, and add native lifecycle-error, usage-guard, personal-lint, and session-gap/catchup adapters. These replace shell-hook workarounds where Pi exposes direct lifecycle events.
3. **Visible review mode:** add a session-persisted review-loop state machine with `/review-loop on|off|status|now`, agent-callable control, footer status, stable git fingerprints, verification-gate checks, and review execution through the existing subagent control plane.
4. **Full loop:** triage findings, send one accepted fix batch back to the owning worker lineage, verify the result, and re-review until clean or a defined stop condition requires root-cause work or user input.

Place each capability deliberately:

- **Orchestration:** copy and adapt the fresh Claude orchestration skill for Pi. Preserve the orchestrator, advisor, worker, shepherd, and independent-reviewer role grammar; task cards with goal, acceptance criteria, file ownership, exclusions, verification command, and report format; worktree isolation through `wt`; explicit completion markers; reading every worker result; and independent verification of every done claim against git and gate evidence. Remove Claude-specific `codex exec`, wrapper-agent, timeout-resume, and shell-relay mechanics. Keep `extensions/subagents/` as a thin execution and control plane rather than embedding workflow policy in it.
- **Model selection:** copy the fresh benchmark-blended model-by-effort table, methodology, focus/taste/advice dimensions, standing escalation permission, and update procedure into Pi's model-picking skill. Rewrite only execution mechanics: Codex is native Pi, Claude is Claude Code, and OpenCode is explicit paid opt-in. The model policy extension enforces routes while the skill supplies judgment about which model and effort to choose.
- **Cross-harness execution:** do not port Claude-to-Codex CLI skills as cross-harness machinery. Replace them with native Pi spawning plus common prompt contracts. Preserve non-interactive execution, explicit anti-recursion instructions where an external harness is involved, fresh isolated reviewer context, and the rule that repository evidence outranks a completion report.
- **Shared findings:** copy the finding skill into Pi while keeping `~/memories/findings/` as the shared data store. Preserve symptom-first lookup before unclear debugging, thresholded capture, deduplication, verification that an old finding still applies, compact symptom-keyed files, and `INDEX.md` maintenance.
- **Shared project memory:** copy the memory skill into Pi while keeping `~/memories/memory/<repo>/` as the shared data store. Load relevant memory before non-trivial repository work, capture durable non-derivable feedback and context, prefer updates over duplicates, and commit memory mutations through a path-scoped, cross-process-safe operation.
- **Jonas Voice:** copy the complete skill, `VOICE.md`, examples, flow rules, and corpus into Pi. Keep it a progressively disclosed writing skill rather than global prompt weight, and preserve register selection and corpus-grounded self-checks.
- **Lifecycle failure detection:** add a Pi extension that observes failed `tool_result` events and provider/assistant failures, skips user interruptions, redacts likely secrets, and appends bounded records to the shared local failure log. Logging failures must never break the original agent run.
- **Usage guards:** retain the existing Codex usage display and add latched warning/wrap-up policy at the agreed thresholds so the agent stops expanding scope, persists work, and produces a handoff before exhaustion. Claude Code children continue using Claude Code's subscription and guard mechanics; Pi must not query paid OpenCode or silently reroute when a limit is reached.
- **Session gaps:** port the two-day inactivity check to Pi lifecycle events. On the first prompt after a long gap, inject the catchup workflow, verify current git/tasks/files/background-agent state, and reconnect Jonas to the task before proceeding.
- **Personal lint:** keep `~/.agents/personal-lint/` as the shared implementation and add only a Pi adapter. Lint successful edited JS/TS files immediately and sweep agent-created changes at settlement when needed; return focused diagnostics to the agent, never run repository-wide fixes, and never present personal rules as project CI requirements.
- **Review and review-fix:** copy the external-review and review-loop contracts, but use native Pi/Claude subagents. Preserve fresh eyes, reviewer independence, read-only intent, model-family diversity for risky work, concrete severity-ranked findings, explicit verdicts, validity checks, finding triage, same-worker fix lineage, and mandatory re-review of accepted fixes. Expose current phase, round, reviewer, and blocked reason in the TUI.

Use these routing invariants:

- Codex and other approved non-Claude Pi models run through Pi's native subagent backend.
- `fable`, `opus`, `sonnet`, `haiku`, and all Claude-family model ids always route through Claude Code, even if a caller mistakenly requests the Pi harness.
- A non-Claude model requested through the Claude harness is rejected.
- OpenCode requires an explicit provider-qualified request and explicit opt-in. It is never selected as a fallback.
- An unavailable requested model or backend is an error, never permission to substitute another provider.

Keep skills as intentional per-harness copies. Do not introduce a canonical shared skill store or symlink all harness skill directories. Port only the semantic contracts each harness needs and accept that harness-specific copies can diverge as their mechanics evolve.

Initialize `~/memories` as a local-only git repository. Do not add a remote yet and do not merge the separate generated `~/.codex/memories` repository blindly. Keep failure telemetry untracked because commands, paths, errors, and credentials may appear in it.

Implement review-loop mode as a hybrid automatic mode. The user or an agent may turn it on when substantive work should enter the loop. Once enabled and the entry gate is green, the mode automatically reviews the stable target. A valid accepted finding always causes a fix followed by another verification and fresh re-review; fix and re-review are the purpose of the mode, not optional follow-up actions. Continue until the accepted lenses are clean or a hard stop fires. An invalid review is retried and never treated as a pass. Repeated major findings trigger root-cause/design handling rather than endless polishing. Backend failure blocks visibly and never falls back to OpenCode. The mode does not merge or land work unless that authority was separately granted.

### Rationale

Pi can switch Codex models natively and already has a Claude Code backend, so Claude Code's `codex exec`, wrapper-agent, timeout-resume, and shell-based cross-harness machinery would add indirection without value. Skills remain the right place for judgment, role grammar, model ratings, task-card contracts, and evidence rules. Extensions are the right place for lifecycle events, routing enforcement, persistent mode state, and TUI visibility. The existing subagent manager remains a thin execution and control plane rather than absorbing workflow policy.

Per-harness skill copies are an explicit user choice. They permit each harness to express its native mechanics directly, at the cost of requiring deliberate synchronization of shared semantic changes.

The review loop is agent-toggleable because the orchestrator must be able to enforce review discipline without waiting for a separate user command. Mandatory fix and re-review preserve the defining feedback loop while fingerprints, gates, validity checks, convergence rules, and blocking states prevent reviews of moving targets and unbounded silent churn.

### Consequences

The first implementation work must repair shared-memory assumptions and status visibility before automating reviews. Review state must survive session resume through Pi custom entries, while in-flight reviewer processes are treated as non-durable and restored as pending. The statusline becomes the single footer compositor and renders extension statuses on a second line. The review extension consumes a narrow typed interface from the existing subagent manager rather than creating another agent runtime.

Skill drift is now accepted rather than eliminated. Ports must identify shared semantic changes explicitly and update the relevant harness copies when desired. Local-only memory has reviewable history on this machine but no off-machine backup until a separate remote decision is made.

### Implementation addendum (2026-08-01)

Durable decisions made while building the system:

- **Cross-extension state uses `globalThis` + `Symbol.for`.** Pi loads every extension through its own jiti instance with module caching disabled, so module-level singletons are per-extension, not per-process. The status bus (`pi-tools.status-bus.v1`), the subagent control-plane handle (`pi-tools.subagent-plane.v1`), and the lifecycle-failures primary claim all anchor shared state on the global symbol registry. Any future cross-extension channel must use this pattern; a plain module global silently fails.
- **The statusline composes two status sources**: the typed status bus (tone + order) and Pi's native `ctx.ui.setStatus` map (text only, sorted by key, bus wins on id collision). Extensions inside this package publish to the bus; foreign extensions remain visible through the native path.
- **Reviewers run on the live subagent manager** via a narrow published handle (`spawn`/`waitFor`/`send`/`cancel`/`get`), so review runs appear in `/subagents`, inherit the routing invariants, and are cancelled on mode-off and teardown. The reviewer's private fallback runtime exists only for tests and handle absence. `review_loop` is excluded from ordinary Pi children so a child cannot arm a hidden review runtime.
- **Review targets are fingerprinted completely or not at all**: HEAD, porcelain status, tracked diff, and untracked file contents (bounded: 1000 files, 1 MiB each) in deterministic order. Non-git or failing-git states block visibly instead of producing a stable constant. All async review/fix/verify operations carry epoch and operation ids; stale completions are ignored, and resume reconciles every active phase back into a dispatchable pending action.
- **Verification is a configured gate, not a byte-change check**: `.pi/review-loop.json` may set `verifyCommand` (exit 0 required in addition to a changed fingerprint) and `nonClaudeReviewerModel` (default `gpt-5.6-sol`) for cross-family reviews of Claude-authored work. Without a command the status labels the weaker mode `verify: fingerprint-only`.
- **Usage-guard latches are session-scoped** (`session|window|resetAt|level|channel`), matching the Claude reference semantics so a fresh session near exhaustion is still warned, with throttled mid-turn checks delivering notify/status warnings without consuming the next-turn system-prompt directive.
- **Bare model ids prefer native providers.** A bare id that resolves under both OpenCode and a native provider routes natively (that is the requested model, not a substitution); an OpenCode-only bare id errors with the provider-qualified id and the `allowPaidOpencode` opt-in. Non-Claude OpenCode models are unavailable to nested orchestrator spawns by policy.
- **Pi skill frontmatter must satisfy a strict YAML parser.** Descriptions containing `": "` need folded block scalars; Claude Code's lenient parser masks this, so ported skills are validated against Pi's own `loadSkillsFromDir` before being considered installed.
- **Known environment risk:** `pi -p` non-interactive *text* mode intermittently stalls with zero output in this environment (time-window flakiness; `--mode json` streams the identical run to completion). Bisection exonerated every package extension individually and the full package in clean windows; the lead points at pi-core text-mode/provider-stream behavior. Tracked in `~/memories/findings/pi-print-mode-intermittent-hang.md`; re-evaluate on the next Pi upgrade.
- **Cleanup outcomes:** `~/repos/pi-fabric` (no remote; only history) archived to `~/backups/pi-fabric-archive-20260801.tar.gz` with a provenance README, then removed. `~/.pi/agent/model-system-prompts/` backed up to `~/backups/` and removed. Left untouched and reported for later manual triage: `~/repos/pi-tools-add-worktrees-extension` (dirty), `~/repos/circle-of-doom-*-wt` (unpushed commits), `~/repos/worktrees/` (misplaced parking directory).

## 2026-07-29 Host-Managed Claude Orchestration

### Context

Claude Code cannot be used as the main Pi model through the user's subscription, but Claude models are valuable as autonomous orchestrators and advisors. A Claude orchestrator must be free to choose and direct Pi or Claude workers while the main Pi agent and user can still inspect, steer, and cancel the resulting work. Claude Code's native `Agent` system can coexist with custom SDK tools, but it would create a second agent tree that the current manager and UI do not represent.

### Decision

Add an explicit orchestrator mode for Claude sessions. Give those sessions scoped, host-backed subagent controls through an in-process Claude Agent SDK MCP server. Extend the existing manager from a flat registry to an ownership tree and route nested results to their immediate parent. Keep the host as a thin control plane: no prescribed workflow, approvals, queue, role system, or concurrency limit. Keep Claude's native `Agent` and `Task` tools disabled until their task IDs, sidechain transcripts, lifecycle, and cancellation can be represented in the same host graph. This supersedes the blanket recursive-subagent restriction in **2026-07-29 Pi And Claude Subagents** while preserving it for ordinary workers.

### Rationale

An in-process MCP bridge gives Claude direct autonomous delegation without IPC or a second runtime. Reusing the shared manager preserves Pi and Claude workers, normalized transcripts, steering, cancellation, and `/subagents` visibility. Explicit orchestrator mode prevents ordinary Claude workers from recursively delegating unless their caller intentionally grants that capability.

### Consequences

Orchestrated runs are process-scoped rooted trees. The main Pi session can control every node, while an orchestrator can control only its descendants. Granting orchestrator mode remains explicit at every level and is capped at depth eight; flat worker fan-out retains the existing lack of a concurrency limit. Unawaited child results return to their immediate parent and can restart an idle orchestrator; root completion waits until active descendants have returned. Cancelling or failing an orchestrator cancels its active subtree. Native Claude agents remain unavailable in this mode despite being technically compatible with the MCP controls.

## 2026-07-29 Route Claude Models Through Claude Code

### Context

The spawn API exposes both a harness and a model hint. That allowed a caller to request the Pi harness with an OpenCode Claude model such as `opencode/claude-fable-5`, even though Claude models are intended to consume the existing Claude Code login and subscription. Prompt guidance alone did not prevent the parent agent from selecting this mismatched combination.

### Decision

Treat Claude-family models and Claude Code's `fable`, `haiku`, `opus`, and `sonnet` aliases as strict routing signals. If a Pi spawn explicitly requests or would inherit a Claude model, route it to the Claude backend and pass the unqualified model id to Claude Code. Apply the same normalization to provider-qualified model hints already sent to the Claude backend. Preserve Claude Code defaults when the Claude harness is explicitly selected without a model.

### Rationale

The model choice states the user's intended execution provider more directly than a mistaken harness argument. Enforcing the invariant in the manager covers tool calls and future callers, while provider-prefix removal converts Pi model references into the model names accepted by Claude Code.

### Consequences

Claude-family models can no longer run through Pi subagents or OpenCode routing. They require an installed, authenticated Claude Code executable and consume its allowance. The spawn result reports the effective Claude harness rather than the originally requested Pi harness.

## 2026-07-29 Pi And Claude Subagents

### Context

The setup needs background agents with isolated context, live control, and durable transcripts. Pi already provides an in-process SDK for agents using the configured model runtime, while the Claude Agent SDK can drive the locally installed and authenticated Claude Code executable through the user's subscription. The reviewed `davis7dotsh/my-pi-setup` demonstrates the desired interaction model, and the user confirmed that its author explicitly permits reuse.

### Decision

Port the reviewed Effect-based implementation as the foundation, with Pi and Claude backends only. Do not add a separate Codex backend because Codex models remain available through Pi. Support automatic result delivery, a compact `/subagents` picker followed by full-screen takeover, streaming, steering, cancellation, separate child sessions, and context-usage display. Do not add `/btw`, an extension-level concurrency limit, custom project trust gating, or sandboxing. Always load project resources for the child working directory. Children run with normal host permissions; Claude runs headlessly without interactive permission prompts. When model or reasoning parameters are omitted, preserve Claude Code defaults; Pi inherits the parent model and thinking level.

### Rationale

Pi and Claude cover the useful model diversity without duplicating Pi's Codex support. Effect scopes and event streams fit the lifecycle complexity of concurrent child sessions, cancellation, and teardown. A hard concurrency limit would impose policy the user does not want; machine resources, provider limits, and explicit cancellation remain the operational bounds.

### Consequences

The extension must treat every child prompt as autonomous privileged execution and clearly expose running work. It must shut down all child scopes deterministically, bound model-facing output, and prevent children from recursively invoking subagent tools. Claude availability depends on an installed, authenticated Claude Code executable and consumes the user's existing subscription allowance.

## 2026-07-29 Native Node And Oxide Toolchain

### Context

The package used Bun to install dependencies and execute ad hoc TypeScript assertion scripts, while `tsc --noEmit` was the only static check. Node 26 now executes this repository's erasable TypeScript syntax natively, TypeScript 7 is stable, and Oxlint can report both type-aware rules and compiler diagnostics through its `typeCheck` mode.

### Decision

Use pnpm `11.9.0` with a frozen `pnpm-lock.yaml`, Node `>=26` for direct TypeScript execution, and `node:test` with `node:assert/strict`. Use Oxfmt for formatting. Use Oxlint `1.76.0` with `oxlint-tsgolint`, root `typeAware` and `typeCheck` options, and warnings denied. Remove the separate `tsc --noEmit` command while retaining TypeScript `7.0.2` for project/editor types. Explicitly deny unused transitive build scripts in `pnpm-workspace.yaml`.

### Rationale

This is the smallest modern toolchain for a Node-only Pi extension package. Native execution avoids a redundant transpiler, `node:test` supplies a real test lifecycle, and Oxlint's compiler diagnostics make a second typecheck process unnecessary. Oxfmt and Oxlint give one deterministic `pnpm run check` gate.

### Consequences

Development requires Node 26 and pnpm. Runtime TypeScript must remain erasable; `erasableSyntaxOnly` and `verbatimModuleSyntax` enforce that constraint. `pnpm run check` is authoritative and runs formatting verification, lint/type diagnostics, and all tests. If future code needs TSX, decorators, runtime enums, or tsconfig path transformation, the script-runner decision must be revisited.

## 2026-07-29 Reduce Package To Three Extensions

### Context

The package had grown to seven extensions, but only file footnotes, stash, and structured compaction are wanted in the active setup. Keeping disabled code still installs dependencies, expands the maintenance surface, and makes every Pi upgrade broader than necessary.

### Decision

Remove context-health, context-files, model-system-prompt, and notify completely from package resources, source, tests, defaults, and current documentation. Keep historical decisions in this log as superseded records. Remove seeded global model-system-prompt files from the active Pi installation.

This supersedes **2026-04-12 Context Health Extension**, **2026-04-13 Notify Extension**, and **2026-04-14 Context Files Extension**.

### Rationale

Three maintained extensions are simpler than seven installed-but-filtered extensions. Deletion also removes the unrelated context-files compatibility failure and avoids carrying model prompt defaults for models that are no longer active.

### Consequences

Installing `pi-tools` now exposes exactly three resources. Context-file filtering, context-health telemetry, package-owned model prompts, terminal title animation, and native completion notifications are no longer provided. Existing session history is retained because it is user data, not installed extension state.

## 2026-07-29 Pi 0.82 Port And Public File Footnotes

### Context

Pi moved its packages from `@mariozechner/*` to `@earendil-works/*`, changed the model/auth runtime, exposed the Responses converter publicly, added finalized-message replacement, and expanded compaction results. The old file-footnote renderer patched private TUI classes, while structured compaction imported a provider file and Pi version through absolute Homebrew paths.

### Decision

Set Pi `0.82.1` as the package baseline. Port every package import to the current scope so one package install has one Pi runtime. Keep structured compaction extension-owned, but use public conversion/auth APIs, current Codex headers, compact-result usage, and display-only report entries. Replace the file-footnote renderer patch with a persisted markdown transformation returned from `message_end`. Keep stash semantics unchanged while widening its shared UI helpers to `ExtensionContext`.

This supersedes the private-renderer portion of **2026-04-14 File Footnotes Extension** and the custom-message transport in **2026-04-12 In-Chat Compaction Report Command**. Their product intent remains current.

### Rationale

A mixed old/new Pi dependency graph would preserve hidden compatibility risks. Public hooks remove absolute install paths and TUI prototype coupling. Persisted footnotes trade collapsibility for stable resume/export behavior, which is the selected product direction. Display-only reports retain the in-session UI without adding diagnostics to model context.

### Consequences

The package requires Pi `>=0.82.1 <0.83.0`. File footnotes are always visible and no longer use `Ctrl+Shift+O`. `complete()` temporarily comes from `pi-ai/compat` and must be revisited when Pi removes that bridge. Provider-native compaction remains contract-tested and requires a live canary on future Pi or Codex payload changes.

## 2026-05-20 Agent Skill Tracker Setup

### Context

The repo needs per-repo configuration for Matt Pocock's engineering skills before using `to-issues`, `to-prd`, `triage`, `diagnose`, `tdd`, `improve-codebase-architecture`, or `zoom-out`. Existing work is tracked in Linear, but not yet in the intended structure.

### Decision

Document Linear as the issue tracker: Linear Documents hold durable planning and research artifacts, while Linear Issues and Subissues hold executable work. Use `AFK` for `ready-for-agent`, `HITL` for `ready-for-human`, and keep this repo as a single-context domain-doc layout.

### Rationale

This matches the existing workspace labels and avoids moving work into GitHub Issues just because the code remote is GitHub. Keeping domain labels separate from workflow labels makes future Linear cleanup less ambiguous.

### Consequences

Engineering skills should read `AGENTS.md` and `docs/agents/*.md` before writing to Linear. Existing Linear projects can be cleaned up later without changing this repo-level convention.

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

## 2026-04-14 File Footnotes Extension

### Context
Pi's normal markdown rendering shows file links inline as a short linked label followed by the full target path in muted text. That preserves visibility, but it makes assistant answers with many file references much harder to read.

### Decision
Add a separate `file-footnotes` extension that:
- patches Pi's internal assistant-message markdown renderer
- detects file links and renders them inline as numbered references instead of inline full paths
- appends a numbered footnote list under the same assistant message with the full file targets
- leaves non-file links on Pi's normal inline rendering path

### Rationale
A companion message or on-demand readability view would be easier to implement, but noisier. The footnote-style inline patch gives the intended reading flow directly where the assistant answer is rendered.

### Consequences
`pi-tools` now has seven extensions total again. Assistant answers with many file references read more naturally, but this extension intentionally relies on Pi internals and may need updates when Pi changes its assistant markdown renderer.

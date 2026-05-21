# Pi Version Notes

This repo is currently developed and validated against Pi `0.75.3`.

The `0.67.7` through `0.75.3` changelog gap was reviewed and revalidated on `2026-05-20`.

Source used for this review:
- local Pi install `0.75.3`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`

## Adopted 0.68.x-0.75.x Changes

### Package Scope Migration

Relevant versions:
- `0.74.0`
- `0.73.1`

What changed upstream:
- Pi package references moved from `@mariozechner/*` to `@earendil-works/*`
- `pi update --self` supports migrating the global package name

What this repo now does with that:
- imports and peer dependencies now use `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`
- structured-compaction now resolves Pi's internal OpenAI Responses shared converter relative to `@earendil-works/pi-ai/openai-responses` instead of a global install path
- README install examples now use `npm install -g @earendil-works/pi-coding-agent`

Repo surfaces:
- `package.json`
- `README.md`
- `extensions/**`
- `scripts/**`

### XML Project Context Boundaries

Relevant version:
- `0.75.0`

What changed upstream:
- Pi changelog says system prompt and context-file boundaries now use explicit XML tags in some prompt paths
- installed `0.75.3` still emits the legacy Markdown `# Project Context` section for the default prompt path, but emits `<project_context>` for custom prompts

What this repo now does with that:
- `context-files` filters both legacy Markdown project context sections and XML `<project_context>` sections
- `context-files` uses Pi's `event.systemPromptOptions.contextFiles` list during `before_agent_start` so filtering tracks the files Pi actually loaded
- `scripts/test-context-files.ts` covers both prompt shapes
- `scripts/test-context-files.ts` covers literal `</project_context>` text inside context-file content

Repo surfaces:
- `extensions/context-files.ts`
- `scripts/test-context-files.ts`

### Node Runtime Baseline

Relevant version:
- `0.75.0`

What changed upstream:
- Pi raised the minimum supported Node.js version to `22.19.0`

What this repo does with that:
- `package.json` declares `node >=22.19.0` to match Pi's runtime baseline
- README install guidance now points users at the renamed current Pi package

### Assistant Markdown / TUI Rendering

Relevant versions:
- `0.74.1`
- `0.73.1`
- `0.73.0`
- `0.70.5`

What changed upstream:
- Pi TUI markdown gained list indentation, task-list checkbox rendering, large-markdown robustness, inline image fixes, compact read rendering, and OSC hyperlink update rendering

What this repo now does with that:
- `file-footnotes` still patches assistant Markdown only for file-link footnotes
- `scripts/test-file-footnotes.ts` now compares non-file link output after stripping Pi's assistant prompt-marker OSC sequences, because assistant message rendering can wrap core Markdown output with message markers

Repo surfaces:
- `extensions/file-footnotes.ts`
- `scripts/test-file-footnotes.ts`

### Provider / Model Metadata Changes

Relevant versions:
- `0.75.1`
- `0.75.0`
- `0.74.1`
- `0.72.0`
- `0.71.1`
- `0.71.0`
- `0.70.3`
- `0.70.1`
- `0.70.0`
- `0.69.0`
- `0.68.1`

What changed upstream:
- `thinkingLevelMap` replaced old `compat.reasoningEffortMap`
- GPT-5.5 Codex, Together AI, DeepSeek, Fireworks, Moonshot, Cloudflare, and Xiaomi providers/models were added or corrected
- OpenAI Codex transport, cache/session-affinity, Responses, WebSocket fallback, and model metadata behavior changed repeatedly

What this repo does with that:
- no direct code change is required for `thinkingLevelMap` because this package does not register providers or ship `models.json`
- structured compaction remains high-risk because it imports an internal OpenAI Responses converter and constructs `/responses/compact` calls directly
- defaults now include an `openai-codex/gpt-5.5` prompt fragment derived from the official Codex model metadata

Repo surfaces:
- `extensions/structured-compaction/**`
- `defaults/model-system-prompts/**`
- `defaults/structured-compaction/README.md`

### Extension UI Lifecycle APIs

Relevant versions:
- `0.75.0`
- `0.74.0`

What changed upstream:
- Pi exposes `thinking_level_select` for model/thinking-level changes
- Pi exposes working loader controls through `ctx.ui.setWorkingMessage`, `setWorkingVisible`, and `setWorkingIndicator`
- Pi exposes `message_end` as a finalized-message rewrite hook

What this repo now does with that:
- `context-health` listens to `thinking_level_select` and includes the active thinking level in its footer status and `/context-health` details
- `notify` uses `ctx.ui.setWorkingIndicator` and `ctx.ui.setWorkingMessage` while the agent is active, then restores Pi defaults when the run ends
- `message_end` was evaluated for `file-footnotes`, but not adopted because this extension needs display-only assistant Markdown footnotes; rewriting finalized messages would mutate conversation content instead of just rendering links

Repo surfaces:
- `extensions/context-health.ts`
- `extensions/notify.ts`
- `scripts/test-context-health.ts`
- `scripts/test-notify.ts`

## Suggested Rechecks For Future Pi Upgrades

If this repo upgrades Pi beyond `0.75.3`, re-check these areas first:
- package scope and install layout, especially any hardcoded global package paths
- `context-files` against both Markdown and XML project-context prompt boundaries
- `file-footnotes` against assistant Markdown, OSC prompt markers, hyperlinks, inline images, and `/reload`
- `structured-compaction` against OpenAI Codex Responses transport, session ids, cache affinity, internal converter paths, and `/responses/compact` payload shape
- new provider/model IDs against `defaults/model-system-prompts/**`

## Current Recommendation

Pi `0.75.3` is now the validated baseline for this repo.

The main remaining compatibility risk is `structured-compaction` because it still depends on an internal `openai-responses-shared.js` converter path and live OpenAI/Codex compaction semantics.

## Historical 0.67.x Review

Historical note: this section is retained for context only. The current validated baseline is Pi `0.75.3`.

The `0.67.0` through `0.67.6` changelog gap was reviewed and revalidated on `2026-04-17`.
This note keeps the repo-facing changes visible even though the active baseline has now moved past `0.67.6`.

Source used for this review:
- upstream `packages/coding-agent/CHANGELOG.md`
- validated against local Pi install `0.67.6`

## Adopted 0.67.x Changes

### Assistant Markdown And File Links

Relevant versions:
- `0.67.6`

What changed upstream:
- assistant markdown links now render as OSC 8 hyperlinks when the terminal advertises support
- hyperlink detection is stricter and disables OSC 8 on unknown terminals and under tmux/screen

What this repo now does with that:
- `extensions/file-footnotes.ts` still customizes file links into numbered footnotes
- non-file links now fall back to Pi core markdown rendering instead of being reimplemented locally
- file-footnote hyperlinks now follow Pi's terminal hyperlink capability detection instead of emitting OSC 8 unconditionally

Why it still matters:
- `file-footnotes` still monkey-patches assistant markdown rendering for file links, collapse state, and redraw behavior
- that remains the highest maintenance-risk area if Pi changes assistant-message internals again
- `/reload` is still less trustworthy than a full restart for this extension because the patch touches prototype/global state

Repo surfaces:
- `extensions/file-footnotes.ts`
- `scripts/test-file-footnotes.ts`

### Context File Discovery

Relevant versions:
- `0.67.4`

What changed upstream:
- `loadProjectContextFiles()` is now exported as a standalone utility
- `--no-context-files` / `-nc` disables AGENTS.md / CLAUDE.md discovery

What this repo now does with that:
- `extensions/context-files.ts` now uses `loadProjectContextFiles()` instead of manually walking AGENTS.md / CLAUDE.md files
- `scripts/test-context-files.ts` now validates the core discovery order across global, ancestor, and project files

Why it matters:
- the extension's toggle UI now tracks Pi core discovery behavior more closely
- future Pi discovery-rule changes should be easier to inherit instead of reimplement
- `--no-context-files` remains useful when isolating Pi-core context injection from extension behavior during debugging

Repo surfaces:
- `extensions/context-files.ts`
- `scripts/test-context-files.ts`

### Provider Response Diagnostics

Relevant versions:
- `0.67.6`
- `0.67.4`

What changed upstream:
- new `after_provider_response` extension hook exposes HTTP status codes and headers after provider responses

What this repo now does with that:
- `extensions/context-health.ts` records the latest provider status and selected response headers via `after_provider_response`
- the extra provider diagnostics stay hidden by default
- set `PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG=1` to append them to `/context-health`

Why it matters:
- this gives a low-noise path for debugging rate limits, request ids, and cache-adjacent behavior without patching Pi internals
- normal `context-health` output stays unchanged unless the explicit debug flag is enabled

Repo surfaces:
- `extensions/context-health.ts`
- `scripts/test-context-health.ts`

### OpenAI Codex / Responses / Prompt Caching

Relevant versions:
- `0.67.6`
- `0.67.2`
- `0.67.1`

What changed upstream:
- prompt caching was fixed for non-default OpenAI-compatible base URLs by always sending `session_id` and `x-client-request-id` when a session id is present
- OpenAI Responses / Codex SSE requests now align `prompt_cache_key`, `session_id`, and `x-client-request-id` more consistently for cache affinity
- OpenAI Codex Responses requests now forward configured `serviceTier`
- new session ids use UUIDv7

Why it matters here:
- `structured-compaction` depends heavily on OpenAI / Codex Responses semantics, session ids, and cache affinity
- `context-health` reads cache-related usage and benefits when core caching semantics are more stable
- these changes are especially relevant for `openai-codex` users and for any future proxy / custom `baseUrl` setups

Repo surfaces:
- `extensions/structured-compaction/index.ts`
- `extensions/structured-compaction/responses-adapter.ts`
- `extensions/context-health.ts`
- `defaults/structured-compaction/README.md`

## Still Useful 0.67.x Options

### `--no-context-files`

Version:
- `0.67.4`

Useful here for:
- clean runs when testing `context-files`
- separating Pi-core AGENTS/CLAUDE loading from extension-side prompt filtering

### Multiple `--append-system-prompt` Flags

Version:
- `0.67.2`

Useful here for:
- quick prompt experiments before changing `model-system-prompt`
- temporary A/B checks without editing seeded runtime files

## Suggested Rechecks For Future Pi Upgrades

If this repo upgrades Pi beyond `0.67.6`, re-check these areas first:
- `file-footnotes` against assistant markdown and hyperlink behavior, especially under tmux/screen and across `/reload`
- `context-files` if Pi changes context-file discovery rules again
- `structured-compaction` and `context-health` on `openai-codex` for cache/session-id behavior
- package install/update flows for the local and git package paths this repo relies on

## Historical 0.67.x Recommendation

At the time of the archived 0.67.x review, Pi `0.67.6` was the validated baseline for this repo.

The main remaining compatibility risk is still `file-footnotes`, not because non-file links drift from Pi core anymore, but because the extension still patches assistant-message rendering to add file-only footnotes and collapse behavior.

## Reviewed 0.68.0 through 0.75.3 Changes

Source used for this review:
- upstream changelog entries through Pi `0.75.3`
- local Pi package docs and installed package source under `@earendil-works/pi-coding-agent`

### Package Scope Migration

Relevant versions:
- `0.74.0`
- `0.73.1`

What changed upstream:
- Pi packages moved from `@mariozechner/*` to `@earendil-works/*`.

What this repo changed:
- package peer dependencies and extension imports now use `@earendil-works/*`.
- README install instructions now use `@earendil-works/pi-coding-agent`.

Repo surfaces:
- `package.json`
- `extensions/**`
- `scripts/**`
- `README.md`

### Project Context XML Boundaries

Relevant version:
- `0.75.0`

What changed upstream:
- Pi project-context boundaries can use explicit XML tags instead of only Markdown headings.

What this repo changed:
- `context-files` now supports both the older Markdown `# Project Context` section and the newer `<project_context>` section.
- filtering now receives `event.systemPromptOptions.contextFiles` during `before_agent_start` so it tracks Pi's loaded context files directly.

Repo surfaces:
- `extensions/context-files.ts`
- `scripts/test-context-files.ts`

### Structured Compaction Internal Path Removal

Relevant versions:
- `0.74.0`
- `0.75.0`

What changed upstream:
- package scopes and install layouts changed, including user-scoped npm package locations.

What this repo changed:
- `structured-compaction` no longer hardcodes the old Homebrew/global `@mariozechner/pi-coding-agent` path to reach OpenAI Responses conversion internals.
- it now resolves the exported `@earendil-works/pi-ai/openai-responses` module and imports the sibling shared conversion module from there.

Repo surfaces:
- `extensions/structured-compaction/responses-adapter.ts`

### Still Needs Runtime Revalidation

- `file-footnotes` still monkey-patches `@earendil-works/pi-tui` Markdown internals and should be smoke-tested after TUI markdown rendering changes in `0.74.1`.
- `structured-compaction` `codex-remote` should be tested against the current OpenAI Codex model list and compact endpoint behavior.

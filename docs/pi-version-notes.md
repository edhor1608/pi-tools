# Pi Version Notes

This repo is currently developed and validated against Pi `0.75.5`.

The `0.67.6` through `0.75.5` changelog gap was reviewed on `2026-05-25`.

Source used for this review:
- installed `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`
- installed Pi package `@earendil-works/pi-coding-agent` version `0.75.5`
- Pi CLI was not on this shell's `PATH`, so `pi --version` could not be used

## Adopted 0.68.x - 0.75.x Changes

### Package Scope Migration

Relevant versions:
- `0.73.1`
- `0.74.0`
- `0.75.5`

What changed upstream:
- Pi package references moved from `@mariozechner/*` to `@earendil-works/*`
- package docs now require bundled Pi packages to be listed as `@earendil-works/*` peer dependencies
- installed package docs and internals live under `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`

What this repo now does with that:
- source imports now use `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, and `@earendil-works/pi-agent-core`
- `package.json` peer dependencies now use the new scope
- install docs now point at `@earendil-works/pi-coding-agent`
- `structured-compaction` now resolves the installed OpenAI Responses helper from the new package path

Why it matters:
- a fresh Pi `0.75.5` install only exposes the new package scope
- leaving old imports would make extension loading and local smoke scripts fail before runtime behavior can be tested

Repo surfaces:
- `package.json`
- `README.md`
- `extensions/**`
- `scripts/**`

### Context Prompt XML Boundaries

Relevant versions:
- `0.75.0`
- `0.75.4`

What changed upstream:
- Pi changed system prompt and context file boundaries from Markdown headings toward explicit XML tags

What this repo now does with that:
- no code change yet beyond scope migration
- `context-files` still filters by rebuilding the exact context section generated from Pi's exported `loadProjectContextFiles()`

Why it still matters:
- `context-files` keeps fallback markers for `# Project Context`, `The following skills`, and `Current date:`
- if Pi's emitted section no longer exactly matches the rebuilt section, disabled context files may stop being removed

Repo surfaces:
- `extensions/context-files.ts`
- `scripts/test-context-files.ts`

Required follow-up:
- smoke test `/context-files` in a real Pi `0.75.5` session with one disabled AGENTS.md

### Assistant Markdown, TUI, And Theme Changes

Relevant versions:
- `0.71.0`
- `0.74.1`
- `0.75.4`
- `0.75.5`

What changed upstream:
- TUI markdown gained list indentation, task-list checkbox rendering, large-markdown robustness, inline image fixes, and theme initialization fixes across package scopes

What this repo now does with that:
- `file-footnotes` still monkey-patches assistant markdown rendering for file-link footnotes
- imports now use the same package scope as Pi core, reducing cross-scope theme failures

Why it still matters:
- the extension depends on Pi's internal assistant-message component path and Markdown behavior
- this remains a smoke-test-required area on every Pi upgrade

Repo surfaces:
- `extensions/file-footnotes.ts`
- `scripts/test-file-footnotes.ts`

### Structured Compaction And Provider Changes

Relevant versions:
- `0.70.0`
- `0.71.1`
- `0.72.0`
- `0.73.0`
- `0.75.0`
- `0.75.4`

What changed upstream:
- OpenAI Codex added `gpt-5.5`, WebSocket cached transport, current model metadata, and transport fixes
- compaction summary calls now preserve proxy-backed LLM routing and clamp output tokens to model limits
- model metadata moved from `compat.reasoningEffortMap` to model-level `thinkingLevelMap`
- provider retry, timeout, cache-affinity, and prompt-cache behavior changed across OpenAI-compatible providers

What this repo now does with that:
- `structured-compaction` keeps its existing OpenAI/Codex remote compaction path
- the internal OpenAI Responses helper import path was moved to the installed `@earendil-works` package layout

Why it still matters:
- `structured-compaction` still relies on undocumented installed internals under `node_modules/@earendil-works/pi-ai/dist/providers/openai-responses-shared.js`
- Codex transport and metadata changes need live validation before claiming remote compaction compatibility

Repo surfaces:
- `extensions/structured-compaction/**`
- `defaults/structured-compaction/README.md`
- `defaults/model-system-prompts/**`
- `extensions/context-health.ts`

### Useful New Extension APIs

Relevant versions:
- `0.68.0`
- `0.69.0`
- `0.70.3`
- `0.71.0`

New APIs worth considering:
- `before_agent_start.systemPromptOptions` can simplify `context-files` by inspecting structured prompt inputs instead of parsing rendered prompt text
- `ctx.ui.setWorkingIndicator()` and `ctx.ui.setWorkingVisible()` can simplify or replace parts of `notify`
- `message_end` replacement support could offer a cleaner future path for assistant-message transformations than prototype patching, if it can preserve streaming/rendering behavior
- `thinking_level_select` could let `context-health` reflect thinking changes immediately
- `ctx.ui.addAutocompleteProvider()` could improve `/stash` item selection or future context-file path UX

No direct code change was made for these APIs in this review because the package-scope migration was the only required compatibility fix.

The `0.67.0` through `0.67.6` changelog gap was reviewed and revalidated on `2026-04-17`.
This note keeps the older repo-facing changes visible even though the active baseline has now moved to `0.75.5`.

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

If this repo upgrades Pi beyond `0.75.5`, re-check these areas first:
- `file-footnotes` against assistant markdown and hyperlink behavior, especially under tmux/screen and across `/reload`
- `context-files` if Pi changes context-file discovery rules again
- `structured-compaction` and `context-health` on `openai-codex` for cache/session-id behavior
- package install/update flows for the local and git package paths this repo relies on

## Current Recommendation

Pi `0.75.5` is now the reviewed baseline for this repo, with the manual smoke tests above still recommended before calling the TUI-sensitive extensions fully validated.

The main remaining compatibility risk is still `file-footnotes`, not because non-file links drift from Pi core anymore, but because the extension still patches assistant-message rendering to add file-only footnotes and collapse behavior.

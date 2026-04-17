# Pi Version Notes

This repo is currently developed and validated against Pi `0.67.6`.

The `0.67.0` through `0.67.6` changelog gap was reviewed and revalidated on `2026-04-17`.
This note keeps the repo-facing changes visible even though the active baseline has now moved to `0.67.6`.

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

## Current Recommendation

Pi `0.67.6` is now a validated baseline for this repo.

The main remaining compatibility risk is still `file-footnotes`, not because non-file links drift from Pi core anymore, but because the extension still patches assistant-message rendering to add file-only footnotes and collapse behavior.

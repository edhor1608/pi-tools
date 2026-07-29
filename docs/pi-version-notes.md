# Pi Version Notes

This repo is currently developed and validated against Pi `0.82.1`.

Sources used for the current review:
- installed Pi `CHANGELOG.md`, public declarations, docs, and extension examples
- OpenAI SDK `6.26.0` compact-response declarations bundled with Pi
- local Pi `0.82.1` typecheck and extension loading
- live `openai-codex/gpt-5.6-sol` compact-endpoint canary

## Adopted 0.82.x Changes

### Package And Runtime APIs

- all package imports use the `@earendil-works/*` scope introduced after `0.73.x`
- `complete()` comes from the temporary `@earendil-works/pi-ai/compat` entrypoint
- model auth uses `getApiKeyAndHeaders()`, including provider-scoped `env` for summary calls
- the package is typechecked against Pi `>=0.82.1 <0.83.0`

### Structured Compaction

- the Responses converter now comes from the public `@earendil-works/pi-ai/api/openai-responses-shared` export
- remote compact requests use the official compact body and current Codex `session-id` and `x-client-request-id` headers
- local summary usage and estimated post-compaction tokens are returned to Pi
- remote endpoint usage, trigger reason, retry state, and automatic-fallback reason are persisted
- `/compaction-report` uses a display-only custom entry so reports do not enter model context

### File Footnotes

- the private assistant-renderer monkey patch was removed
- finalized assistant messages are transformed with the public `message_end` replacement API
- persisted footnotes are visible after resume/export and no longer depend on TUI prototype state or `/reload`

### Stash

- stash uses current extension/TUI types and one `ExtensionContext` surface for command and shortcut UI flows
- the existing release-order test passes unchanged

## Historical 0.67.x Changes

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

If this repo upgrades Pi beyond `0.82.1`, re-check these areas first:
- `message_end` replacement and persisted markdown behavior for `file-footnotes`
- `structured-compaction` against Responses conversion, compact schemas, Codex headers, and WebSocket continuation
- the temporary `pi-ai/compat` import before that compatibility entrypoint is removed
- `context-files` if Pi changes context-file discovery rules again
- package install/update flows for local and git package paths

## Current Recommendation

Pi `0.82.1` is the validated baseline for this repo.

The highest remaining compatibility risk is the provider-native compaction boundary. It is covered by a mocked contract test and a live GPT-5.6 Codex canary, but provider payload contracts can change independently of Pi.

# Pi Version Notes

This repo is currently runtime-validated against local Pi `0.67.68`.

The `0.68.0` through `0.69.0` changelog gap was reviewed on `2026-04-23`.
This note records the repo-impact changes from that review and keeps the remaining upgrade risks explicit.

Source used for this review:
- upstream `packages/coding-agent/CHANGELOG.md`
- local installed Pi `0.67.68`
- published `@mariozechner/pi-coding-agent@0.69.0` and `@mariozechner/pi-ai@0.69.0` tarballs

## Applied Repo-Impact Fixes

### Structured Compaction Private Path Resolution

What changed in this repo:
- `extensions/structured-compaction/responses-adapter.ts` no longer hardcodes `/opt/homebrew/lib/node_modules/...`
- the adapter now resolves installed `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` package roots via `import.meta.resolve(...)`
- the private `openai-responses-shared.js` path and Pi package version are now derived relative to those installed package roots

Why it matters:
- the previous code only worked on one machine layout
- this repo still depends on Pi private internals for structured compaction, but it no longer assumes a Homebrew global install on Apple Silicon
- global npm installs, project installs, and other Node wrapper layouts are now much less likely to break on path alone

Repo surfaces:
- `extensions/structured-compaction/responses-adapter.ts`
- `scripts/test-structured-compaction-paths.ts`

### Baseline Documentation

What changed in this repo:
- repo docs now distinguish the local runtime-validated baseline from the newer reviewed upstream versions
- the stale `0.67.6` baseline text was updated to the actual local installed version `0.67.68`

Why it matters:
- the repo should say what was actually tested, not just what was last remembered
- this keeps future upgrade work honest about what is reviewed versus what is runtime-proven

Repo surfaces:
- `README.md`
- `docs/pi-version-notes.md`

### Context Files Now Prefer Pi's Structured Prompt Inputs

What changed in this repo:
- `extensions/context-files.ts` now prefers `event.systemPromptOptions.contextFiles` during `before_agent_start`
- `loadProjectContextFiles()` remains as a compatibility fallback for older Pi versions and for the standalone toggle UI

Why it matters:
- prompt filtering now follows the exact context-file list Pi already built for the current turn when that newer API is available
- this reduces drift from Pi core discovery and respects non-discovery context-file sources more accurately

Repo surfaces:
- `extensions/context-files.ts`
- `scripts/test-context-files.ts`

### Notify Now Uses Pi's Native Working Indicator When Available

What changed in this repo:
- `extensions/notify.ts` now calls `ctx.ui.setWorkingIndicator()` when that API is available
- the indicator is restored to Pi's default when idle
- the existing title spinner and terminal notifications stay in place

Why it matters:
- newer Pi versions now show native in-app active-work feedback without removing the older notify behavior
- older Pi versions keep working because the new call is guarded and optional

Repo surfaces:
- `extensions/notify.ts`
- `scripts/test-notify.ts`

## Relevant 0.67.x Changes Already Adopted

### Assistant Markdown And File Links

Relevant versions:
- `0.67.6`

What changed upstream:
- assistant markdown links now render as OSC 8 hyperlinks when the terminal advertises support
- hyperlink detection is stricter and disables OSC 8 on unknown terminals and under tmux/screen

What this repo already does with that:
- `extensions/file-footnotes.ts` still customizes file links into numbered footnotes
- non-file links fall back to Pi core markdown rendering instead of being reimplemented locally
- file-footnote hyperlinks follow Pi's terminal hyperlink capability detection instead of emitting OSC 8 unconditionally

Why it still matters:
- `file-footnotes` still monkey-patches assistant markdown rendering for file links, collapse state, and redraw behavior
- that remains the highest maintenance-risk area if Pi changes assistant-message internals again

Repo surfaces:
- `extensions/file-footnotes.ts`
- `scripts/test-file-footnotes.ts`

### Context File Discovery

Relevant versions:
- `0.67.4`

What changed upstream:
- `loadProjectContextFiles()` is exported as a standalone utility
- `--no-context-files` / `-nc` disables AGENTS.md / CLAUDE.md discovery

What this repo already does with that:
- `extensions/context-files.ts` uses `loadProjectContextFiles()` instead of manually walking AGENTS.md / CLAUDE.md files
- `scripts/test-context-files.ts` validates the core discovery order across global, ancestor, and project files

Why it matters:
- the extension's toggle UI tracks Pi core discovery behavior more closely
- future Pi discovery-rule changes should be easier to inherit instead of reimplement

Repo surfaces:
- `extensions/context-files.ts`
- `scripts/test-context-files.ts`

### Provider Response Diagnostics

Relevant versions:
- `0.67.6`
- `0.67.4`

What changed upstream:
- `after_provider_response` exposes HTTP status codes and headers after provider responses

What this repo already does with that:
- `extensions/context-health.ts` records the latest provider status and selected response headers via `after_provider_response`
- the extra provider diagnostics stay hidden by default
- set `PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG=1` to append them to `/context-health`

Repo surfaces:
- `extensions/context-health.ts`
- `scripts/test-context-health.ts`

## Reviewed 0.68.0 -> 0.69.0 Changes

### Explicit `cwd` / `agentDir` Resource Helpers

Relevant versions:
- `0.68.0`

What changed upstream:
- public resource helpers no longer fall back to ambient `process.cwd()` and now require explicit inputs

Impact here:
- no code change required beyond what was already in place
- `extensions/context-files.ts` already calls `loadProjectContextFiles({ cwd, agentDir })` explicitly

### SDK Tool Selection Breaks

Relevant versions:
- `0.68.0`

What changed upstream:
- SDK `createAgentSession({ tools })` now uses tool-name allowlists instead of prebuilt tool objects
- prebuilt exports like `readTool`, `bashTool`, `codingTools`, and `readOnlyTools` were removed

Impact here:
- no repo change required
- this package does not use the SDK tool-selection surface internally

### `systemPromptOptions` And Working Indicator

Relevant versions:
- `0.68.0`

What changed upstream:
- `before_agent_start` now exposes structured `systemPromptOptions`
- extensions can customize the streaming working indicator via `ctx.ui.setWorkingIndicator()`

Impact here:
- no required migration
- these are good future simplifications for `context-files` and `notify`, but they were not needed for the current compatibility pass

### Session-Replacement Invalidation

Relevant versions:
- `0.69.0`

What changed upstream:
- old `pi` and command `ctx` references become stale after `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()`
- post-switch work must move into `withSession`

Impact here:
- no repo change required
- this package does not currently call `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()`

### TypeBox 1.x Migration

Relevant versions:
- `0.69.0`

What changed upstream:
- new extensions and SDK integrations should import from `typebox`
- `@sinclair/typebox/compiler` is no longer shimmed

Impact here:
- no repo change required today
- this package currently does not define custom tool schemas
- if custom tools are added later, they should use `typebox` and list it in `peerDependencies`

### Private Internal Surfaces Still Present In 0.69.0

What was checked:
- published `0.69.0` tarballs still include the private files this repo currently depends on
- that includes the interactive assistant-message renderer used by `file-footnotes`
- that also includes `pi-ai`'s `openai-responses-shared.js` used by structured compaction

Why it matters:
- there is no confirmed `0.69.0` blocker from private-file removal
- the risk remains maintenance drift, not immediate absence

## Suggested Rechecks For The Next Pi Upgrade

Re-check these areas first:
- `file-footnotes` against assistant markdown and interactive renderer internals
- `structured-compaction` against private OpenAI/Codex request-shaping internals
- `context-files` if Pi changes context-file discovery or if we later switch it to `systemPromptOptions.contextFiles`
- `notify` if Pi's built-in working/progress indicators make the title spinner redundant or conflicting

## Current Recommendation

Current state:
- runtime-validated baseline: `0.67.68`
- changelog reviewed through: `0.69.0`
- repo-impact fixes from that review: applied

There is no confirmed blocker to upgrading from the perspective of this package.

The main remaining compatibility risks are still:
- `file-footnotes`, because it patches private interactive rendering internals
- `structured-compaction`, because it still relies on private Pi / pi-ai internals even though the install-path assumption is now removed

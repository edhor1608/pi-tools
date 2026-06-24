# Pi Version Notes

This repo was reviewed for Pi `0.79.10` compatibility.

The `0.67.7` through `0.79.10` changelog range was reviewed on `2026-06-22`.

Source used for this review:
- installed Pi package `@earendil-works/pi-coding-agent@0.75.5` under `/opt/homebrew/lib/node_modules`
- npm package `@earendil-works/pi-coding-agent@0.79.10` changelog
- installed docs for extensions, packages, models, custom providers, TUI, sessions, settings, and compaction

Focused tests were run with the active local package resolver, so this note treats `0.79.10` as the reviewed target rather than a pinned runtime.

## Adopted 0.74.x - 0.79.x Changes

### Package Scope Migration

Relevant versions:
- `0.74.0`
- `0.73.1`

What changed upstream:
- Pi moved package references to `@earendil-works/*`.
- `pi update --self` learned to migrate the global CLI package name.

What this repo now does with that:
- runtime imports, peer dependencies, test imports, and README install commands use `@earendil-works/*`.
- structured-compaction internal helper imports now resolve through the active package layout instead of a hardcoded Homebrew global path.

Repo surfaces:
- `package.json`
- `README.md`
- `extensions/**`
- `scripts/**`

### XML System Prompt Context Boundaries

Relevant versions:
- `0.75.0`
- `0.75.4`

What changed upstream:
- Pi changed default system prompt/context file boundaries from Markdown headings to explicit XML tags.

What this repo now does with that:
- `extensions/context-files.ts` filters the current `<project_context>` block and keeps the old `# Project Context` fallback for older prompt shapes.
- `scripts/test-context-files.ts` validates the XML context section with Pi's current `buildSystemPrompt()` output.

Repo surfaces:
- `extensions/context-files.ts`
- `scripts/test-context-files.ts`

### Extension And Compaction Event Additions

Relevant versions:
- `0.78.1`
- `0.79.10`

What changed upstream:
- extension contexts now expose `ctx.mode` and `ctx.getSystemPromptOptions()`.
- `session_before_compact` and `session_compact` events now include `reason` and `willRetry`.

What this repo does with that now:
- no required code change; existing handlers remain compatible.

Useful follow-up:
- `structured-compaction` can optionally use `reason` and `willRetry` to distinguish manual compaction from overflow retry compaction in reports and metrics.
- `model-system-prompt` and `context-files` can optionally use `ctx.getSystemPromptOptions()` for diagnostics instead of parsing prompt text.

### Project Trust

Relevant versions:
- `0.79.0`
- `0.79.1`

What changed upstream:
- Pi now gates project-local settings, resources, instructions, and packages behind project trust.
- extensions can inspect trust via `ctx.isProjectTrusted()` and global/CLI extensions can participate through `project_trust`.

What this repo does with that now:
- no required code change for installed trusted package use.

Risk:
- project-local installs or `.pi/context-files.json` changes may depend on the user accepting project trust first.

### Markdown, TUI, And Hyperlink Rendering

Relevant versions:
- `0.74.1`
- `0.78.0`
- `0.79.2`
- `0.79.9`

What changed upstream:
- Pi TUI markdown rendering, loose lists, code-fence streaming, OSC 8 file links, inline images, overlays, theme handling, and CJK wrapping changed across the range.

What this repo does with that now:
- `file-footnotes` still patches Pi's assistant markdown renderer for file links only.
- tests cover current visible output, but a real interactive smoke test is still required because this extension depends on internal renderer details.

Repo surfaces:
- `extensions/file-footnotes.ts`
- `scripts/test-file-footnotes.ts`

### Provider, Model, And Prompt Cache Changes

Relevant versions:
- `0.72.0` through `0.79.10`

What changed upstream:
- `thinkingLevelMap` replaced `reasoningEffortMap` for custom provider metadata.
- multiple provider/model metadata updates landed, including OpenAI/OpenAI Codex GPT-5.4/GPT-5.5 context windows, OpenCode/Kimi, GLM, Claude Fable 5, Mistral caching, Together AI, NVIDIA NIM, Ant Ling, OpenRouter Fusion, and Xiaomi provider changes.
- prompt/cache/session behavior changed for several providers.

What this repo does with that now:
- no custom provider definitions use `reasoningEffortMap`, so no migration is needed.
- `structured-compaction` remains high-risk for OpenAI/Codex Responses because it imports an internal `openai-responses-shared.js` helper and calls remote compact endpoints directly.

Repo surfaces:
- `extensions/structured-compaction/**`
- `defaults/model-system-prompts/**`
- `defaults/structured-compaction/README.md`
- `extensions/context-health.ts`

## Still Useful 0.79.x Options

### `CONFIG_DIR_NAME`

Version:
- `0.79.7`

Potential use here:
- replace hardcoded `.pi` in `context-files` with Pi's exported project config directory constant.

Current recommendation:
- optional cleanup only; keeping `.pi` is compatible with current Pi defaults.

### Compaction `reason` / `willRetry`

Version:
- `0.79.10`

Potential use here:
- improve structured-compaction reports and avoid treating overflow retry compactions the same as manual `/compact` runs.

Current recommendation:
- optional improvement after a live structured-compaction smoke test.

## Suggested Rechecks For Future Pi Upgrades

Re-check these areas first:
- `file-footnotes` against assistant markdown internals, OSC 8 file links, streaming code fences, themes, and `/reload`
- `context-files` if Pi changes `<project_context>` or context-file XML formatting again
- `structured-compaction` against OpenAI/Codex Responses payload conversion, remote compact endpoints, session ids, prompt cache keys, and `before_provider_request`
- `context-health` against provider usage/cached-token accounting and Pi's native footer cache-hit display
- package install/update behavior for git and npm package specs

## Current Recommendation

Pi `0.79.10` is the reviewed target for this repo.

A small compatibility patch is required for this worktree: migrate package scopes to `@earendil-works/*` and support Pi's XML system prompt context boundaries. The main remaining manual validation risk is `file-footnotes` renderer patching and authenticated `structured-compaction` on OpenAI Codex Responses.

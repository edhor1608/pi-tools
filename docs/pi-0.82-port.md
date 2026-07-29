# Pi 0.82 Port

## Problem

Structured compaction, file footnotes, and stash were built against Pi `0.73.x` packages and older private runtime surfaces. The active installation is Pi `0.82.1`.

## What changed

- Migrated package imports and peers to `@earendil-works/*`.
- Replaced file-footnote TUI prototype patches with `message_end` message replacement.
- Replaced structured-compaction absolute imports with public exports.
- Updated Codex compact headers/body and propagated summary usage, token estimates, trigger metadata, and fallback diagnostics.
- Kept stash behavior while aligning shared UI helper types with current contexts.
- Moved compaction reports to display-only custom entries.
- Removed context-health, context-files, model-system-prompt, and notify from the package.

## Verification

Passed:

- `bun run typecheck`
- `bun run test:file-footnotes`
- `bun run test:stash-release`
- `bun run test:structured-compaction`
- `bun run test:packaged-defaults-fallback`
- import of all three extension modules
- isolated Pi `0.82.1` load of all package extensions
- live `openai-codex/gpt-5.6-sol` compact canary; output contained `message` and `compaction_summary` items plus usage

## What did not work

A mechanical scope replacement alone also failed typecheck because `complete()` moved to `pi-ai/compat`, assistant-message unions narrowed, stash command/shortcut contexts diverged, and the old Responses converter path was no longer valid.

A static import of the new public Responses-converter subpath passed typecheck and explicit `-e` loading, but failed when Pi loaded the extension as a managed package: the host alias expanded the subpath after `compat.js`. The extension now resolves that same public package export with `createRequire(import.meta.url).resolve()` before dynamically importing its file URL. `pi list` is the regression check for this package-loader-only path.

## Remaining risks

- `pi-ai/compat` is explicitly temporary.
- The ChatGPT Codex compact endpoint is provider-owned and can change independently of Pi.
- The live canary verifies the endpoint contract, not a full multi-turn compaction/reinjection session.

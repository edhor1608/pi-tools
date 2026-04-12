# Structured Compaction

This directory configures the `structured-compaction` extension from `@stead/pi-tools`.

## What it does

The extension also registers `/compaction-report`, which posts the latest compaction report for the current branch into the chat.

The extension keeps Pi's native compaction trigger and storage model, but replaces the single built-in compaction summary with a versioned `structured-replacement-history` artifact stored in `CompactionEntry.details`.

At compaction time it:
- prepares a backend input from Pi's `session_before_compact` event
- runs a swappable compaction backend
- renders the backend output into `replacementMessages`
- stores those `replacementMessages` in `details`
- optionally stores raw remote OpenAI/Codex compaction output as `remoteReplacement`

At request time it:
- reads the latest compaction artifact from the current branch
- intercepts Pi's `context` event to replace Pi's emitted `compactionSummary` message with the artifact's `replacementMessages`
- intercepts `before_provider_request` for compatible OpenAI/Codex responses payloads and swaps the local summary prefix for the persisted remote replacement items

That means the persisted artifact, not Pi's default summary message, becomes the source of truth for the compacted history shape.

## Backends

### `auto`

Default mode.

Behavior:
- if the active model is compatible with remote OpenAI/Codex compaction and auth is compatible, try `codex-remote`
- otherwise fall back to `pi-model`
- if remote compaction fails, fall back to `pi-model`

### `pi-model`

Local summary-only backend. This is the old behavior from the first version of the extension.

### `codex-remote`

Runs two things:
- a local summary model call for Pi-readable replacement messages
- a remote OpenAI/Codex compaction request whose raw output is persisted for later OpenAI/Codex `/responses` requests

## Files

- `config.json`: backend and renderer settings
- `prompts/system.md`: system prompt for the local summary worker
- `prompts/compact.md`: user prompt template for the local summary worker

For reports:
- use `/compaction-report` inside Pi for the latest compaction on the current branch
- use `bun ./scripts/analyze-session.ts <session.jsonl>` from the package repo for offline session analysis

## Config

`backend.model` accepts `provider/model` and controls the local summary worker model. If it is `null`, the extension uses the active Pi model.

Examples:

```json
{
  "backend": {
    "kind": "auto",
    "model": "openai-codex/gpt-5.4",
    "fallbackToActiveModel": true,
    "maxTokens": 8192,
    "reasoning": "high",
    "remote": {
      "endpointMode": "auto",
      "originator": "pi"
    }
  }
}
```

`backend.remote.endpointMode`:
- `auto`: use `/responses/compact` for `openai-responses`, `/codex/responses/compact` for `openai-codex-responses`
- `responses`: force `/responses/compact`
- `codex-responses`: force `/codex/responses/compact`

Project-local overrides live under:
- `.pi/structured-compaction/config.json`
- `.pi/structured-compaction/prompts/system.md`
- `.pi/structured-compaction/prompts/compact.md`

Project-local prompt files override global ones.

## Live findings

A live probe against `openai-codex/gpt-5.4` confirmed:
- `https://chatgpt.com/backend-api/codex/responses/compact` works with Pi's stored Codex OAuth auth
- the compact endpoint currently returns `compaction_summary` output items
- the compact endpoint rejects `stream` in the request body
- follow-up `https://chatgpt.com/backend-api/codex/responses` calls require `stream: true`
- follow-up calls accepted both the raw returned `compaction_summary` item and a normalized `type: "compaction"` item with the same encrypted payload
- a real multi-turn `pi -p` session also verified the full wiring: Pi wrote a `codex-remote` compaction artifact and the next outbound provider payload carried the persisted `compaction_summary` item
- a real continuity test also succeeded: a coding task begun before compaction continued after compaction, the session-only codename survived post-compaction, and the finished project still passed its tests
- the compaction block shown in Pi now starts with a short stats header: backend, before tokens, after heuristic tokens, saved tokens, and message-count reduction

## Current abstractions

- backend interface: `auto`, `pi-model`, `codex-remote`
- renderer interface: `compaction-summary` and `custom-message`
- artifact schema: `structured-replacement-history` version `1`
- remote replacement artifact: `responses-compact`

The intended upgrade path is to add new backends later, such as an external compaction worker or a Codex-compatible sidecar, without changing how the extension rewrites context from persisted artifacts.

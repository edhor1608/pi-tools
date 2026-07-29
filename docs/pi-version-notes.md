# Pi Version Notes

This repo is developed and validated against Pi `0.82.1`.

Sources used for the current port:

- installed Pi changelog, declarations, documentation, and examples
- OpenAI SDK `6.26.0` compact-response declarations bundled with Pi
- package typecheck and managed-extension loading
- live `openai-codex/gpt-5.6-sol` compact-endpoint canary

## Package Runtime

- imports and peer dependencies use `@earendil-works/*`
- supported Pi range is `>=0.82.1 <0.83.0`
- all extension source is covered by strict TypeScript checking
- `complete()` currently comes from the temporary `@earendil-works/pi-ai/compat` entrypoint

## Structured Compaction

- model auth uses `getApiKeyAndHeaders()`, including provider-scoped `env` for summary calls
- Responses conversion uses the public `@earendil-works/pi-ai/api/openai-responses-shared` export
- the managed-package loader requires resolving that subpath through `createRequire().resolve()` before dynamic import
- Codex compact requests use `session-id`, `x-client-request-id`, and the official compact body
- local summary usage and estimated post-compaction tokens are returned to Pi
- remote usage, trigger reason, retry state, and automatic-fallback reason are persisted
- `/compaction-report` writes a display-only entry and does not add diagnostics to model context

## File Footnotes

- finalized assistant messages are replaced through the public `message_end` API
- no Pi TUI classes or renderer prototypes are patched
- footnotes persist across resume and export

## Stash

- command and shortcut UI flows share the current `ExtensionContext` surface
- release behavior remains covered by the ready/question/error/queued state test

## Future Upgrade Checks

For a Pi upgrade beyond `0.82.1`, re-check:

- removal or replacement of `pi-ai/compat`
- managed-package resolution of the Responses converter
- Codex compact payload and header contracts
- WebSocket continuation after remote history replacement
- `message_end` replacement semantics

The highest remaining compatibility risk is the provider-native compaction boundary. It has mocked contract coverage and a live GPT-5.6 Codex canary, but the provider can change independently of Pi.

# pi-tools

One Pi package with two separate extensions:
- model-specific system prompt appending
- Codex-style structured compaction with remote OpenAI/Codex compaction, local fallback, metrics, and `/compaction-report`

No Pi core patches are required.

## Install

Local path:

```bash
pi install /Users/jonas/repos/pi-tools
```

Git:

```bash
pi install git:github.com/edhor1608/pi-tools
```

npm:

```bash
pi install npm:@stead/pi-tools
```

To try it without installing:

```bash
pi -e /Users/jonas/repos/pi-tools
```

## Resources

The package exposes two separate extensions, so users can enable or disable them independently in `pi config`:
- `extensions/model-system-prompt.ts`
- `extensions/structured-compaction/index.ts`

This is one package source, but the individual extension resources remain separately manageable.

## Runtime defaults

On first use, the extensions seed missing defaults into the same editable runtime paths used by the current manual setup:
- `~/.pi/agent/model-system-prompts/`
- `~/.pi/agent/structured-compaction/`

Existing files are never overwritten.

That gives you package-managed installation with user-editable runtime files.

Project-local overrides still work under:
- `.pi/model-system-prompts/`
- `.pi/structured-compaction/`

## What each extension does

### model-system-prompt

Appends model-specific prompt fragments to Pi's existing system prompt instead of replacing Pi's base prompt.

Seeded defaults currently include:
- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.3-codex`
- `openai-codex/gpt-5.3-codex-spark` as the current alias file
- `opencode-go/kimi-k2.5`

See `defaults/model-system-prompts/README.md`.

### structured-compaction

Adds structured replacement-history compaction with:
- `auto`, `pi-model`, and `codex-remote` backends
- persisted remote compaction artifacts
- reinjection of persisted compacted history into later compatible OpenAI/Codex Responses payloads
- compaction metrics in the TUI summary
- `/compaction-report`

See `defaults/structured-compaction/README.md`.

## Analyze a session

The repo includes a standalone analyzer:

```bash
bun ./scripts/analyze-session.ts ~/.pi/agent/sessions/.../session.jsonl
```

## Publish

To publish on npm as a scoped public package, use:

```bash
npm publish --access public
```

That will only work if you own or create the `@stead` npm scope.

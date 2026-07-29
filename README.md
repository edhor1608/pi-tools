# pi-tools

`pi-tools` is a focused Pi package with three independent extensions:

- `file-footnotes` keeps file-heavy assistant answers readable
- `stash` stores complete prompts for controlled later release
- `structured-compaction` preserves continuity in long sessions

The package is developed and validated against Pi `0.82.1`. See [docs/pi-version-notes.md](docs/pi-version-notes.md) for integration details.

## Install

Install Pi first if needed:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Install this package:

```bash
pi install git:github.com/edhor1608/pi-tools
```

A local checkout also works:

```bash
pi install /absolute/path/to/pi-tools
```

The three extensions are exposed separately and can be enabled or disabled through `pi config`.

## File Footnotes

Finalized assistant messages are transformed through Pi's public `message_end` hook:

- absolute file links become short labels with numbered links
- a visible `File references` list is appended to the same message
- web links, inline code, and fenced code remain unchanged
- footnotes persist across resumed and exported sessions

Use the command as a fallback opener:

```text
/file-footnotes
/file-footnotes open 1
/file-footnotes vscode 1
```

## Stash

Stash is a deferred-prompt lane. Waiting items stay outside model context until released.

Modes:

- `manual` — release explicitly
- `draft` — load into the editor when the agent is ready
- `send` — send automatically when the agent is ready

Examples:

```text
/stash add manual Review the final diff
/stash add draft Write the changelog
/stash add send Run the release checklist
/stash list
/stash apply 1
/stash send 1
```

Shortcuts:

- `Ctrl+Alt+S` stashes the current editor text
- `Ctrl+Shift+S` opens the stash UI

## Structured Compaction

Structured Compaction keeps Pi's native trigger and session storage while replacing the compacted span with a versioned artifact.

Backends:

- `auto` — try provider-native Codex/OpenAI compaction, then fall back locally
- `codex-remote` — require provider-native Responses compaction
- `pi-model` — summarize with a configured or active Pi model

Compatible remote output is persisted and reinjected into later Responses requests. A human-readable local summary remains available when the model or provider changes.

Runtime files are seeded under:

```text
~/.pi/agent/structured-compaction/config.json
~/.pi/agent/structured-compaction/prompts/system.md
~/.pi/agent/structured-compaction/prompts/compact.md
```

Project overrides use `.pi/structured-compaction/`.

Commands:

```text
/compaction-report latest
/compaction-report all
/trigger-compact
/trigger-compact preserve implementation decisions
```

Offline session analysis:

```bash
pnpm run analyze ~/.pi/agent/sessions/.../session.jsonl
```

More details: [defaults/structured-compaction/README.md](defaults/structured-compaction/README.md).

## Development

```bash
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` runs Oxfmt verification, Oxlint with type-aware linting and compiler diagnostics, and the Node test suite. TypeScript scripts run directly on Node 26.

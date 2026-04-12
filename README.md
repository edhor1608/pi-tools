# pi-tools

`pi-tools` is a Pi package with two separate extensions:
- model-specific system prompt appending
- structured compaction with local fallback, optional remote OpenAI/Codex compaction, continuity-preserving history reuse, metrics, and `/compaction-report`

No Pi core patches are required.

## What this package gives you

### `model-system-prompt`

Appends model-specific prompt fragments to Pi's existing system prompt instead of replacing Pi's base prompt.

Seeded defaults currently include:
- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.3-codex`
- `openai-codex/gpt-5.3-codex-spark`
- `opencode-go/kimi-k2.5`

### `structured-compaction`

Adds structured replacement-history compaction with:
- `auto`, `pi-model`, and `codex-remote` backends
- persisted remote compaction artifacts
- reinjection of persisted compacted history into later compatible OpenAI/Codex Responses payloads
- compaction metrics in the TUI summary
- `/compaction-report`

## If You Do Not Have Pi Yet

Pi is the terminal coding agent this package extends.

### 1. Install Pi

```bash
npm install -g @mariozechner/pi-coding-agent
```

### 2. Start Pi once

```bash
pi
```

Then authenticate in one of these ways:
- run `/login` inside Pi and choose a supported provider
- or export a supported API key, for example `OPENAI_API_KEY`, and start Pi again

If you want Pi's own docs, see:
- `https://github.com/badlogic/pi-mono/tree/main/packages/pi-coding-agent`
- `https://pi.dev`

## Install This Package

### Best current install path: git

This works now:

```bash
pi install git:github.com/edhor1608/pi-tools
```

### Try it without installing

This loads the package for one run only:

```bash
pi -e git:github.com/edhor1608/pi-tools
```

### Local path install

Useful while developing:

```bash
pi install /absolute/path/to/pi-tools
```

### npm install

The package name is reserved in this repo as:

```bash
pi install npm:@stead/pi-tools
```

Use that once the package has actually been published to npm.

## What Pi Loads

This package exposes two separate extension resources:
- `extensions/model-system-prompt.ts`
- `extensions/structured-compaction/index.ts`

That means users install one package source, but can still enable or disable the individual extensions with `pi config`.

If you only want one part of the package, install the package and disable the other extension in `pi config`.

## First Run Behavior

On first use, the extensions seed missing defaults into the normal editable Pi runtime paths:
- `~/.pi/agent/model-system-prompts/`
- `~/.pi/agent/structured-compaction/`

Existing files are not overwritten.

So the package gives you a ready-to-run setup, but the runtime files remain yours to edit.

Project-local overrides still work under:
- `.pi/model-system-prompts/`
- `.pi/structured-compaction/`

## Typical Setup Flow

If you are new to Pi, this is the shortest path:

```bash
npm install -g @mariozechner/pi-coding-agent
pi
# authenticate with /login or API key
pi install git:github.com/edhor1608/pi-tools
pi config
```

In `pi config`, make sure the extensions you want are enabled.

Then start using Pi normally.

## How To Use The Extensions

### Model-specific prompts

Edit or add prompt fragments in:
- `~/.pi/agent/model-system-prompts/`
- or per-project in `.pi/model-system-prompts/`

Resolution order is documented in:
- [defaults/model-system-prompts/README.md](defaults/model-system-prompts/README.md)

### Structured compaction

Edit config and prompt templates in:
- `~/.pi/agent/structured-compaction/config.json`
- `~/.pi/agent/structured-compaction/prompts/system.md`
- `~/.pi/agent/structured-compaction/prompts/compact.md`

Then use Pi normally. Compaction will run automatically when Pi decides it is needed, and you can inspect the latest compaction with:

```text
/compaction-report
```

More details live in:
- [defaults/structured-compaction/README.md](defaults/structured-compaction/README.md)

## Analyze A Session

The repo includes a standalone analyzer:

```bash
bun ./scripts/analyze-session.ts ~/.pi/agent/sessions/.../session.jsonl
```

It prints compaction metrics for saved Pi sessions.

## Status

Git install is ready now.

The npm package name is set to `@stead/pi-tools`, but npm publishing is a separate step and only works once the `@stead` scope is available to you.

## Repo

- GitHub: `https://github.com/edhor1608/pi-tools`
- Package name: `@stead/pi-tools`

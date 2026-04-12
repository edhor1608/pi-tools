# pi-tools

`pi-tools` is a Pi package focused on one thing: better context.

It ships two separate extensions that improve Pi in different parts of the same loop:
- `model-system-prompt` improves the context Pi sends into a model
- `structured-compaction` improves the context Pi keeps over long sessions

Together, they make Pi sessions feel more stable, more coherent, and easier to tune without patching Pi core.

## What Problem This Solves

Pi already has a solid base prompt and a good default compaction system. But two problems still show up in real use:
- different providers and models respond better to different extra instructions
- long sessions can lose continuity when older history gets compressed too aggressively

`pi-tools` addresses both.

The first extension helps Pi speak to each model in a way that fits that model better.
The second helps Pi carry long-running work forward with less loss of context.

## Why These Two Extensions Belong Together

They are both context-quality tools.

One shapes context before a request is sent.
The other preserves context after a session gets long.

That makes this package useful as a complete setup:
- better behavior at the start of a session
- better continuity later in the same session
- one package source
- two separately manageable extensions
- no Pi core fork

## Extension 1: Model-Specific System Prompts

Pi keeps its own native base/system prompt. This extension does not replace that.
It appends model-specific prompt fragments on top.

Implementation note: Pi's extension API does this by returning a new `systemPrompt` from `before_agent_start`. There is no separate `systemPromptAppend` return field. This package appends by composing with Pi's existing prompt, not by replacing it.

Why that is nice:
- you keep Pi's normal behavior instead of fighting it
- you can tune specific providers and models without touching Pi core
- prompt fragments stay as plain `.md` files
- you can override them globally or per project
- mixed-model setups become easier to keep consistent

In short: keep Pi's base prompt, then add the small model-specific steering each model benefits from.

Seeded defaults currently include:
- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.3-codex`
- `openai-codex/gpt-5.3-codex-spark`
- `opencode-go/kimi-k2.5`

More details:
- [defaults/model-system-prompts/README.md](defaults/model-system-prompts/README.md)

## Extension 2: Structured Compaction

Normal session compaction is useful, but it can still feel like the agent lost the thread after history gets compressed.

This extension keeps Pi's compaction flow, but upgrades the compacted result into a structured artifact that can be reused more intelligently later.

Why that is nice:
- long sessions continue more naturally after compaction
- tasks started before compaction can continue after compaction with less drift
- conversational context survives better, not just file state
- compatible OpenAI/Codex sessions can reuse provider-native compacted history
- non-compatible sessions still fall back safely to local compaction
- you can inspect what happened with visible metrics, `/compaction-report`, and `/trigger-compact`

In short: long sessions stay coherent instead of turning into a vague summary blob.

Main features:
- `auto`, `pi-model`, and `codex-remote` backends
- persisted remote compaction artifacts
- reinjection of compatible compacted history into later provider requests
- compaction metrics in the TUI summary
- `/compaction-report latest|all`
- `/trigger-compact [instructions]`

More details:
- [defaults/structured-compaction/README.md](defaults/structured-compaction/README.md)

## Install Pi First

If you do not have Pi yet:

```bash
npm install -g @mariozechner/pi-coding-agent
```

Start Pi once:

```bash
pi
```

Then authenticate in one of these ways:
- run `/login` inside Pi and choose a provider
- or export a supported API key such as `OPENAI_API_KEY`

Pi docs:
- `https://github.com/badlogic/pi-mono/tree/main/packages/pi-coding-agent`
- `https://pi.dev`

## Install This Package

### Install from git

```bash
pi install git:github.com/edhor1608/pi-tools
```

### Try without installing

```bash
pi -e git:github.com/edhor1608/pi-tools
```

### Install from a local checkout

```bash
pi install /absolute/path/to/pi-tools
```

## What Gets Loaded

This package exposes two separate extension resources:
- `extensions/model-system-prompt.ts`
- `extensions/structured-compaction/index.ts`

So users install one package, but can still enable or disable the two parts independently in `pi config`.

That keeps the surface simple without forcing every user to use every extension.

## First Run Behavior

On first use, the extensions seed missing defaults into Pi's normal editable runtime paths:
- `~/.pi/agent/model-system-prompts/`
- `~/.pi/agent/structured-compaction/`

Existing files are not overwritten.

That means the package gives users a ready-to-run setup, while still leaving the runtime files fully editable.

Project-local overrides also work under:
- `.pi/model-system-prompts/`
- `.pi/structured-compaction/`

## Typical Setup Flow

For someone starting from zero, this is the shortest path:

```bash
npm install -g @mariozechner/pi-coding-agent
pi
# authenticate with /login or an API key
pi install git:github.com/edhor1608/pi-tools
pi config
```

In `pi config`, enable the parts you want.

## How To Use It

### Model-specific prompts

Edit or add prompt fragments in:
- `~/.pi/agent/model-system-prompts/`
- or per-project in `.pi/model-system-prompts/`

The extension resolves prompts from general to specific, so you can set defaults per provider or per exact model.

### Structured compaction

Edit config and prompt templates in:
- `~/.pi/agent/structured-compaction/config.json`
- `~/.pi/agent/structured-compaction/prompts/system.md`
- `~/.pi/agent/structured-compaction/prompts/compact.md`

Then use Pi normally.
Compaction runs when Pi needs it, and you can inspect it or force it with:

```text
/compaction-report latest
/compaction-report all
/trigger-compact
/trigger-compact preserve more implementation detail around auth and provider behavior
```

## Analyze A Session

The repo includes a standalone analyzer:

```bash
bun ./scripts/analyze-session.ts ~/.pi/agent/sessions/.../session.jsonl
```

It prints compaction metrics for saved Pi sessions.

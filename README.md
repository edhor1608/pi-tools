# pi-tools

`pi-tools` is a Pi package focused on one thing: better context.

It ships seven separate extensions that improve Pi in different parts of the same loop:
- `model-system-prompt` improves the context Pi sends into a model
- `context-health` shows whether the current branch is healthy in terms of subscription pressure, cache utilization, and context rot
- `context-files` lets you disable discovered AGENTS/CLAUDE context files without renaming them
- `file-footnotes` turns inline file links in assistant messages into numbered footnotes
- `notify` makes Pi feel more alive in the terminal with title updates and native notifications
- `stash` stores full deferred prompts with controlled release modes
- `structured-compaction` improves the context Pi keeps over long sessions

Together, they make Pi sessions feel more stable, more coherent, and easier to tune without patching Pi core.

## What Problem This Solves

Pi already has a solid base prompt and a good default compaction system. But two problems still show up in real use:
- different providers and models respond better to different extra instructions
- long sessions can lose continuity when older history gets compressed too aggressively

`pi-tools` addresses both.

These extensions improve different parts of the same session loop:
- model-specific prompt fragments help Pi speak to each model in a way that fits that model better
- context health shows whether the current branch is still healthy
- context-files lets you decide which discovered context files actually reach the model
- file-footnotes makes assistant answers with many file references easier to read
- notify shows that something is happening while the agent is working and when it needs you again
- stash gives the user a third message lane for prompts that should be saved now and released later
- structured compaction helps Pi carry long-running work forward with less loss of context

## Why These Extensions Belong Together

They are all context-quality tools.

One shapes context before a request is sent.
One shows whether the current branch is still healthy.
One lets you disable inherited context files without renaming them.
One makes file-heavy assistant answers easier to read.
One makes the terminal itself better at reflecting agent state.
One gives the user a deferred-prompt stash.
One preserves context after a session gets long.

That makes this package useful as a complete setup:
- better behavior at the start of a session
- better visibility into whether the current branch is still healthy
- better visibility into whether Pi is actively working or waiting on you
- control over which inherited context files actually count
- cleaner assistant answers when many file references are involved
- a clean way to save future prompts without queueing them too early
- better continuity later in the same session
- one package source
- seven separately manageable extensions
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

## Extension 3: Context Health

This extension adds a compact footer status line and a `/context-health` inspector.

Why that is nice:
- you can see whether you are actually getting cache benefit
- you can see whether the current branch is getting stale even before a failure happens
- subscription usage is shown as exact when a provider exposes it, otherwise as a clearly marked estimate
- it keeps the existing Pi footer and adds one focused health line instead of replacing everything

Current metrics:
- `sub`: exact when available, otherwise estimated and marked as such
- `cache`: rolling cache-read ratio across recent assistant turns
- `rot`: compound freshness score based on context usage, turns since compaction, and uncached input since compaction

In short: not more telemetry, but better telemetry.

## Extension 4: Notify

This extension improves the basic terminal ergonomics of Pi without touching Pi core.

Why that is nice:
- the terminal title shows that the agent is actively working instead of looking dead
- when Pi finishes, the title switches to a clear idle state instead of just stopping silently
- when the assistant ends by asking for input, the notification tells you that directly
- queued follow-ups do not produce misleading "ready" notifications between turns

Current behavior:
- while Pi is working, the terminal title shows a spinner
- when Pi finishes normally, the title switches to a ready marker and a native terminal notification is sent
- when Pi finishes by asking a question, the title and notification switch to a needs-input state
- when Pi ends with an error, the title and notification switch to an error state

In short: Pi feels less silent and easier to monitor from the terminal.

## Extension 5: Context Files

Pi already discovers `AGENTS.md` and `CLAUDE.md` files automatically.
This extension keeps that discovery model, but lets you decide which discovered files actually reach the model.

Why that is nice:
- you can disable a noisy global or parent context file without renaming it
- control stays project-local in `.pi/context-files.json`
- the toggle UI shows every discovered path in one place
- the footer can show when some context files are filtered out

Current behavior:
- `/context-files` opens a toggle UI for discovered context files
- each file can be switched between `✓ enabled` and `× disabled`
- disabled files are removed from the final `# Project Context` section before the model sees it
- Pi's startup `[Context]` header still reflects core discovery, because that happens before extension filtering

In short: keep Pi's automatic context-file discovery, but decide which files actually count.

## Extension 6: File Footnotes

Pi renders markdown links inline. That works fine for short web links, but assistant answers that mention many files become hard to read when every bullet also includes a long muted absolute path.

This extension patches assistant-message rendering so file links become numbered footnotes instead.

Why that is nice:
- the main sentence stays readable instead of being interrupted by long absolute paths
- the file references still stay visible under the same message
- non-file links keep Pi's normal inline rendering
- the behavior is automatic once the extension is enabled

Current behavior:
- assistant file links render inline as `label[1]`, `label[2]`, and so on
- the inline file label stays directly clickable for normal file or path opening
- the footnote block starts collapsed and can be toggled with `Ctrl+Shift+O`
- expanded footnotes show the full file target plus a `VS Code` open link for files and directories
- `/file-footnotes` opens file footnotes from the latest assistant message when terminal hyperlinks are unavailable, with both `open` and `vscode` actions
- web links and other non-file links keep Pi's normal inline style

Implementation note: this is an internal render patch against Pi's assistant markdown component, so it may need adjustment when Pi changes its internal message renderer.

In short: keep file references clickable and visible, but stop them from breaking the reading flow.

## Extension 7: Stash

This extension adds a third message lane.
It is not a steering message and not a follow-up queue message. It stores a full prompt for later release.

Why that is nice:
- you can get a future prompt out of your head without sending it too early
- stashed prompts stay completely out of model context while they are waiting
- release is explicit per item: `manual`, `draft`, or `send`
- automatic release uses the same ready/question/error/queued heuristics as the notify extension, so it stays extension-side instead of polluting the system prompt
- ordering is FIFO by default, but you can edit and reorder items

Release modes:
- `manual`: only release when you explicitly apply or send the item
- `draft`: when Pi finishes cleanly and is truly ready, load the prompt into the editor and remove it from the stash
- `send`: when Pi finishes cleanly and is truly ready, send the prompt as the next real user message and remove it from the stash

User-facing commands:
- `/stash` opens the editable stash UI
- `/stash add [manual|draft|send] <text>`
- `/stash edit <id> <text>`
- `/stash mode <id> <manual|draft|send>`
- `/stash apply <id>`
- `/stash send <id>`
- `/stash drop <id>`
- `/stash move <id> <up|down>`
- `/stash list`

Shortcuts:
- `Ctrl+Alt+S` stashes the current editor text, or opens an editor if the input is empty
- `Ctrl+Shift+S` opens the stash UI

In short: this is the right home for "save this next prompt for later".

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

This package exposes seven separate extension resources:
- `extensions/model-system-prompt.ts`
- `extensions/context-health.ts`
- `extensions/context-files.ts`
- `extensions/file-footnotes.ts`
- `extensions/notify.ts`
- `extensions/stash.ts`
- `extensions/structured-compaction/index.ts`

So users install one package, but can still enable or disable the parts independently in `pi config`.

That keeps the surface simple without forcing every user to use every extension.

Pi loads all exposed extensions by default. If you want a narrower setup, use `pi config` or package filtering in settings.

## Recommended Extension Sets

### Core context

Good default if you want better model behavior, compaction, visibility, and terminal feedback without adding planning surfaces.

Extensions:
- `model-system-prompt`
- `context-health`
- `context-files`
- `file-footnotes`
- `notify`
- `structured-compaction`

### Deferred prompts

Adds `stash` if you want a full-prompt parking lane for "later, but not yet" messages.

### Full

Enable everything if you also want stash-based deferred prompts in addition to the core context features.

## Example Package Filtering

This is a good starting point if you want the core context setup but want `stash` off by default:

```json
{
  "packages": [
    {
      "source": "git:github.com/edhor1608/pi-tools",
      "extensions": [
        "+extensions/model-system-prompt.ts",
        "+extensions/context-health.ts",
        "+extensions/context-files.ts",
        "+extensions/file-footnotes.ts",
        "+extensions/notify.ts",
        "+extensions/structured-compaction/index.ts",
        "-extensions/stash.ts"
      ]
    }
  ]
}
```

If you later want deferred-prompt stash too, add it back in `pi config` or remove the exclusion.

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

### Context health

Use it immediately after installing:

```text
/context-health
```

It also adds a live footer status line for the current branch.

### Notify

It works automatically once enabled. There is no command to remember.

What you should see:
- a spinner in the terminal title while Pi is working
- a ready marker in the title when Pi finishes normally
- a needs-input marker in the title when Pi ends by asking a question
- a native terminal notification when Pi becomes ready or needs input

### File footnotes

It works automatically once enabled. If your terminal does not support the links, use `/file-footnotes` as a fallback.

What you should see:
- file links in assistant answers stay inline as short labels
- the inline file label still opens the file or path directly in terminals that support hyperlinks
- the footnote block starts collapsed and can be toggled with `Ctrl+Shift+O`
- expanded footnotes show the full target plus a `VS Code` open link
- `/file-footnotes` lets you pick a footnote from the latest assistant message and choose `Open path` or `Open in VS Code`
- `/file-footnotes open <index>` and `/file-footnotes vscode <index>` also work directly
- normal web links still render the way Pi normally renders them

### Context files

Use it when Pi finds the right context files, but you do not want all of them to reach the model:

```text
/context-files
```

Then toggle entries on or off in the UI. Disabled files are removed from the final prompt before the model sees it.

### Stash

Use stash when you have a full prompt in mind that should wait until later:

```text
/stash add draft Write the changelog after the current task is fully done
/stash add send After that, review the release notes too
```

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

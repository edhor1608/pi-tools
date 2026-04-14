# pi-tools

`pi-tools` is a Pi package focused on one thing: better context.

It ships seven separate extensions that improve Pi in different parts of the same loop:
- `model-system-prompt` improves the context Pi sends into a model
- `context-health` shows whether the current branch is healthy in terms of subscription pressure, cache utilization, and context rot
- `notify` makes Pi feel more alive in the terminal with title updates and native notifications
- `stash` stores full deferred prompts with controlled release modes
- `workgraph` gives Pi a sparse issue-style planning layer instead of overloading follow-up queueing
- `parallel` prepares eligible workgraph items into separate git worktrees
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
- notify shows that something is happening while the agent is working and when it needs you again
- stash gives the user a third message lane for prompts that should be saved now and released later
- workgraph gives the user and agent a shared sparse planning model for parked later work and dependencies
- parallel turns eligible workgraph items into prepared git worktrees without changing Pi core
- structured compaction helps Pi carry long-running work forward with less loss of context

## Why These Extensions Belong Together

They are all context-quality tools.

One shapes context before a request is sent.
One shows whether the current branch is still healthy.
One makes the terminal itself better at reflecting agent state.
One gives the user a deferred-prompt stash.
One gives the user and agent a sparse workgraph for parked later work.
One prepares truly parallel work into separate git worktrees.
One preserves context after a session gets long.

That makes this package useful as a complete setup:
- better behavior at the start of a session
- better visibility into whether the current branch is still healthy
- better visibility into whether Pi is actively working or waiting on you
- a clean way to save future prompts without queueing them too early
- better control over sparse issue-style planning and parked later work
- a starting point for real parallel git-worktree execution
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

## Extension 5: Stash

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

## Extension 6: Workgraph

This extension is not a basic todo list.
It is a sparse issue-style planning layer for later work that benefits from structure instead of a raw deferred prompt.

Why that is nice:
- the user can park later structured work without auto-sending it to the agent
- blocked current work stays blocked instead of being silently replaced by the next queued request
- the agent and user can share the same graph state
- dependencies between items can be modeled with `dependTo`
- each item can be marked `local` or `parallel`
- explicit merge items can be represented directly in the graph

Workgraph model:
- item states: `active`, `pending`, `blocked`, `done`, `cancelled`
- execution modes: `local`, `parallel`
- item kinds: `work`, `merge`
- hybrid activation: do not use the workgraph for trivial one-step work, but allow it to appear naturally when work becomes multi-step or blocked
- keep it sparse: prefer one broad active issue and a few parked later issues instead of implementation-step subtasks

User-facing commands:
- `/graph` opens the editable workgraph UI
- `/item add [local|parallel] <text>` parks a new work item
- `/item merge <text>` adds an explicit merge item
- `/item activate <id>`
- `/item block <id> [reason]`
- `/item done <id>`
- `/item cancel <id>`
- `/item edit <id> <text>`
- `/item depend <id> <depIds>`
- `/item execution <id> <local|parallel>`
- `/item kind <id> <work|merge>`
- `/item move <id> <up|down>`
- `/item clear-resolved`

Agent-facing behavior:
- the `workgraph` tool is available to the model
- the system prompt explains the sparse issue-style model and when not to use it
- the current graph state is appended to the system prompt when a graph exists

In short: this is a better home for "next, but not yet" than the normal follow-up queue.

## Extension 7: Parallel

This extension is the first execution layer on top of the workgraph.
It does not run background workers yet. Instead, it prepares eligible `parallel` items into real git worktrees and stores the handoff metadata back on the graph item.

Why that is nice:
- truly independent work gets its own clean filesystem and branch instead of sharing one working tree
- the graph can stay the source of truth while execution details live on the item itself
- explicit merge items stay explicit; nothing gets merged automatically behind the user's back
- it is a good preparation step for a later real parallel executor

Current behavior:
- `/parallel prepare` prepares every ready parallel item with resolved dependencies
- `/parallel prepare <id>` prepares one specific parallel item
- `/parallel list` shows prepared worktrees
- `/parallel prompt <id>` shows the prepared worker prompt for a specific item
- preparation currently requires a clean git working tree because new worktrees branch from `HEAD`

In short: it is real git-worktree preparation now, with room for a true executor later.

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
- `extensions/notify.ts`
- `extensions/stash.ts`
- `extensions/workgraph.ts`
- `extensions/parallel.ts`
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
- `notify`
- `structured-compaction`

### Planning

Adds the two "later, but not yet" layers:
- `stash` for full deferred prompts
- `workgraph` for sparse structured planning

This is a good fit if you like Pi's normal flow but want better handling for future prompts and parked work.

### Full

Enable everything, including `parallel`, if you also want worktree preparation for eligible graph items.

## Example Package Filtering

This is a good starting point if you want the core context setup but want `stash`, `workgraph`, and `parallel` off by default:

```json
{
  "packages": [
    {
      "source": "git:github.com/edhor1608/pi-tools",
      "extensions": [
        "+extensions/model-system-prompt.ts",
        "+extensions/context-health.ts",
        "+extensions/notify.ts",
        "+extensions/structured-compaction/index.ts",
        "-extensions/stash.ts",
        "-extensions/workgraph.ts",
        "-extensions/parallel.ts"
      ]
    }
  ]
}
```

If you later want the planning layer too, add these back in `pi config` or remove the exclusions.

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

### Stash

Use stash when you have a full prompt in mind that should wait until later:

```text
/stash add draft Write the changelog after the current task is fully done
/stash add send After that, review the release notes too
```

### Workgraph and parallel

Use the workgraph when later work benefits from structure instead of a raw deferred prompt:

```text
/graph
/item add parallel build the formatter in a separate worktree
/item merge merge formatter branch back after review
/item depend 3 2
/parallel prepare
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

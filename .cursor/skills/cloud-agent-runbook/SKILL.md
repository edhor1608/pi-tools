---
name: cloud-agent-runbook
description: Practical setup, run, and test instructions for Cloud agents working on pi-tools.
---

# Cloud Agent Runbook

Use this skill when you need to run, test, or debug `pi-tools` in a Cloud agent environment.

## Repository overview

- `extensions/`: Pi extension entry points and shared extension logic.
- `extensions/structured-compaction/`: compaction backend, renderer, artifact, metrics, and report logic.
- `defaults/`: packaged model prompt and structured-compaction defaults seeded into Pi runtime paths.
- `scripts/`: Bun smoke/integration tests and session analysis helpers.
- `docs/`: Pi compatibility notes and decision history.

## First setup

1. Confirm dependencies are present:
   - `node --version`
   - `bun --version`
   - `pi --version`
2. If Pi is missing, install it:
   - `npm install -g @mariozechner/pi-coding-agent`
3. Authenticate Pi before running real interactive or provider-backed flows:
   - Start `pi`, then run `/login` and choose a provider.
   - Or export a provider key such as `OPENAI_API_KEY`.
   - Codex remote compaction needs a compatible `openai-codex` login/OAuth setup.
4. Run this checkout as a local Pi package:
   - `pi --no-extensions -e /workspace`
   - Use `--no-context-files` when isolating context-file discovery behavior from inherited `AGENTS.md` or `CLAUDE.md`.
5. For normal package-level checks:
   - `npm run build`
   - `npm run check`

## Feature flags, toggles, and test isolation

- Context health provider diagnostics are hidden unless enabled:
  - `PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG=1 pi --no-extensions -e /workspace`
- Structured compaction defaults live in `defaults/structured-compaction/config.json`.
  - Use project-local overrides in `.pi/structured-compaction/config.json` for experiments.
  - Set `"backend": { "kind": "pi-model" }` to avoid Codex remote behavior during local-only tests.
  - Set `"enabled": false` to disable the extension behavior in a project override.
- Model prompt overrides live in `.pi/model-system-prompts/`.
- Context file filtering state lives in `.pi/context-files.json`.
- Prefer temp workspaces for tests that create `.pi` files or context files.

## Area workflows

### Model system prompts

- Main files:
  - `extensions/model-system-prompt.ts`
  - `defaults/model-system-prompts/`
- Fast checks:
  - `npm run test:packaged-defaults-fallback`
  - Start Pi with `pi --no-extensions -e /workspace`, choose a target model, and confirm matching prompt fragments are seeded under `~/.pi/agent/model-system-prompts/`.
- Useful manual flow:
  - Add a temporary `.pi/model-system-prompts/<provider>/<model>.md`.
  - Start Pi locally with the package enabled.
  - Ask a prompt that should reflect the extra instruction.
  - Remove the temporary override before committing unless it is part of the task.

### Context health

- Main files:
  - `extensions/context-health.ts`
  - `scripts/test-context-health.ts`
- Automated check:
  - `bun ./scripts/test-context-health.ts`
- Manual provider-debug flow:
  - Run `PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG=1 pi --no-extensions -e /workspace`.
  - Send one provider-backed prompt.
  - Run `/context-health`.
  - Confirm provider status and selected headers appear only when the env flag is set.

### Context files

- Main files:
  - `extensions/context-files.ts`
  - `scripts/test-context-files.ts`
- Automated check:
  - `npm run test:context-files`
- Manual flow:
  - Create a temp workspace with global, ancestor, and project `AGENTS.md` or `CLAUDE.md` files.
  - Start `pi --no-extensions -e /workspace` from the project directory.
  - Run `/context-files`, toggle one file off, and verify `.pi/context-files.json` records the disabled path.
  - Use `--no-context-files` only when you need to separate Pi core discovery from extension filtering.

### File footnotes

- Main files:
  - `extensions/file-footnotes.ts`
  - `scripts/test-file-footnotes.ts`
- Automated check:
  - `npm run test:file-footnotes`
- Manual flow:
  - Start `pi --no-extensions -e /workspace`.
  - Ask Pi to mention several local files with markdown links.
  - Confirm file links render as numbered footnotes, `Ctrl+Shift+O` toggles the footnote block, and `/file-footnotes` can open the latest footnotes.
  - Fully restart Pi after changing this area; `/reload` is less reliable because the extension patches assistant-message rendering internals.

### Notify

- Main file:
  - `extensions/notify.ts`
- Manual flow:
  - Start `pi --no-extensions -e /workspace`.
  - Send a prompt, then watch the terminal title while Pi is working and after it finishes.
  - Test normal completion, question-ending completion, queued follow-ups, and provider error cases when relevant.
- There is no dedicated script yet; pair notify changes with manual terminal verification.

### Stash

- Main files:
  - `extensions/stash.ts`
  - `scripts/test-stash-release.ts`
- Automated check:
  - `npm run test:stash-release`
- Manual flow:
  - Start `pi --no-extensions -e /workspace`.
  - Run `/stash add manual ...`, `/stash add draft ...`, and `/stash add send ...`.
  - Verify manual items block later auto-release, draft items populate the editor, send items send a new user message, and `/stash move` changes release order.

### Structured compaction

- Main files:
  - `extensions/structured-compaction/`
  - `defaults/structured-compaction/`
  - `scripts/analyze-session.ts`
- Fast checks:
  - `npm run test:packaged-defaults-fallback`
  - Run focused scripts or manual tests for the area that consumes compaction output.
- Manual local-only flow:
  - Add a temporary `.pi/structured-compaction/config.json` with `"backend": { "kind": "pi-model" }`.
  - Start `pi --no-extensions -e /workspace`.
  - Build a multi-turn session, run `/trigger-compact`, then run `/compaction-report latest`.
- Manual Codex remote flow:
  - Confirm Codex auth is available through Pi login.
  - Use an `openai-codex` model with the default `auto` backend or explicit `"kind": "codex-remote"`.
  - Run `/trigger-compact`, then inspect `/compaction-report latest` and optionally analyze the saved session:
    - `bun ./scripts/analyze-session.ts ~/.pi/agent/sessions/.../session.jsonl`

## Suggested pre-PR checks

- For docs-only or skill-only edits:
  - `npm run build`
  - `npm run check`
- For extension code edits, run the relevant script plus any adjacent scripts:
  - `npm run test:context-files`
  - `npm run test:file-footnotes`
  - `npm run test:stash-release`
  - `bun ./scripts/test-context-health.ts`
  - `npm run test:packaged-defaults-fallback`
- For UI/TUI behavior, also run Pi manually and record what changed.

## Updating this skill

- Add a new command or workflow as soon as it proves useful during a real task.
- Keep entries practical: include exact commands, required auth, env vars, paths written, and cleanup steps.
- Prefer adding the note under the relevant area instead of creating a broad troubleshooting section.
- If a workflow depends on a Pi version, mention the version and update `docs/pi-version-notes.md` when the baseline changes.

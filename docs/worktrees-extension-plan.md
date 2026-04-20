# Worktrees Extension Plan

Status: planned, not implemented yet
Date: 2026-04-17

## Context

The goal is to add a new `worktrees` extension to `pi-tools`.

This extension should make git worktrees the normal way to prepare and reuse isolated coding environments for tasks, without turning Pi into a rigid workflow system.

The extension should help with:
- creating worktrees from the right base branch or ref
- reusing an existing matching worktree instead of creating duplicates
- keeping all managed worktrees in one predictable location
- bootstrapping a new worktree so it is ready to code and test in
- cleaning up stale or finished worktrees safely

This extension should stay Pi-native and lightweight:
- command-driven instead of system-prompt-driven
- helpful without being strict or blocking
- little to no context bloat
- no hidden workflow engine that guesses too much from normal chat text

## What We Explicitly Decided

### 1. Actual checkouts do not live in a Pi-owned hidden directory

Managed worktrees should not be created under `~/.pi/...`.

Default root:
- `~/worktrees`

Reason:
- this should feel like a real developer workspace, similar to `~/repos`
- the checkouts should be easy to inspect and clean up manually
- the extension may keep small config or metadata elsewhere later, but not the actual worktrees

### 2. Ignore the old `parallel` extension design as a product direction

The old `parallel` worktree-preparation work should not define the new extension design.

Reason:
- the new extension should be designed from first principles around direct worktree management
- it should not inherit extra workgraph or executor concepts
- prior code may still be useful as an implementation reference later, but it is not the design source

### 3. This should be command-first, not prompt-first

The extension should be driven by explicit commands and small UI flows.

Preferred Pi integration surface:
- `pi.registerCommand(...)`
- `ctx.ui.select(...)`
- `ctx.ui.confirm(...)`
- `ctx.ui.notify(...)`
- `pi.exec(...)`
- optionally `session_start` for lightweight status or hints

Things to avoid:
- large system prompt additions
- always-on worktree instructions in model context
- automatic worktree creation from arbitrary user chat text
- strict enforcement that can deadlock or block normal usage

### 4. The best non-user-only mechanism is trigger plus tool, not skill

The extension should not rely on the human user being the only way worktree handling starts.

But the preferred non-user-only path is:
- a narrow extension-side trigger for strong signals
- a small LLM-callable tool
- shared internal logic behind both the command and the tool

A skill is optional and may still be useful later for guidance, but it should not be the main execution mechanism.

Reason:
- a skill is good for instructions and policy, but not the best execution surface
- a tool gives the model a real action surface
- a trigger gives the harness a lightweight way to prompt for worktree handling at the right moment
- this keeps the extension Pi-native without bloating normal context

### 5. Do not require all Pi sessions to run inside a managed worktree

This extension should not force Pi itself to always be started from a managed worktree.

Allowed and expected:
- starting Pi in the base repo
- starting Pi in some unrelated directory
- using Pi normally without any worktree action when the task does not call for one

The extension should only intervene when there is a strong worktree-relevant signal and the task would benefit from isolation, reuse, review, or preparation in a dedicated worktree.

Reason:
- worktrees are an important workflow tool, not the only valid Pi runtime mode
- the extension should improve the default path for task work without taking away normal freeform Pi usage
- this keeps the behavior aligned with Pi's non-strict philosophy

### 6. The extension should preserve the original intent of `/context-files`

This new extension should follow the same overall philosophy as the other `pi-tools` extensions:
- Pi or the extension handles the discovery or mechanical part
- the user stays in control over the important decision point
- the extension makes the desired workflow easy without forcing it all the time

For `worktrees`, that means:
- discover existing worktrees first
- reuse when sensible
- create when needed
- offer setup
- offer cleanup
- do not silently take over normal session flow

## Product Goal

Make worktrees the easy and consistent default for task-oriented development, while keeping the workflow explicit and low-friction.

In practical terms:
- when the user starts work for a task, PR, issue, or stacked branch, the extension should help them end up in the correct worktree
- if that worktree already exists locally, the extension should find it before creating anything new
- if it does not exist, the extension should create it in a predictable place and make it usable immediately

## V1 Scope

V1 should be small and centered around three commands:
- `/worktrees ensure [query]`
- `/worktrees list`
- `/worktrees cleanup`

### `/worktrees ensure [query]`

This is the main workflow command.

Responsibilities:
1. Detect the current git repo root.
2. Inspect existing local worktrees first.
3. Try to match an existing worktree for the given context.
4. If a good match exists, offer reuse.
5. If not, ask the user what base ref to use.
6. Create a new branch and worktree in the managed root.
7. Offer or run setup heuristics.
8. Show the exact command to start working there.

This command should cover the most common need end to end.

### `/worktrees list`

This should show currently managed or discovered worktrees for the current repo, including key metadata such as:
- branch
- path
- base ref if known
- setup status if tracked
- whether the worktree is clean or dirty

### `/worktrees cleanup`

This should provide a safe and explicit cleanup flow.

It should:
- show cleanup candidates
- never silently remove dirty worktrees
- prefer removing only clearly safe or stale entries
- use confirmations before destructive actions

## Default Filesystem Layout

The default managed root should be:
- `~/worktrees`

Recommended layout under that root:
- `~/worktrees/<host>/<owner>/<repo>/<worktree-name>`

Examples:
- `~/worktrees/github.com/vivenu/backend/fix-checkout-cache`
- `~/worktrees/github.com/edhor1608/pi-tools/worktrees-extension`
- `~/worktrees/github.com/vivenu/dashboard/pr-1234`

Fallback layout when no remote can be parsed cleanly:
- `~/worktrees/local/<repo-name>/<worktree-name>`

Reason:
- predictable and human-readable
- mirrors how repositories are often organized under `~/repos`
- reduces ambiguity when the same repo name exists under different owners or hosts

## Matching Strategy

Before creating a new worktree, the extension should try to reuse an existing one.

Matching should be deterministic and conservative.

Preferred match order:
1. exact branch match
2. exact PR-number match
3. exact issue-key or ticket-token match
4. normalized query slug match
5. then optional suggestions for close candidates

The extension should prefer offering a reuse decision instead of auto-choosing a weak fuzzy match.

This is one of the core value points of the extension:
- avoid duplicate worktrees for the same context
- keep the machine state aligned with the task state

## Base Ref Selection

The parent or base branch for a new worktree cannot be hardcoded.

The right base depends on the task context. It may be:
- the default branch
- the current branch
- another local branch that should be stacked on
- a remote branch
- an existing PR branch being reviewed or continued locally

So the extension should not assume one base branch globally.

Instead, `/worktrees ensure` should ask or suggest.

Suggested base-ref sources in V1:
- current branch
- default branch from remote HEAD if available
- recent local branches
- a manually typed ref

## Setup / Bootstrap Behavior

A newly created or newly reused worktree should be easy to start working in.

The extension should support lightweight setup heuristics.

Initial detection rules:
- `pnpm-lock.yaml` -> `pnpm install`
- `yarn.lock` -> `yarn install`
- `package-lock.json` -> `npm install` or `npm ci`
- `bun.lock` or `bun.lockb` -> `bun install`
- `go.mod` -> `go mod download`

V1 behavior should be:
- setup is offered or default-on, but still user-visible
- setup should not be silently mandatory in every case
- setup should be skippable

Potential later enhancement:
- track whether setup already ran successfully for a worktree, so reuse can avoid unnecessary reinstall work

## Cleanup Rules

Cleanup belongs in the same extension, because creation and deletion should be managed together.

Cleanup candidates should include:
- missing or prunable worktree entries
- clean worktrees whose branch was deleted
- clean worktrees whose branch has already been merged
- clearly stale managed worktrees that have not been used for a while

Cleanup should not:
- auto-delete dirty worktrees
- run destructively in the background
- assume that merged always means safe when local changes still exist

V1 cleanup should be explicit and interactive.

## Pi Runtime Constraints

One important constraint is that the extension cannot cleanly move the current running Pi process into a different cwd in a supported way.

That means the correct V1 UX is:
- prepare or locate the correct worktree
- show the exact path
- show the exact command to continue there, for example `cd ... && pi`
- optionally make that command easy to copy or send to the editor

What V1 should not pretend to do:
- transparently move the current Pi runtime into the new worktree

So the extension makes worktree usage the easy path, but does not magically teleport the current session.

## Recommended Pi Hooks / APIs

Use these Pi features directly:
- `pi.registerCommand(...)`
- `ctx.ui.select(...)`
- `ctx.ui.confirm(...)`
- `ctx.ui.notify(...)`
- `pi.exec(...)`
- `pi.registerTool(...)` for a small LLM-callable worktree action surface
- `pi.registerMessageRenderer(...)` if a compact result view is helpful
- `session_start` only for lightweight hints or state refresh
- optionally narrow `input` interception only for strong worktree signals

Use these sparingly:
- `pi.appendEntry(...)` only for small extension state if needed
- `pi.sendUserMessage(...)` only if we intentionally want to route a trigger through a visible slash-command flow

Avoid for V1:
- `before_agent_start` system prompt mutation
- broad automatic `input` interception for normal user prompts
- skills as the main execution mechanism

## What V1 Should Not Do

Explicit non-goals for the first version:
- no automatic worktree creation from arbitrary conversation text
- no large worktree policy in the system prompt
- no background cleanup daemon behavior
- no hard dependency on GitHub PR APIs or `gh`
- no forced worktree-only mode that blocks normal use
- no requirement that every Pi session must run from a managed worktree
- no broad workflow/planning graph integration
- no workgraph revival or executor design bundled into this extension
- no skill-first design where a skill is the main way worktree execution happens

## Candidate User Flow

Example V1 flow for `/worktrees ensure 1234`:

1. User runs `/worktrees ensure 1234`.
2. Extension finds current repo root.
3. Extension inspects local worktrees and branches.
4. Extension finds an existing worktree tied to branch `pr-1234`.
5. Extension asks whether to reuse it.
6. If reused, extension optionally offers setup if needed and shows:
   - path
   - branch
   - `cd <path> && pi`
7. If no match exists, extension asks what base ref to use.
8. Extension creates a new branch and worktree under `~/worktrees/...`.
9. Extension runs or offers setup.
10. Extension reports the final start command.

## Configuration Direction

V1 should stay small, but a small config surface is reasonable.

Likely config file later:
- `.pi/worktrees.json`

Likely options:
- `root`: default `~/worktrees`
- `autoSetup`: default `true`
- `preferredInstallCommand`: optional override
- `maxCleanupAgeDays`: optional cleanup hint threshold
- `naming`: optional strategy overrides later if needed

Important note:
- config may live in `.pi/...`
- actual worktrees do not

## Naming Direction

Worktree names should be readable and stable.

Preferred naming sources:
- explicit branch name if known
- PR number like `pr-1234`
- ticket key like `abc-123`
- otherwise a normalized slug from the query text

Names should be:
- lowercase
- filesystem-safe
- short but recognizable

## Open Questions

These are not blockers for writing V1, but still need decisions during implementation:
- should `/worktrees ensure` accept explicit flags later, such as `--base <ref>` or `--no-setup`?
- should the extension track metadata for managed worktrees in a small file under the repo or under the worktree root?
- should setup run automatically after reuse when dependencies are missing, or only after fresh creation?
- should `gh` integration become an optional enhancement for PR lookup in v2?
- should `session_start` show a status line if the current cwd is already a managed worktree?

## Implementation Plan

### Phase 1

Implement a minimal but usable foundation:
- repo root detection
- managed-root path builder for `~/worktrees`
- existing worktree discovery
- match scoring for reuse
- `/worktrees ensure`
- `/worktrees list`
- `/worktrees cleanup`
- shared internal logic that can be called from both commands and a tool
- a small `ensure_worktree` LLM-callable tool
- setup heuristics for common JS and Go repos
- focused tests around git worktree creation and reuse logic

### Phase 1.5

Add lightweight non-user-only entry points once the core flow feels solid:
- a narrow trigger for strong signals such as PR URLs, PR numbers, or issue-key-like task references
- trigger behavior should ask or suggest, not force
- optional routing through `pi.sendUserMessage(...)` only when a visible slash-command flow is preferable
- no skill required for this phase

### Phase 2

Add polish only if Phase 1 feels correct in practice:
- compact message renderer for worktree reports
- metadata persistence for setup state and cleanup hints
- optional config file support
- better branch/base selection UX
- optional PR or issue helpers

## Current Recommendation

Build the `worktrees` extension as a small worktree manager with:
- explicit `ensure`, `list`, and `cleanup` commands
- actual worktrees under `~/worktrees`
- deterministic reuse-first behavior
- setup as a first-class but lightweight step
- a small tool surface for model-driven invocation
- optional narrow triggers for strong signals
- no prompt bloat
- no strict hidden automation
- no skill-first execution design
- no assumption that every Pi session belongs in a managed worktree

This keeps the extension aligned with Pi's philosophy while still making worktree-based development the easy and repeatable path.

## Technical Implementation Breakdown

This section describes how the extension should be implemented before writing code.

### Module Layout

Recommended file layout:
- `extensions/worktrees.ts`
- `extensions/worktrees/config.ts`
- `extensions/worktrees/types.ts`
- `extensions/worktrees/git.ts`
- `extensions/worktrees/pathing.ts`
- `extensions/worktrees/intent.ts`
- `extensions/worktrees/match.ts`
- `extensions/worktrees/ensure.ts`
- `extensions/worktrees/setup.ts`
- `extensions/worktrees/cleanup.ts`
- `extensions/worktrees/render.ts`
- `scripts/test-worktrees-intent.ts`
- `scripts/test-worktrees-ensure.ts`
- `scripts/test-worktrees-cleanup.ts`

Purpose of each file:

`extensions/worktrees.ts`
- extension entrypoint
- registers commands
- registers the optional tool
- registers the optional `input` trigger
- coordinates UI and calls shared logic

`extensions/worktrees/config.ts`
- loads defaults
- later reads optional `.pi/worktrees.json`
- expands `~` in `~/worktrees`
- resolves feature toggles like `autoSetup` and trigger sensitivity

`extensions/worktrees/types.ts`
- all shared interfaces and result types
- intent, repo context, worktree metadata, setup result, cleanup candidate, report structures

`extensions/worktrees/git.ts`
- thin wrappers around `pi.exec()` or a passed command runner
- repo-root detection
- remote-url lookup
- branch listing
- `git worktree list --porcelain` parsing
- worktree creation/removal helpers
- merged/deleted-branch checks for cleanup

`extensions/worktrees/pathing.ts`
- remote URL parsing into `<host>/<owner>/<repo>`
- fallback `local/<repo>` pathing
- safe worktree-name generation
- managed-root path builder
- unique path and branch-name generation

`extensions/worktrees/intent.ts`
- extracts high-confidence worktree intent from raw user input
- detects PR URLs, PR numbers, issue keys, branch hints, stack hints
- assigns a confidence level so the trigger can stay conservative

`extensions/worktrees/match.ts`
- compares detected intent against existing worktrees
- deterministic scoring and candidate ranking
- distinguishes exact matches from suggestion-only matches

`extensions/worktrees/ensure.ts`
- main `ensureWorktree(...)` orchestration
- find existing match
- prompt for reuse or creation
- prompt for base ref when needed
- create the worktree if needed
- optionally call setup
- return a structured result for rendering and follow-up UX

`extensions/worktrees/setup.ts`
- project-type detection
- install/bootstrap command selection
- execution of setup command
- human-readable setup summary

`extensions/worktrees/cleanup.ts`
- identifies cleanup candidates
- builds cleanup plans
- executes removal for selected safe candidates
- never silently removes dirty worktrees

`extensions/worktrees/render.ts`
- compact text or custom-message renderer for reports
- formats ensure/list/cleanup results consistently

### Core Shared Types

Likely V1 types:

```ts
interface WorktreesConfig {
	root: string
	autoSetup: boolean
	enableInputTrigger: boolean
	triggerMinConfidence: "high" | "very-high"
}

interface RepoContext {
	cwd: string
	repoRoot: string
	currentBranch?: string
	defaultBranch?: string
	remoteUrl?: string
	repoKey: {
		host: string
		owner: string
		repo: string
		fallback: boolean
	}
}

interface ExistingWorktree {
	path: string
	branch?: string
	head?: string
	bare: boolean
	detached: boolean
	locked: boolean
	prunable: boolean
	isManaged: boolean
	isCurrent: boolean
}

interface WorktreeIntent {
	kind: "pr" | "issue" | "branch" | "task" | "unknown"
	query: string
	prNumber?: number
	issueKey?: string
	branchHint?: string
	baseHint?: string
	confidence: "low" | "medium" | "high" | "very-high"
}

interface WorktreeMatch {
	worktree: ExistingWorktree
	score: number
	reason: string
	exact: boolean
}

interface EnsureWorktreeResult {
	action: "reused" | "created" | "continued-here" | "cancelled"
	repoRoot: string
	worktreePath?: string
	branchName?: string
	baseRef?: string
	setup?: SetupResult
	startCommand?: string
	message: string
}

interface SetupResult {
	ran: boolean
	command?: string
	success?: boolean
	stdout?: string
	stderr?: string
}

interface CleanupCandidate {
	worktree: ExistingWorktree
	reason: string
	safe: boolean
	dirty: boolean
}
```

### Main Command Flow

`/worktrees ensure [query]`
1. Resolve config.
2. Build `RepoContext` from current `ctx.cwd`.
3. If not in a git repo, notify and stop.
4. Build intent from explicit `query` or from an empty/manual mode.
5. Discover existing worktrees.
6. Rank matches.
7. If there is an exact or strong match, ask whether to reuse it.
8. If reusing, optionally run setup.
9. If creating, ask for base ref.
10. Generate unique branch name and path under `~/worktrees/...`.
11. Run `git worktree add` with `-b <branch>` when creating a new branch.
12. Optionally run setup.
13. Render a result with path, branch, and `cd ... && pi`.

`/worktrees list`
1. Resolve `RepoContext`.
2. Discover worktrees.
3. Annotate with `isManaged`, `isCurrent`, `dirty`, and setup hints if available.
4. Render a compact list.

`/worktrees cleanup`
1. Resolve `RepoContext`.
2. Discover worktrees.
3. Compute cleanup candidates.
4. Show selection or confirmation UI.
5. Remove only selected allowed candidates.
6. Render result summary.

### `input` Trigger Flow

The `input` trigger is the primary enforcement point, but it must stay narrow.

Exact flow:
1. Ignore when `event.source === "extension"`.
2. Ignore when the incoming text is already an extension command such as `/worktrees ...` because commands run before `input` anyway.
3. Ignore when there is no UI or when `ctx.cwd` is not in a git repo.
4. Parse intent from raw input.
5. If intent confidence is below threshold, return `continue`.
6. Build repo context and discover existing worktrees.
7. If the current cwd already matches the best candidate, return `continue`.
8. Otherwise open a small decision UI:
   - reuse existing worktree
   - create new worktree
   - continue here once
   - cancel
9. If the user picks `continue here once`, return `continue`.
10. If the user picks reuse or create, run `ensureWorktree(...)`, show the result, and return `handled`.
11. If the user cancels, return `handled` or `continue` depending on whether cancellation should stop the turn entirely. Recommended V1 behavior: stop the turn with `handled` and notify.

This is how enforcement works without putting worktree policy into model context.

### Trigger Confidence Model

The trigger should only activate on high-confidence signals.

`very-high` confidence:
- GitHub PR URL like `/pull/1234`
- explicit wording like `review pr 1234`
- explicit wording like `continue pr 1234`
- explicit wording like `create a worktree for branch foo`

`high` confidence:
- issue key like `ABC-123` together with task language
- explicit branch stack phrasing like `stack on feature/foo`
- prompt clearly centered on an existing branch or PR context

`medium` or lower should not auto-trigger in V1.

That keeps the trigger from firing on generic prompts like `fix the tests` or `explain this code`.

### Matching Algorithm

Candidate ranking should be deterministic.

Recommended score order:
- branch exact match: 100
- PR exact match: 95
- issue key exact match: 90
- slug exact match: 80
- path basename contains token: 60
- weak fuzzy suggestion: below 50, never auto-reuse

Rules:
- reuse automatically only when there is a single exact high-confidence match and the user explicitly asked through the command path
- for trigger flow, still ask before reuse even on strong matches
- never auto-reuse a weak fuzzy candidate

### Base Ref Selection Flow

When creating a new worktree, base ref selection should use a small picker.

Sources, in order:
- current branch
- default branch from remote HEAD
- recent local branches
- manual entry

The manual entry path is important because stacked branches and PR-local continuation are not always represented by a simple default branch choice.

### Naming And Path Generation

Path generation should be pure and deterministic.

Inputs:
- managed root, default `~/worktrees`
- repo key from remote URL or local fallback
- worktree name from intent

Outputs:
- worktree path under `~/worktrees/<host>/<owner>/<repo>/<name>`
- unique branch name, suffixing only when necessary

Branch naming examples:
- `pr-1234`
- `abc-123`
- `fix-checkout-cache`
- `feature-foo-stack-2`

Path naming examples:
- `~/worktrees/github.com/org/repo/pr-1234`
- `~/worktrees/github.com/org/repo/abc-123`

### Setup Flow

`setupWorktree(...)` should be separate from creation.

Flow:
1. Detect project markers in the worktree path.
2. Choose a single setup command.
3. Ask for confirmation when setup is not fully automatic by config.
4. Run the command.
5. Return a `SetupResult`.

Rules:
- only one default setup command in V1
- no attempt to install every possible dependency manager
- no hidden repeated installs during the same ensure flow

### Cleanup Flow

`cleanupWorktrees(...)` should work from computed candidates.

Candidate rules:
- prunable entry -> safe candidate
- managed worktree with deleted branch and clean status -> safe candidate
- managed worktree with merged branch and clean status -> safe candidate
- dirty worktree -> visible candidate but not auto-safe

Execution rules:
- run `git worktree prune` first
- use `git worktree remove <path>` where possible
- only use forced removal after explicit confirmation
- do not delete unmanaged worktrees by default unless the user explicitly selects them

### Tool Design

V1 should expose one small tool:
- `ensure_worktree`

Suggested parameters:

```ts
{
	query?: string,
	mode?: "auto" | "reuse-or-create" | "reuse-only" | "create-only"
}
```

Tool behavior:
- calls the same `ensureWorktree(...)` logic as the command
- should not duplicate git logic
- should not bypass confirmation for destructive or ambiguous cases
- if called while streaming and a visible slash-command flow is preferable later, it may queue `/worktrees ensure ...` via `pi.sendUserMessage(...)`, but direct shared-logic execution is preferred for V1

### Rendering Strategy

V1 can start with plain message text plus `ctx.ui.notify(...)`.

If the output gets noisy, add one custom renderer for a message type like:
- `worktrees-report`

Message categories:
- ensure result
- list result
- cleanup result

### Metadata Strategy

V1 should avoid heavy metadata.

Recommended V1:
- infer most state from git and filesystem inspection
- avoid a new persistent metadata store unless setup-state tracking becomes necessary

If minimal metadata becomes necessary later, prefer a small project config or worktree-local marker over a central opaque state database.

### Error Handling Rules

All git and setup operations should return actionable user-facing errors.

Examples:
- not a git repo
- remote could not be parsed, using local fallback layout
- worktree path already exists unexpectedly
- branch already exists and conflicts with requested creation mode
- setup command failed

The extension should prefer:
- explicit warnings
- safe cancellation
- user choice

over hidden retries or aggressive fallback behavior.

### Test Plan

Initial tests should be temp-repo based, similar to the existing extension test style in this repo.

`test-worktrees-intent.ts`
- PR URL detection
- PR number detection
- issue-key detection
- non-triggering generic prompts
- branch/base-hint extraction

`test-worktrees-ensure.ts`
- repo-root detection
- managed path generation under `~/worktrees`
- existing worktree reuse
- new worktree creation
- branch-name collision suffixing
- current-worktree short-circuit
- setup command detection

`test-worktrees-cleanup.ts`
- prunable candidate detection
- merged-branch candidate detection
- deleted-branch candidate detection
- dirty worktree excluded from safe cleanup

Potential trigger-focused test later:
- `test-worktrees-input-trigger.ts`
  - strong signal handled
  - generic prompt continued
  - extension-originated message ignored

### Incremental Build Order

Recommended implementation order:
1. `types.ts`
2. `config.ts`
3. `git.ts`
4. `pathing.ts`
5. `intent.ts`
6. `match.ts`
7. `setup.ts`
8. `ensure.ts`
9. `cleanup.ts`
10. `worktrees.ts` commands only
11. tests for commands and helpers
12. `ensure_worktree` tool
13. `input` trigger
14. optional custom renderer

This order keeps the trigger until the core worktree logic is already reliable.

### First Cut Of `extensions/worktrees.ts`

The extension entrypoint should roughly own these responsibilities:
- register `/worktrees` command family
- register `ensure_worktree` tool
- register `input` trigger behind config
- format and display results
- keep no large in-memory state

It should not own:
- git parsing details
- matching heuristics
- setup detection
- cleanup rules

Those stay in helper modules so command, tool, and trigger paths all behave the same.

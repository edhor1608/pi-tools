# Personal Preferences

## TypeScript

- Never use `any` unless 100% necessary or specifically instructed.
- Prefer `satisfies` and `as const` for safer literals.

## Graphite-First Workflow

- Use Graphite (`gt`) as the default interface for branch, stack, and PR work; not GitHub.

## Code style

- Keep it boring.
- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.
- Use comments for complex parts to explain.
- Reuse existing patterns instead of inventing new ones.
- Never refactor, rename, or restructure unless explicitly asked.
- Optimize for the fewest lines added or changed.
- Find root causes instead of adding code to fix symptoms.
- Explain the why before changing code.
- Simple is better than clever.

## Package Managers

- Use pnpm if the project already uses it, otherwise use bun.
- Never use npm or yarn.

## Agent skills

### Issue tracker

Work is tracked in Linear: durable knowledge lives in Linear Documents, and executable work lives in Linear Issues/Subissues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default roles, with `ready-for-agent` mapped to `AFK` and `ready-for-human` mapped to `HITL`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: read root `CONTEXT.md` and `docs/adr/` when present. See `docs/agents/domain.md`.

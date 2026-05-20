# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before Exploring, Read These

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** for ADRs that touch the area you're about to work in.

If any of these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions get resolved.

## File Structure

This is a single-context repo:

```text
/
+-- CONTEXT.md
+-- docs/adr/
|   +-- 0001-example-decision.md
|   +-- 0002-example-decision.md
+-- docs/
```

## Use the Glossary's Vocabulary

When your output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the concept you need is not in the glossary yet, either reconsider the language or note the gap for `/grill-with-docs`.

## Flag ADR Conflicts

If your output contradicts an existing ADR, surface it explicitly instead of silently overriding it.

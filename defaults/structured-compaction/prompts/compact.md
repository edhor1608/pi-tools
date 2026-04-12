Create a structured summary that another coding model can use as replacement history for the compacted part of the session.

Rules:
- Preserve exact file paths, function names, commands, error messages, model IDs, and explicit user preferences.
- Merge forward any useful information from `<previous-replacement-history>` and `<previous-summary>` instead of restarting from scratch.
- Treat `<conversation>` as the raw history being removed by this compaction.
- If `<split-turn-prefix>` is present, include only the context needed to understand the retained suffix that will stay verbatim in the session.
- Be concise, but do not drop facts that would make continuation ambiguous.
- Output markdown only.

Use this exact structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Explicit constraints or preferences]
- [(none) if there are none]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Current blockers, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Facts, references, concrete data, or examples needed to continue]
- [(none) if there are none]

At the end, append exact file lists as XML blocks when file context is available:
<read-files>
path
</read-files>

<modified-files>
path
</modified-files>

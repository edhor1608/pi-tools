# Model System Prompts

This directory holds model-specific system prompt append files for Pi.

The `model-system-prompt` extension from `@stead/pi-tools` appends matching files to Pi's already-built system prompt for each turn.

Implementation note:
- Pi's extension API modifies the per-turn `systemPrompt` in `before_agent_start`
- this extension appends by returning `event.systemPrompt` plus the matching fragments
- there is no separate `systemPromptAppend` return field

Resolution order:
1. `~/.pi/agent/model-system-prompts/_default.md`
2. `~/.pi/agent/model-system-prompts/<provider>/_default.md`
3. `~/.pi/agent/model-system-prompts/<provider>/<model>.md`
4. `<project>/.pi/model-system-prompts/_default.md`
5. `<project>/.pi/model-system-prompts/<provider>/_default.md`
6. `<project>/.pi/model-system-prompts/<provider>/<model>.md`

More specific files are appended later.

Current seeded files:
- `openai-codex/gpt-5.5.md`
- `openai-codex/gpt-5.4.md`
- `openai-codex/gpt-5.3-codex.md`
- `openai-codex/gpt-5.3-codex-spark.md`
- `opencode-go/kimi-k2.5.md`

File naming:
- Provider and model IDs are sanitized to `[A-Za-z0-9._-]`
- Any other character becomes `_`

Examples:
- `openai-codex/gpt-5.5.md`
- `openai-codex/gpt-5.4.md`
- `opencode-go/kimi-k2.5.md`
- `moonshot/kimi-k2.5.md`

Source policy:
- Only seed files from exact upstream prompt text when an upstream repo actually ships a dedicated prompt for that model family.
- `openai-codex/gpt-5.5.md` starts from the same GPT-5 Codex family prompt text as `openai-codex/gpt-5.4.md`, with a small wording cleanup in the file-reference rules.
- For OpenCode, `opencode-go/kimi-k2.5.md` is seeded from the exact text in OpenCode's dedicated `kimi.txt` prompt file.
- GLM, Qwen, DeepSeek, Grok, and similar families are not seeded from OpenCode for now because the inspected OpenCode repo does not ship dedicated prompt files for them; they fall back to OpenCode's generic `default.txt`, which is intentionally not used here.

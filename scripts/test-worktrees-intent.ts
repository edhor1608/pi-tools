import { compareConfidence, extractWorktreeIntent } from "../extensions/worktrees/intent.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const prUrl = extractWorktreeIntent("review https://github.com/org/repo/pull/1234");
assert(prUrl.kind === "pr", "expected PR URL to be detected as PR intent");
assert(prUrl.prNumber === 1234, "expected PR URL to extract PR number");
assert(prUrl.confidence === "very-high", "expected PR URL to trigger at very-high confidence");

const prText = extractWorktreeIntent("continue pr 77 locally");
assert(prText.kind === "pr" && prText.prNumber === 77, "expected textual PR reference to extract PR number");
assert(prText.confidence === "very-high", "expected explicit PR wording to be very-high confidence");

const issue = extractWorktreeIntent("fix ABC-123 in checkout flow");
assert(issue.kind === "issue", "expected issue key to be detected as issue intent");
assert(issue.issueKey === "ABC-123", "expected issue key to be extracted");
assert(issue.confidence === "high", "expected issue key with task language to be high confidence");

const branch = extractWorktreeIntent("stack on branch feature/checkout-cache");
assert(branch.kind === "branch", "expected stack phrasing to be detected as branch intent");
assert(branch.baseHint === "feature/checkout-cache", "expected stack phrasing to extract base hint");
assert(branch.confidence === "medium", "expected stack phrasing without explicit task verb to be medium confidence");

const create = extractWorktreeIntent("create a worktree for issue PAY-55");
assert(create.confidence === "high", "expected issue-key create prompt to stay high because issue extraction wins over generic create");

const generic = extractWorktreeIntent("explain the cache behavior in this code");
assert(generic.kind === "unknown", "expected generic prompt to stay unknown");
assert(compareConfidence(generic.confidence, "high") < 0, "expected generic prompt to stay below trigger threshold");

console.log(
	JSON.stringify(
		{
			prUrl,
			prText,
			issue,
			branch,
			create,
			generic,
		},
		null,
		2,
	),
);

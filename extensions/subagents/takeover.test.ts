import assert from "node:assert/strict";
import test from "node:test";
import { orderSubagentTree } from "./src/domain.ts";
import { reconcileDashboardSelection, type DashboardSelection } from "./src/ui/takeover.ts";

await test("subagent trees render parent-first without changing sibling order", () => {
	const ordered = orderSubagentTree([
		{ id: "root-1" },
		{ id: "root-2" },
		{ id: "child-1", parentId: "root-1" },
		{ id: "grandchild", parentId: "child-1" },
		{ id: "child-2", parentId: "root-1" },
	]);
	assert.deepEqual(
		ordered.map((entry) => entry.id),
		["root-1", "child-1", "grandchild", "child-2", "root-2"],
	);

	const orphaned = orderSubagentTree([
		{ id: "child", parentId: "orphan" },
		{ id: "orphan", parentId: "pruned" },
	]);
	assert.deepEqual(
		orphaned.map((entry) => entry.id),
		["orphan", "child"],
	);
});

await test("dashboard selection follows its subagent id and falls back by row", () => {
	const selection: DashboardSelection = { id: "sa-7", index: 6 };

	reconcileDashboardSelection(selection, [{ id: "sa-new" }, ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` }))]);
	assert.deepEqual(selection, { id: "sa-7", index: 7 });

	reconcileDashboardSelection(selection, [
		...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
		{ id: "sa-8" },
		{ id: "sa-9" },
	]);
	assert.deepEqual(selection, { id: "sa-9", index: 7 });

	reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
	assert.deepEqual(selection, { id: "sa-2", index: 1 });

	reconcileDashboardSelection(selection, []);
	// exactOptionalPropertyTypes: an empty subs list means no selectable id, so the
	// key is deleted rather than set to undefined (see reconcileDashboardSelection).
	assert.deepEqual(selection, { index: 0 });
});

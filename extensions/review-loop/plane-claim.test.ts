import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claimSubagentPlane, type PlaneHost, PLANE_KEY, releaseSubagentPlane } from "./plane-claim.ts";

void describe("plane claim ownership", () => {
	void test("first claim wins and publishes the handle", () => {
		const host: PlaneHost = {};
		const rootHandle = { root: true };
		const token = claimSubagentPlane(rootHandle, host);
		assert.notEqual(token, undefined);
		assert.equal(host[PLANE_KEY], rootHandle);
	});

	void test("a second claim (in-process child extension) never overwrites the root handle", () => {
		const host: PlaneHost = {};
		const rootHandle = { root: true };
		const childHandle = { child: true };
		const rootToken = claimSubagentPlane(rootHandle, host);
		const childToken = claimSubagentPlane(childHandle, host);
		assert.notEqual(rootToken, undefined);
		assert.equal(childToken, undefined, "child gets no ownership token");
		assert.equal(host[PLANE_KEY], rootHandle, "handle still points at the root manager");
	});

	void test("the child's shutdown (no token) does not clobber the root handle", () => {
		const host: PlaneHost = {};
		const rootHandle = { root: true };
		const rootToken = claimSubagentPlane(rootHandle, host);
		const childToken = claimSubagentPlane({ child: true }, host);
		releaseSubagentPlane(childToken, host); // child shutdown: childToken is undefined
		assert.equal(host[PLANE_KEY], rootHandle);
		// A forged foreign token must not retract either.
		releaseSubagentPlane(Symbol("forged"), host);
		assert.equal(host[PLANE_KEY], rootHandle);
		// Only the claiming instance's shutdown retracts.
		releaseSubagentPlane(rootToken, host);
		assert.equal(host[PLANE_KEY], undefined);
	});

	void test("the slot is claimable again after the owner released it", () => {
		const host: PlaneHost = {};
		const first = claimSubagentPlane({ a: 1 }, host);
		releaseSubagentPlane(first, host);
		const second = claimSubagentPlane({ b: 2 }, host);
		assert.notEqual(second, undefined);
		assert.deepEqual(host[PLANE_KEY], { b: 2 });
	});
});

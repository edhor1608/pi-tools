/**
 * Ownership-guarded publication of the shared subagent control plane.
 *
 * Pi subagent children run IN-PROCESS and load the same extensions, so a
 * child's subagents extension would otherwise overwrite
 * `globalThis[Symbol.for("pi-tools.subagent-plane.v1")]` with a handle to its
 * own hidden manager — and delete it again on the child's shutdown, leaving
 * the root review loop on a silent fallback runtime. First claim wins: the
 * root session's extension loads first and claims the slot; later instances
 * see an existing handle and never publish. Retraction requires the private
 * ownership token (a LOCAL `Symbol()`, unforgeable across instances), so a
 * child's shutdown can never clobber the root's handle.
 */

export const PLANE_KEY = Symbol.for("pi-tools.subagent-plane.v1");
const OWNER_KEY = Symbol.for("pi-tools.subagent-plane.owner.v1");

export type PlaneHost = { [PLANE_KEY]?: unknown; [OWNER_KEY]?: symbol };

/**
 * Publish `handle` if the slot is unclaimed. Returns the ownership token on
 * success, undefined when another instance already owns the slot (the caller
 * must then NOT publish and NOT retract on its own shutdown).
 */
export function claimSubagentPlane(handle: unknown, host: PlaneHost = globalThis as PlaneHost): symbol | undefined {
	if (host[PLANE_KEY] !== undefined) return undefined;
	const token = Symbol("subagent-plane-owner");
	host[PLANE_KEY] = handle;
	host[OWNER_KEY] = token;
	return token;
}

/** Retract the handle — a no-op unless `token` is the claiming instance's. */
export function releaseSubagentPlane(token: symbol | undefined, host: PlaneHost = globalThis as PlaneHost): void {
	if (token === undefined || host[OWNER_KEY] !== token) return;
	delete host[PLANE_KEY];
	delete host[OWNER_KEY];
}

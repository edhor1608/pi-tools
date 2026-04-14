/**
 * Deprecated shim.
 *
 * The workgraph planning layer now lives in ./workgraph.ts and is what the
 * package manifest loads. This file remains as a no-op so local Pi setups that
 * auto-load every file in the extensions directory do not register the old
 * workflow-todos surface alongside workgraph.
 */

export default function deprecatedWorkflowTodosShim(): void {}

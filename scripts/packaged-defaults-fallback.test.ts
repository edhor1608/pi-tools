import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePackagedDefaults } from "../extensions/shared/defaults.ts";

await test("packaged defaults tolerate a missing source root", async () => {
	const target = mkdtempSync(join(tmpdir(), "pi-packaged-defaults-"));
	await ensurePackagedDefaults("file:///tmp/pi-runtime-copy/structured-compaction/config.ts", "defaults/structured-compaction", target);
	assert.ok(existsSync(target));
});

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePackagedDefaults } from "../extensions/shared/defaults.ts";

const target = mkdtempSync(join(tmpdir(), "pi-packaged-defaults-"));

await ensurePackagedDefaults("file:///tmp/pi-runtime-copy/model-system-prompt.ts", "defaults/model-system-prompts", target);

if (!existsSync(target)) {
	throw new Error("target directory should still exist after fallback");
}

console.log(
	JSON.stringify(
		{
			target,
			fallback: true,
		},
		null,
		2,
	),
);

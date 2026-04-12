import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const copyMissingRecursive = (sourcePath: string, targetPath: string) => {
	if (!existsSync(sourcePath)) return;
	const sourceStat = statSync(sourcePath);
	if (sourceStat.isDirectory()) {
		mkdirSync(targetPath, { recursive: true });
		for (const entry of readdirSync(sourcePath)) {
			copyMissingRecursive(join(sourcePath, entry), join(targetPath, entry));
		}
		return;
	}
	if (existsSync(targetPath)) return;
	mkdirSync(dirname(targetPath), { recursive: true });
	copyFileSync(sourcePath, targetPath);
};

export const getPackageRoot = (moduleUrl: string): string => {
	let current = dirname(fileURLToPath(moduleUrl));
	while (true) {
		if (existsSync(join(current, "package.json"))) return current;
		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`Could not find package root for ${moduleUrl}`);
		}
		current = parent;
	}
};

export const ensurePackagedDefaults = (moduleUrl: string, packageRelativeSource: string, targetPath: string) => {
	const packageRoot = getPackageRoot(moduleUrl);
	copyMissingRecursive(join(packageRoot, packageRelativeSource), targetPath);
};

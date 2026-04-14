import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";

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

const findPackageRoot = (moduleUrl: string): string | undefined => {
	let current = dirname(fileURLToPath(moduleUrl));
	while (true) {
		if (existsSync(join(current, "package.json"))) return current;
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
};

export const getPackageRoot = (moduleUrl: string): string => {
	const packageRoot = findPackageRoot(moduleUrl);
	if (!packageRoot) {
		throw new Error(`Could not find package root for ${moduleUrl}`);
	}
	return packageRoot;
};

const ensuredDefaults = new Map<string, Promise<void>>();

export const ensurePackagedDefaults = (moduleUrl: string, packageRelativeSource: string, targetPath: string): Promise<void> => {
	const key = `${moduleUrl}:${packageRelativeSource}:${targetPath}`;
	const existing = ensuredDefaults.get(key);
	if (existing) return existing;

	const promise = (async () => {
		const packageRoot = findPackageRoot(moduleUrl);
		if (!packageRoot) return;
		const sourcePath = join(packageRoot, packageRelativeSource);
		if (!existsSync(sourcePath)) return;
		const lockPath = join(targetPath, ".pi-tools.defaults.lock");
		await withFileMutationQueue(lockPath, async () => {
			copyMissingRecursive(sourcePath, targetPath);
		});
	})().catch((error) => {
		ensuredDefaults.delete(key);
		throw error;
	});

	ensuredDefaults.set(key, promise);
	return promise;
};

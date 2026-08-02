#!/usr/bin/env node

import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildStructuredCompactionReport, formatStructuredCompactionReport } from "../extensions/structured-compaction/report.ts";

const sessionPath = process.argv[2];
if (sessionPath === undefined || sessionPath === "") {
	console.error("Usage: node ./scripts/analyze-session.ts <session.jsonl>");
	process.exit(1);
}

const resolvedSessionPath = resolve(sessionPath.replace(/^~\//, `${homedir()}/`));
const entries = parseSessionEntries(readFileSync(resolvedSessionPath, "utf8")) as SessionEntry[];
if (entries.length === 0) {
	console.error("Session file is empty or invalid");
	process.exit(1);
}

const leafId = entries.at(-1)?.id;
const items = buildStructuredCompactionReport(entries, leafId);
console.log(formatStructuredCompactionReport(items, { sessionFile: resolvedSessionPath }));

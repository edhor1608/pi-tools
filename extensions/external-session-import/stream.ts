import { createReadStream } from "node:fs";
import { ImportAbortedError, MAX_LINE_BYTES, type JsonlParser, type NormalizedConversation } from "./types.ts";

export const parseJsonlStream = async (filePath: string, parser: JsonlParser, signal: AbortSignal): Promise<NormalizedConversation> => {
	if (signal.aborted) throw new ImportAbortedError();

	const input = createReadStream(filePath);
	let aborted = false;
	let discarding = false;
	let lineBytes = 0;
	let lineChunks: Buffer[] = [];
	const abort = () => {
		aborted = true;
		input.destroy();
	};
	const pushLine = () => {
		const line = Buffer.concat(lineChunks, lineBytes);
		const end = line.at(-1) === 13 ? line.length - 1 : line.length;
		parser.push(line.toString("utf8", 0, end));
		lineChunks = [];
		lineBytes = 0;
	};
	signal.addEventListener("abort", abort, { once: true });

	try {
		for await (const rawChunk of input) {
			if (signal.aborted) throw new ImportAbortedError();
			const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
			let start = 0;
			while (start < chunk.length) {
				const newline = chunk.indexOf(10, start);
				const end = newline === -1 ? chunk.length : newline;
				if (!discarding && end > start) {
					const segmentBytes = end - start;
					if (lineBytes + segmentBytes > MAX_LINE_BYTES) {
						parser.skip();
						discarding = true;
						lineChunks = [];
						lineBytes = 0;
					} else {
						lineChunks.push(chunk.subarray(start, end));
						lineBytes += segmentBytes;
					}
				}
				if (newline === -1) break;
				if (discarding) {
					discarding = false;
				} else {
					pushLine();
				}
				if (signal.aborted) throw new ImportAbortedError();
				start = newline + 1;
			}
			if (signal.aborted) throw new ImportAbortedError();
		}
		if (signal.aborted) throw new ImportAbortedError();
		if (!discarding && lineBytes > 0) pushLine();
		return parser.finish();
	} catch (error) {
		if (aborted || signal.aborted || error instanceof ImportAbortedError) throw new ImportAbortedError();
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
		input.destroy();
	}
};

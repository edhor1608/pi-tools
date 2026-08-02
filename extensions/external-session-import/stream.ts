import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ImportAbortedError, MAX_LINE_BYTES, type JsonlParser, type NormalizedConversation } from "./types.ts";

export const parseJsonlStream = async (filePath: string, parser: JsonlParser, signal: AbortSignal): Promise<NormalizedConversation> => {
	if (signal.aborted) throw new ImportAbortedError();

	const input = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let aborted = false;
	const abort = () => {
		aborted = true;
		input.destroy();
	};
	signal.addEventListener("abort", abort, { once: true });

	try {
		for await (const line of lines) {
			if (signal.aborted) throw new ImportAbortedError();
			if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) parser.skip();
			else parser.push(line);
			if (signal.aborted) throw new ImportAbortedError();
		}
		if (signal.aborted) throw new ImportAbortedError();
		return parser.finish();
	} catch (error) {
		if (aborted || signal.aborted || error instanceof ImportAbortedError) throw new ImportAbortedError();
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
		lines.close();
		input.destroy();
	}
};

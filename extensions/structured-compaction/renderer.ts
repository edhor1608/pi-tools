import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	CompactionBackendOutput,
	StructuredCompactionConfig,
	StructuredCompactionInput,
} from "./types.ts";

const getRenderSummary = (output: CompactionBackendOutput): string =>
	typeof output.displaySummary === "string" ? output.displaySummary : output.summary;

interface ReplacementRenderer {
	kind: StructuredCompactionConfig["renderer"]["kind"];
	render(output: CompactionBackendOutput, input: StructuredCompactionInput, config: StructuredCompactionConfig): AgentMessage[];
}

const compactionSummaryRenderer: ReplacementRenderer = {
	kind: "compaction-summary",
	render(output, input) {
		return [
			{
				role: "compactionSummary",
				summary: getRenderSummary(output),
				tokensBefore: input.tokensBefore,
				timestamp: Date.now(),
			},
		] as AgentMessage[];
	},
};

const customMessageRenderer: ReplacementRenderer = {
	kind: "custom-message",
	render(output, _input, config) {
		return [
			{
				role: "custom",
				customType: config.renderer.customType,
				content: getRenderSummary(output),
				display: config.renderer.display,
				timestamp: Date.now(),
			},
		] as AgentMessage[];
	},
};

const RENDERERS: Record<string, ReplacementRenderer> = {
	[compactionSummaryRenderer.kind]: compactionSummaryRenderer,
	[customMessageRenderer.kind]: customMessageRenderer,
};

export const renderStructuredReplacementMessages = (
	output: CompactionBackendOutput,
	input: StructuredCompactionInput,
	config: StructuredCompactionConfig,
): AgentMessage[] => {
	const renderer = RENDERERS[config.renderer.kind];
	if (!renderer) {
		throw new Error(`Unsupported structured compaction renderer: ${config.renderer.kind}`);
	}
	return renderer.render(output, input, config);
};

import type { BackendName } from "./domain.ts";

const CLAUDE_MODEL_ALIASES = new Set(["fable", "haiku", "opus", "sonnet"]);

export interface RoutingRequest {
	readonly harness: BackendName;
	readonly model?: string;
	readonly inheritedModel?: { readonly provider: string; readonly id: string };
	readonly bareModelProviders?: ReadonlyArray<string>;
	readonly allowPaidOpencode?: boolean;
}

export type RouteResolution = { readonly backend: BackendName; readonly model: string | undefined } | { readonly error: string };

function unqualifiedModel(model: string) {
	return model.split("/").at(-1) ?? model;
}

function claudeModel(model: string) {
	const id = unqualifiedModel(model);
	const lower = id.toLowerCase();
	return /^claude(?:-|$)/.test(lower) || CLAUDE_MODEL_ALIASES.has(lower) ? id : undefined;
}

function isProviderQualified(model: string, provider: string) {
	return model.slice(0, model.indexOf("/")).toLowerCase() === provider;
}

const paidOpenCodeError = (model: string) =>
	`OpenCode model "${model}" is paid and requires explicit opt-in: use a provider-qualified "opencode/..." model and set allowPaidOpencode: true.`;

export function resolveRoute(request: RoutingRequest): RouteResolution {
	if (request.model) {
		const claude = claudeModel(request.model);
		if (claude) return { backend: "claude", model: claude };
		if (request.harness === "claude") {
			return {
				error: `Model "${request.model}" is not a Claude-family model and cannot run through the Claude backend. Use harness "pi".`,
			};
		}

		if (isProviderQualified(request.model, "opencode")) {
			return request.allowPaidOpencode ? { backend: "pi", model: request.model } : { error: paidOpenCodeError(request.model) };
		}
		if (
			!request.model.includes("/") &&
			(request.inheritedModel?.provider.toLowerCase() === "opencode" ||
				request.bareModelProviders?.some((provider) => provider.toLowerCase() === "opencode"))
		) {
			return { error: paidOpenCodeError(request.model) };
		}
		return { backend: "pi", model: request.model };
	}

	if (request.harness === "claude") return { backend: "claude", model: undefined };
	if (request.inheritedModel) {
		const claude = claudeModel(request.inheritedModel.id);
		if (claude) return { backend: "claude", model: claude };
		if (request.inheritedModel.provider.toLowerCase() === "opencode") {
			return {
				error:
					'OpenCode models are paid and cannot be inherited implicitly. Request an explicit provider-qualified model ("opencode/...") and set allowPaidOpencode: true.',
			};
		}
	}
	return { backend: "pi", model: undefined };
}

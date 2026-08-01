import type { BackendName } from "./domain.ts";

const CLAUDE_MODEL_ALIASES = new Set(["fable", "haiku", "opus", "sonnet"]);

export interface RoutingRequest {
	readonly harness: BackendName;
	readonly model?: string;
	readonly inheritedModel?: { readonly provider: string; readonly id: string };
	readonly bareModelProviders?: ReadonlyArray<string>;
	readonly allowPaidOpencode?: boolean;
	readonly nestedSpawn?: boolean;
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
	const slash = model.indexOf("/");
	return slash > 0 && model.slice(0, slash).toLowerCase() === provider.toLowerCase();
}

function paidOpenCodeError(model: string, nestedSpawn = false) {
	const qualifiedModel = isProviderQualified(model, "opencode") ? model : `opencode/${model}`;
	return nestedSpawn
		? `OpenCode model "${qualifiedModel}" is paid and unavailable for nested subagent spawns by policy.`
		: `OpenCode model "${qualifiedModel}" is paid and requires an explicit provider-qualified model: request "${qualifiedModel}" and set allowPaidOpencode: true.`;
}

function resolveBareModel(request: RoutingRequest, model: string): RouteResolution | undefined {
	if (request.bareModelProviders) {
		const providers = [...new Set(request.bareModelProviders)];
		const openCodeProviders = providers.filter((provider) => provider.toLowerCase() === "opencode");
		if (openCodeProviders.length === 0) return undefined;

		const nativeProviders = providers.filter((provider) => provider.toLowerCase() !== "opencode");
		const inheritedNative = nativeProviders.find((provider) => provider.toLowerCase() === request.inheritedModel?.provider.toLowerCase());
		const nativeProvider = inheritedNative ?? (nativeProviders.length === 1 ? nativeProviders[0] : undefined);
		if (nativeProvider) return { backend: "pi", model: `${nativeProvider}/${model}` };
		if (nativeProviders.length > 1) {
			return {
				error: `Model "${model}" is available from multiple native providers (${nativeProviders.join(", ")}). Use a provider-qualified model id.`,
			};
		}
		return { error: paidOpenCodeError(model, request.nestedSpawn) };
	}

	return request.inheritedModel?.provider.toLowerCase() === "opencode"
		? { error: paidOpenCodeError(model, request.nestedSpawn) }
		: undefined;
}

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
			if (request.nestedSpawn) return { error: paidOpenCodeError(request.model, true) };
			return request.allowPaidOpencode ? { backend: "pi", model: request.model } : { error: paidOpenCodeError(request.model) };
		}
		if (!request.model.includes("/")) {
			const bareRoute = resolveBareModel(request, request.model);
			if (bareRoute) return bareRoute;
		}
		return { backend: "pi", model: request.model };
	}

	if (request.harness === "claude") return { backend: "claude", model: undefined };
	if (request.inheritedModel) {
		const claude = claudeModel(request.inheritedModel.id);
		if (claude) return { backend: "claude", model: claude };
		if (request.inheritedModel.provider.toLowerCase() === "opencode") {
			return { error: paidOpenCodeError(request.inheritedModel.id, request.nestedSpawn) };
		}
	}
	return { backend: "pi", model: undefined };
}

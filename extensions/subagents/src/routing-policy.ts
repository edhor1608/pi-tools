import type { BackendName } from "./domain.ts";

const CLAUDE_MODEL_ALIASES = new Set(["fable", "haiku", "opus", "sonnet"]);

/** Stable rating-table keys mapped to the aliases accepted by Claude Code. */
const CLAUDE_MODEL_KEY_ALIASES = new Map<string, string>([
	["fable-5", "fable"],
	["opus-5", "opus"],
	["sonnet-5", "sonnet"],
]);

type ModelReference = { readonly provider: string; readonly id: string };

export interface RoutingRequest {
	readonly harness: BackendName;
	readonly model?: string;
	readonly inheritedModel?: ModelReference;
	readonly resolvedModel?: ModelReference;
	readonly bareModelProviders?: ReadonlyArray<string>;
	readonly userAllowsPaidOpenrouter?: boolean;
	readonly allowPaidOpenrouter?: boolean;
	readonly paidOpenrouterConfigPath?: string;
	readonly nestedSpawn?: boolean;
}

export type RouteResolution = { readonly backend: BackendName; readonly model: string | undefined } | { readonly error: string };

function claudeModel(model: string) {
	const id = model.split("/").at(-1) ?? model;
	const lower = id.toLowerCase();
	const mappedAlias = CLAUDE_MODEL_KEY_ALIASES.get(lower);
	if (mappedAlias !== undefined) return mappedAlias;
	return /^claude(?:-|$)/.test(lower) || CLAUDE_MODEL_ALIASES.has(lower) ? id : undefined;
}

function providerFromReference(model: string) {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : undefined;
}

function isPaidOpenRouterProvider(provider: string | undefined) {
	return provider?.toLowerCase() === "openrouter";
}

function isRetiredOpenCodeProvider(provider: string | undefined) {
	return provider !== undefined && /^opencode(?:$|-)/i.test(provider);
}

function canonicalModel(model: ModelReference) {
	return `${model.provider}/${model.id}`;
}

function retiredOpenCodeError(provider: string) {
	return `OpenCode provider "${provider}" is retired for subagents. Use an approved native Pi provider or explicitly opted-in OpenRouter instead.`;
}

function paidOpenRouterGateError(
	request: RoutingRequest,
	model: string,
	paidModel: ModelReference | undefined,
	providerQualified: false,
): string;
function paidOpenRouterGateError(
	request: RoutingRequest,
	model: string,
	paidModel: ModelReference | undefined,
	providerQualified: boolean,
): string | undefined;
function paidOpenRouterGateError(
	request: RoutingRequest,
	model: string,
	paidModel: ModelReference | undefined,
	providerQualified: boolean,
) {
	const literalProvider = providerFromReference(model);
	const qualifiedModel = paidModel ? canonicalModel(paidModel) : isPaidOpenRouterProvider(literalProvider) ? model : `openrouter/${model}`;
	if (request.nestedSpawn === true) {
		return `OpenRouter model "${qualifiedModel}" is paid and unavailable for nested subagent spawns by policy.`;
	}
	if (!providerQualified) {
		return `OpenRouter model "${qualifiedModel}" is paid and requires an explicit provider-qualified model such as "${qualifiedModel}".`;
	}
	if (request.userAllowsPaidOpenrouter !== true) {
		return `OpenRouter is paid and disabled; Jonas must enable allowPaidOpenrouter in ${request.paidOpenrouterConfigPath ?? "~/.pi/agent/pi-tools.json"}.`;
	}
	return request.allowPaidOpenrouter === true
		? undefined
		: `OpenRouter model "${qualifiedModel}" is paid; this spawn also requires spawn-time allowPaidOpenrouter: true.`;
}

function resolveBareModel(request: RoutingRequest, model: string): RouteResolution | undefined {
	if (request.bareModelProviders) {
		const providers = [...new Set(request.bareModelProviders)];
		const paidProviders = providers.filter(isPaidOpenRouterProvider);
		const retiredProviders = providers.filter(isRetiredOpenCodeProvider);
		if (paidProviders.length === 0 && retiredProviders.length === 0) return undefined;

		const nativeProviders = providers.filter((provider) => !isPaidOpenRouterProvider(provider) && !isRetiredOpenCodeProvider(provider));
		const inheritedNative = nativeProviders.find((provider) => provider.toLowerCase() === request.inheritedModel?.provider.toLowerCase());
		const nativeProvider = inheritedNative ?? (nativeProviders.length === 1 ? nativeProviders[0] : undefined);
		if (nativeProvider !== undefined) return { backend: "pi", model: `${nativeProvider}/${model}` };
		if (nativeProviders.length > 1) {
			return {
				error: `Model "${model}" is available from multiple native providers (${nativeProviders.join(", ")}). Use a provider-qualified model id.`,
			};
		}
		const retiredProvider = retiredProviders[0];
		if (retiredProvider !== undefined) return { error: retiredOpenCodeError(retiredProvider) };
		return {
			error: paidOpenRouterGateError(
				request,
				model,
				{
					provider: paidProviders[0] ?? "openrouter",
					id: model,
				},
				false,
			),
		};
	}

	const inheritedModel = request.inheritedModel;
	if (inheritedModel && isRetiredOpenCodeProvider(inheritedModel.provider)) {
		return { error: retiredOpenCodeError(inheritedModel.provider) };
	}
	return inheritedModel && isPaidOpenRouterProvider(inheritedModel.provider)
		? { error: paidOpenRouterGateError(request, model, inheritedModel, false) }
		: undefined;
}

export function resolveRoute(request: RoutingRequest): RouteResolution {
	if (request.model !== undefined && request.model.length > 0) {
		const literalProvider = providerFromReference(request.model);
		const resolvedModel = request.resolvedModel;
		const retiredProvider =
			resolvedModel && isRetiredOpenCodeProvider(resolvedModel.provider)
				? resolvedModel.provider
				: isRetiredOpenCodeProvider(literalProvider)
					? literalProvider
					: undefined;
		if (retiredProvider !== undefined) return { error: retiredOpenCodeError(retiredProvider) };

		const claude = claudeModel(request.model);
		if (claude !== undefined) return { backend: "claude", model: claude };
		if (request.harness === "claude") {
			return {
				error: `Model "${request.model}" is not a Claude-family model and cannot run through the Claude backend. Use harness "pi".`,
			};
		}

		if (!request.model.includes("/")) {
			const bareRoute = resolveBareModel(request, request.model);
			if (bareRoute) return bareRoute;
			if (isPaidOpenRouterProvider(request.resolvedModel?.provider)) {
				return { error: paidOpenRouterGateError(request, request.model, request.resolvedModel, false) };
			}
			return {
				backend: "pi",
				model: request.resolvedModel ? canonicalModel(request.resolvedModel) : request.model,
			};
		}

		const paidModel = isPaidOpenRouterProvider(request.resolvedModel?.provider)
			? request.resolvedModel
			: isPaidOpenRouterProvider(literalProvider)
				? { provider: literalProvider ?? "openrouter", id: request.model.slice(request.model.indexOf("/") + 1) }
				: undefined;
		if (paidModel) {
			const gateError = paidOpenRouterGateError(request, request.model, paidModel, isPaidOpenRouterProvider(literalProvider));
			return gateError !== undefined
				? { error: gateError }
				: { backend: "pi", model: request.resolvedModel ? canonicalModel(request.resolvedModel) : canonicalModel(paidModel) };
		}
		return {
			backend: "pi",
			model: request.resolvedModel ? canonicalModel(request.resolvedModel) : request.model,
		};
	}

	if (request.harness === "claude") return { backend: "claude", model: undefined };
	if (request.inheritedModel) {
		if (isRetiredOpenCodeProvider(request.inheritedModel.provider)) {
			return { error: retiredOpenCodeError(request.inheritedModel.provider) };
		}
		const claude = claudeModel(request.inheritedModel.id);
		if (claude !== undefined) return { backend: "claude", model: claude };
		const paidInherited = isPaidOpenRouterProvider(request.resolvedModel?.provider)
			? request.resolvedModel
			: isPaidOpenRouterProvider(request.inheritedModel.provider)
				? request.inheritedModel
				: undefined;
		if (paidInherited) {
			return { error: paidOpenRouterGateError(request, request.inheritedModel.id, paidInherited, false) };
		}
	}
	return { backend: "pi", model: undefined };
}

import type { BackendName } from "./domain.ts";

const CLAUDE_MODEL_ALIASES = new Set(["fable", "haiku", "opus", "sonnet"]);

type ModelReference = { readonly provider: string; readonly id: string };

export interface RoutingRequest {
	readonly harness: BackendName;
	readonly model?: string;
	readonly inheritedModel?: ModelReference;
	readonly resolvedModel?: ModelReference;
	readonly bareModelProviders?: ReadonlyArray<string>;
	readonly userAllowsPaidOpencode?: boolean;
	readonly allowPaidOpencode?: boolean;
	readonly paidOpencodeConfigPath?: string;
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

function providerFromReference(model: string) {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : undefined;
}

function isPaidOpenCodeProvider(provider: string | undefined) {
	return provider !== undefined && /^opencode(?:$|-)/i.test(provider);
}

function canonicalModel(model: ModelReference) {
	return `${model.provider}/${model.id}`;
}

function paidOpenCodeGateError(
	request: RoutingRequest,
	model: string,
	paidModel: ModelReference | undefined,
	providerQualified: false,
): string;
function paidOpenCodeGateError(
	request: RoutingRequest,
	model: string,
	paidModel: ModelReference | undefined,
	providerQualified: boolean,
): string | undefined;
function paidOpenCodeGateError(request: RoutingRequest, model: string, paidModel: ModelReference | undefined, providerQualified: boolean) {
	const literalProvider = providerFromReference(model);
	const qualifiedModel = paidModel ? canonicalModel(paidModel) : isPaidOpenCodeProvider(literalProvider) ? model : `opencode/${model}`;
	if (request.nestedSpawn) {
		return `OpenCode model "${qualifiedModel}" is paid and unavailable for nested subagent spawns by policy.`;
	}
	if (!request.userAllowsPaidOpencode) {
		return `OpenCode is paid and disabled; Jonas must enable allowPaidOpencode in ${request.paidOpencodeConfigPath ?? "~/.pi/agent/pi-tools.json"}.`;
	}
	if (!providerQualified) {
		return `OpenCode model "${qualifiedModel}" is paid and requires an explicit provider-qualified model such as "${qualifiedModel}".`;
	}
	return request.allowPaidOpencode
		? undefined
		: `OpenCode model "${qualifiedModel}" is paid; this spawn also requires spawn-time allowPaidOpencode: true.`;
}

function resolveBareModel(request: RoutingRequest, model: string): RouteResolution | undefined {
	if (request.bareModelProviders) {
		const providers = [...new Set(request.bareModelProviders)];
		const paidProviders = providers.filter(isPaidOpenCodeProvider);
		if (paidProviders.length === 0) return undefined;

		const nativeProviders = providers.filter((provider) => !isPaidOpenCodeProvider(provider));
		const inheritedNative = nativeProviders.find((provider) => provider.toLowerCase() === request.inheritedModel?.provider.toLowerCase());
		const nativeProvider = inheritedNative ?? (nativeProviders.length === 1 ? nativeProviders[0] : undefined);
		if (nativeProvider) return { backend: "pi", model: `${nativeProvider}/${model}` };
		if (nativeProviders.length > 1) {
			return {
				error: `Model "${model}" is available from multiple native providers (${nativeProviders.join(", ")}). Use a provider-qualified model id.`,
			};
		}
		return {
			error: paidOpenCodeGateError(
				request,
				model,
				{
					provider: paidProviders[0] ?? "opencode",
					id: model,
				},
				false,
			),
		};
	}

	return isPaidOpenCodeProvider(request.inheritedModel?.provider)
		? { error: paidOpenCodeGateError(request, model, request.inheritedModel, false) }
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

		if (!request.model.includes("/")) {
			const bareRoute = resolveBareModel(request, request.model);
			if (bareRoute) return bareRoute;
			if (isPaidOpenCodeProvider(request.resolvedModel?.provider)) {
				return { error: paidOpenCodeGateError(request, request.model, request.resolvedModel, false) };
			}
			return {
				backend: "pi",
				model: request.resolvedModel ? canonicalModel(request.resolvedModel) : request.model,
			};
		}

		const literalProvider = providerFromReference(request.model);
		const paidModel = isPaidOpenCodeProvider(request.resolvedModel?.provider)
			? request.resolvedModel
			: isPaidOpenCodeProvider(literalProvider)
				? { provider: literalProvider ?? "opencode", id: request.model.slice(request.model.indexOf("/") + 1) }
				: undefined;
		if (paidModel) {
			const gateError = paidOpenCodeGateError(request, request.model, paidModel, isPaidOpenCodeProvider(literalProvider));
			return gateError
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
		const claude = claudeModel(request.inheritedModel.id);
		if (claude) return { backend: "claude", model: claude };
		const paidInherited = isPaidOpenCodeProvider(request.resolvedModel?.provider)
			? request.resolvedModel
			: isPaidOpenCodeProvider(request.inheritedModel.provider)
				? request.inheritedModel
				: undefined;
		if (paidInherited) {
			return { error: paidOpenCodeGateError(request, request.inheritedModel.id, paidInherited, false) };
		}
	}
	return { backend: "pi", model: undefined };
}

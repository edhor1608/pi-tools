import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type {
	JsonValue,
	StructuredCompactionConfig,
	StructuredRemoteApi,
	StructuredRemoteAuthMode,
	StructuredRemoteReplacement,
} from "./types.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_ACCOUNT_ID_HEADER = "chatgpt-account-id";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type ResponsesSharedModule = {
	convertResponsesMessages: (
		model: Model<any>,
		context: { systemPrompt?: string; messages: AgentMessage[]; tools?: unknown },
		allowedToolCallProviders: Set<string>,
		options?: { includeSystemPrompt?: boolean },
	) => unknown[];
};

let responsesSharedModulePromise: Promise<ResponsesSharedModule> | undefined;

const resolvePackageRoot = async (specifier: string): Promise<string | undefined> => {
	let current = dirname(fileURLToPath(await import.meta.resolve(specifier)));
	for (let i = 0; i < 5; i++) {
		const packageJsonPath = join(current, "package.json");
		if (existsSync(packageJsonPath)) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
};

const resolvePackageJsonPath = async (specifier: string): Promise<string | undefined> => {
	const packageRoot = await resolvePackageRoot(specifier);
	return packageRoot ? join(packageRoot, "package.json") : undefined;
};

const resolveResponsesSharedModulePath = async (): Promise<string> => {
	const entryPath = fileURLToPath(await import.meta.resolve("@earendil-works/pi-ai"));
	const entryDir = dirname(entryPath);
	const packageRoot = await resolvePackageRoot("@earendil-works/pi-ai");
	const candidates = [
		join(entryDir, "providers", "openai-responses-shared.js"),
		join(entryDir, "api", "openai-responses-shared.js"),
		...(packageRoot
			? [
					join(packageRoot, "dist", "providers", "openai-responses-shared.js"),
					join(packageRoot, "dist", "api", "openai-responses-shared.js"),
				]
			: []),
	];
	const found = candidates.find((path) => existsSync(path));
	if (found) return found;
	throw new Error(`Unable to resolve openai-responses-shared.js. Checked: ${candidates.join(", ")}`);
};

const loadResponsesSharedModule = async (): Promise<ResponsesSharedModule> => {
	responsesSharedModulePromise ||= resolveResponsesSharedModulePath().then(
		(modulePath) => import(pathToFileURL(modulePath).href) as Promise<ResponsesSharedModule>,
	);
	return responsesSharedModulePromise;
};

const getHeader = (headers: Record<string, string> | undefined, name: string): string | undefined => {
	if (!headers) return undefined;
	const direct = headers[name];
	if (typeof direct === "string") return direct;
	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName && typeof value === "string") return value;
	}
	return undefined;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const normalizeBaseUrl = (baseUrl: string | undefined, fallback: string): string => {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : fallback;
	return raw.replace(/\/+$/, "");
};

const resolveCodexResponsesUrl = (baseUrl: string | undefined): string => {
	const normalized = normalizeBaseUrl(baseUrl, DEFAULT_CODEX_BASE_URL);
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
};

const resolveResponsesCompactEndpoint = (
	model: Model<any>,
	config: StructuredCompactionConfig,
): { endpoint: string; api: StructuredRemoteApi } => {
	const endpointMode = config.backend.remote.endpointMode;
	if (endpointMode === "codex-responses" || (endpointMode === "auto" && model.api === "openai-codex-responses")) {
		return {
			endpoint: `${resolveCodexResponsesUrl(model.baseUrl)}/compact`,
			api: "openai-codex-responses",
		};
	}
	const baseUrl = normalizeBaseUrl(model.baseUrl, DEFAULT_OPENAI_BASE_URL);
	return {
		endpoint: `${baseUrl}/responses/compact`,
		api: "openai-responses",
	};
};

const decodeJwtPayload = (token: string): Record<string, unknown> | undefined => {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const json = Buffer.from(parts[1], "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
};

const extractCodexAccountId = (token: string): string | undefined => {
	const payload = decodeJwtPayload(token);
	if (!payload) return undefined;
	const authClaim = payload[JWT_CLAIM_PATH];
	if (!isObject(authClaim)) return undefined;
	const accountId = authClaim.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
};

const buildUserAgent = async (): Promise<string> => {
	try {
		const packageJsonPath = await resolvePackageJsonPath("@earendil-works/pi-coding-agent");
		if (!packageJsonPath) return "pi-structured-compaction";
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
		const version = packageJson.version || "unknown";
		return `pi-structured-compaction/${version}`;
	} catch {
		return "pi-structured-compaction";
	}
};

const buildRemoteHeaders = async (
	model: Model<any>,
	auth: { apiKey: string; headers?: Record<string, string>; authMode: StructuredRemoteAuthMode; accountId?: string },
	config: StructuredCompactionConfig,
	sessionId: string,
	api: StructuredRemoteApi,
): Promise<Headers> => {
	const headers = new Headers();
	for (const source of [model.headers, auth.headers]) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			headers.set(key, value);
		}
	}
	headers.set("Authorization", `Bearer ${auth.apiKey}`);
	headers.set("content-type", "application/json");
	headers.set("accept", "application/json");
	if (api === "openai-codex-responses") {
		headers.set(CODEX_ACCOUNT_ID_HEADER, auth.accountId || "");
		headers.set("originator", config.backend.remote.originator);
		headers.set("OpenAI-Beta", "responses=experimental");
		headers.set("User-Agent", await buildUserAgent());
		headers.set("session_id", sessionId);
	}
	return headers;
};

const buildFriendlyError = async (response: Response): Promise<string> => {
	const text = await response.text();
	if (!text) return `Remote compaction failed with status ${response.status}`;
	try {
		const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
		return parsed.error?.message || parsed.message || text;
	} catch {
		return text;
	}
};

export const isCodexRemoteCompatibleModel = (model: Model<any> | undefined): boolean => {
	if (!model) return false;
	if (model.provider !== "openai" && model.provider !== "openai-codex") return false;
	return model.api === "openai-responses" || model.api === "openai-codex-responses";
};

export const resolveCodexRemoteAuth = async (
	ctx: ExtensionContext,
	model: Model<any>,
): Promise<{
	apiKey: string;
	headers?: Record<string, string>;
	authMode: StructuredRemoteAuthMode;
	accountId?: string;
}> => {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error("No compatible auth for codex-remote compaction");
	}
	if (model.api === "openai-codex-responses") {
		const accountId = getHeader(auth.headers, CODEX_ACCOUNT_ID_HEADER) || extractCodexAccountId(auth.apiKey);
		if (!accountId) {
			throw new Error("OpenAI Codex auth is missing chatgpt account information");
		}
		return {
			apiKey: auth.apiKey,
			headers: auth.headers,
			authMode: "codex-jwt",
			accountId,
		};
	}
	return {
		apiKey: auth.apiKey,
		headers: auth.headers,
		authMode: "api-key",
	};
};

export const convertAgentMessagesToResponsesInput = async (
	model: Model<any>,
	messages: AgentMessage[],
): Promise<unknown[]> => {
	if (messages.length === 0) return [];
	const { convertResponsesMessages } = await loadResponsesSharedModule();
	return convertResponsesMessages(
		model,
		{ systemPrompt: "", messages, tools: undefined },
		OPENAI_TOOL_CALL_PROVIDERS,
		{ includeSystemPrompt: false },
	);
};

export const normalizeRemoteOutputItemsForInput = (outputItems: JsonValue[]): JsonValue[] =>
	outputItems.map((item) => {
		if (!isObject(item)) return item;
		if (item.type !== "compaction") return item as JsonValue;
		const normalized: Record<string, JsonValue> = {
			type: "compaction",
			encrypted_content: typeof item.encrypted_content === "string" ? item.encrypted_content : "",
		};
		if (typeof item.id === "string") normalized.id = item.id;
		return normalized;
	});

export const requestCodexRemoteCompaction = async (
	ctx: ExtensionContext,
	config: StructuredCompactionConfig,
	model: Model<any>,
	instructions: string,
	inputItems: JsonValue[],
	sessionId: string,
	signal: AbortSignal,
): Promise<StructuredRemoteReplacement> => {
	const { endpoint, api } = resolveResponsesCompactEndpoint(model, config);
	const auth = await resolveCodexRemoteAuth(ctx, model);
	const promptCacheKey = sessionId;
	const headers = await buildRemoteHeaders(model, auth, config, sessionId, api);
	const reasoningEffort =
		config.backend.reasoning === "off" ? "none" : config.backend.reasoning;
	const body: Record<string, JsonValue> = {
		model: model.id,
		input: inputItems,
		instructions,
		tools: [],
		parallel_tool_calls: true,
	};
	if (api === "openai-codex-responses") {
		body.text = { verbosity: "medium" };
		if (model.reasoning) {
			body.reasoning = {
				effort: reasoningEffort,
				summary: "auto",
			};
		}
	}
	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) {
		throw new Error(await buildFriendlyError(response));
	}
	const json = (await response.json()) as { output?: JsonValue[] };
	if (!Array.isArray(json.output)) {
		throw new Error("Remote compaction response did not include output items");
	}
	return {
		strategy: "responses-compact",
		api,
		model: `${model.provider}/${model.id}`,
		endpoint,
		authMode: auth.authMode,
		sessionId,
		promptCacheKey,
		outputItems: json.output,
	};
};

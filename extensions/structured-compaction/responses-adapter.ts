import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type {
	JsonValue,
	StructuredCompactionConfig,
	StructuredRemoteApi,
	StructuredRemoteAuthMode,
	StructuredRemoteReplacement,
} from "./types.ts";

const RESPONSES_SHARED_MODULE_PATH =
	"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js";
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

const loadResponsesSharedModule = async (): Promise<ResponsesSharedModule> => {
	responsesSharedModulePromise ||= import(pathToFileURL(RESPONSES_SHARED_MODULE_PATH).href) as Promise<ResponsesSharedModule>;
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

const buildUserAgent = (): string => {
	try {
		const packageJson = JSON.parse(
			readFileSync(
				"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/package.json",
				"utf8",
			),
		) as { version?: string };
		const version = packageJson.version || "unknown";
		return `pi-structured-compaction/${version}`;
	} catch {
		return "pi-structured-compaction";
	}
};

const buildRemoteHeaders = (
	model: Model<any>,
	auth: { apiKey: string; headers?: Record<string, string>; authMode: StructuredRemoteAuthMode; accountId?: string },
	config: StructuredCompactionConfig,
	sessionId: string,
	api: StructuredRemoteApi,
): Headers => {
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
		headers.set("User-Agent", buildUserAgent());
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
	const headers = buildRemoteHeaders(model, auth, config, sessionId, api);
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

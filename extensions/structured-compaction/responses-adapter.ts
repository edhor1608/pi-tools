import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { convertResponsesMessages as ConvertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
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
const require = createRequire(import.meta.url);
let responsesConverterPromise: Promise<typeof ConvertResponsesMessages> | undefined;

const loadResponsesConverter = async (): Promise<typeof ConvertResponsesMessages> => {
	responsesConverterPromise ||= import(
		pathToFileURL(require.resolve("@earendil-works/pi-ai/api/openai-responses-shared")).href
	).then((module) => module.convertResponsesMessages as typeof ConvertResponsesMessages);
	return responsesConverterPromise;
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

const isJsonValue = (value: unknown): value is JsonValue =>
	value === null ||
	typeof value === "boolean" ||
	typeof value === "number" ||
	typeof value === "string" ||
	(Array.isArray(value) && value.every(isJsonValue)) ||
	(isObject(value) && Object.values(value).every(isJsonValue));

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
	model: Model<Api>,
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

const buildUserAgent = (): string => `pi-structured-compaction/${VERSION}`;

const buildRemoteHeaders = (
	model: Model<Api>,
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
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", randomUUID());
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

export const isCodexRemoteCompatibleModel = (model: Model<Api> | undefined): boolean => {
	if (!model) return false;
	if (model.provider !== "openai" && model.provider !== "openai-codex") return false;
	return model.api === "openai-responses" || model.api === "openai-codex-responses";
};

export const resolveCodexRemoteAuth = async (
	ctx: ExtensionContext,
	model: Model<Api>,
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
	model: Model<Api>,
	messages: AgentMessage[],
): Promise<JsonValue[]> => {
	if (messages.length === 0) return [];
	const convertResponsesMessages = await loadResponsesConverter();
	const converted: unknown = convertResponsesMessages(
		model,
		{ systemPrompt: "", messages: convertToLlm(messages), tools: undefined },
		OPENAI_TOOL_CALL_PROVIDERS,
		{ includeSystemPrompt: false },
	);
	if (!Array.isArray(converted) || !converted.every(isJsonValue)) {
		throw new Error("Responses conversion produced non-JSON input items");
	}
	return converted;
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
	model: Model<Api>,
	instructions: string,
	inputItems: JsonValue[],
	sessionId: string,
	signal: AbortSignal,
): Promise<StructuredRemoteReplacement> => {
	const { endpoint, api } = resolveResponsesCompactEndpoint(model, config);
	const auth = await resolveCodexRemoteAuth(ctx, model);
	const promptCacheKey = sessionId;
	const headers = buildRemoteHeaders(model, auth, config, sessionId, api);
	const body: Record<string, JsonValue> = {
		model: model.id,
		input: inputItems,
		instructions,
		prompt_cache_key: promptCacheKey,
	};
	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) {
		throw new Error(await buildFriendlyError(response));
	}
	const json: unknown = await response.json();
	if (!isObject(json) || !Array.isArray(json.output) || !json.output.every(isJsonValue)) {
		throw new Error("Remote compaction response did not include JSON output items");
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
		usage: isJsonValue(json.usage) ? json.usage : undefined,
	};
};

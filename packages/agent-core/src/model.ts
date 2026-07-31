import type { PromptContentPart, PromptMessage } from "./types.js";

export type OpenAITransport = "responses" | "chat_completions";
export type StructuredOutputMode = "json_schema" | "json_object" | "none";

export interface ModelGenerationRequest {
  messages: PromptMessage[];
  responseSchema?: Record<string, unknown>;
  schemaName?: string;
  model?: string;
  seed?: number;
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface ModelGenerationResponse {
  text: string;
  raw: unknown;
  requestId?: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface ModelProvider {
  generate(request: ModelGenerationRequest): Promise<ModelGenerationResponse>;
}

export interface OpenAICompatibleClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  transport?: OpenAITransport;
  structuredOutput?: StructuredOutputMode;
  timeoutMs?: number;
  headers?: Record<string, string>;
  includeSeed?: boolean;
  includeTemperature?: boolean;
  chatMaxTokensField?: "max_tokens" | "max_completion_tokens";
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

function removeTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

/**
 * Accept either an OpenAI-compatible API base URL or the full endpoint URL
 * commonly copied from a provider's documentation. The client appends the
 * endpoint itself, so leaving the copied suffix in place would otherwise send
 * requests to `/chat/completions/chat/completions`.
 */
export function normalizeOpenAIBaseUrl(value: string): string {
  return removeTrailingSlash(value.trim())
    .replace(/\/(?:chat\/completions|responses)$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const DEFAULT_MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_JSON_DEPTH = 32;
const MAX_MODEL_JSON_NODES = 20_000;
const MAX_MODEL_JSON_ARRAY_ITEMS = 5_000;
const MAX_MODEL_JSON_OBJECT_KEYS = 2_000;

/** Bound untrusted provider JSON before downstream parsers walk or clone it. */
export function assertModelJsonComplexity(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_MODEL_JSON_NODES) throw new Error("Model JSON exceeded the structural complexity limit.");
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) throw new Error("Model JSON contained a circular reference.");
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_MODEL_JSON_ARRAY_ITEMS) throw new Error("Model JSON array exceeded the item limit.");
      if (current.value.length && current.depth >= MAX_MODEL_JSON_DEPTH) throw new Error("Model JSON exceeded the nesting-depth limit.");
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }

    const entries = Object.entries(current.value as Record<string, unknown>);
    if (entries.length > MAX_MODEL_JSON_OBJECT_KEYS) throw new Error("Model JSON object exceeded the key limit.");
    if (entries.length && current.depth >= MAX_MODEL_JSON_DEPTH) throw new Error("Model JSON exceeded the nesting-depth limit.");
    for (const [key, item] of entries) {
      if (key === "__proto__") throw new Error("Model JSON contained an unsafe key.");
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
}

/** Read response bytes incrementally so platform-mode responses cannot grow without bound. */
export async function readBoundedModelResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_MODEL_RESPONSE_BYTES,
): Promise<string> {
  const limit = Number.isFinite(maxBytes) && maxBytes >= 0
    ? Math.floor(maxBytes)
    : DEFAULT_MAX_MODEL_RESPONSE_BYTES;
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && BigInt(declared) > BigInt(limit)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Model response exceeded the size limit.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Model response exceeded the size limit.");
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Keep request bodies ASCII-only. Standards-compliant JSON parsers restore
 * the original Unicode, and gateways with broken raw UTF-8 handling no longer
 * turn Chinese prompt text into question marks before model dispatch.
 */
function stringifyRequestBody(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x00-\x7F]/g, (unit) =>
    `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function responsesContent(message: PromptMessage): string | Record<string, unknown>[] {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text") {
      return {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: part.text,
      };
    }
    return {
      type: "input_image",
      image_url: part.image_url.url,
      ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
    };
  });
}

function chatContent(content: string | PromptContentPart[]): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { ...part.image_url } });
}

export function extractModelText(payload: unknown): string {
  if (!isRecord(payload)) throw new ModelProviderError("Model response was not a JSON object.");
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;

  if (Array.isArray(payload.output)) {
    const text = payload.output.flatMap((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) return [];
      return item.content.flatMap((part) => {
        if (!isRecord(part)) return [];
        if (typeof part.text === "string") return [part.text];
        if (typeof part.output_text === "string") return [part.output_text];
        return [];
      });
    }).join("");
    if (text.trim()) return text;
  }

  if (Array.isArray(payload.choices)) {
    const choice = payload.choices[0];
    if (isRecord(choice) && isRecord(choice.message)) {
      const content = choice.message.content;
      if (typeof content === "string" && content.trim()) return content;
      if (Array.isArray(content)) {
        const text = content.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("");
        if (text.trim()) return text;
      }
    }
  }
  throw new ModelProviderError("Model response did not contain output text.");
}

const LENGTH_RETRY_TOKEN_CAP = 32_000;

export class OpenAICompatibleClient implements ModelProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly transport: OpenAITransport;
  private readonly structuredOutput: StructuredOutputMode;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: OpenAICompatibleClientOptions) {
    if (!options.apiKey.trim()) throw new Error("An API key is required for OpenAICompatibleClient.");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("A Fetch API implementation is required.");
    this.baseUrl = normalizeOpenAIBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.transport = options.transport ?? "responses";
    this.structuredOutput = options.structuredOutput ?? "json_schema";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_MODEL_RESPONSE_BYTES;
  }

  async generate(request: ModelGenerationRequest): Promise<ModelGenerationResponse> {
    const model = request.model ?? this.options.model;
    if (!model) throw new Error("No model was configured for this generation request.");
    const endpoint = this.transport === "responses" ? "/responses" : "/chat/completions";
    const attempt = async (maxOutputTokens: number | undefined): Promise<ModelGenerationResponse> => {
      const effectiveRequest = maxOutputTokens === undefined ? request : { ...request, maxOutputTokens };
      const body = this.transport === "responses"
        ? this.responsesBody(model, effectiveRequest)
        : this.chatBody(model, effectiveRequest);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
            ...this.options.headers,
          },
          body: stringifyRequestBody(body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        const message = error instanceof Error && error.name === "AbortError"
          ? `Model request timed out after ${this.timeoutMs} ms.`
          : `Model request failed: ${error instanceof Error ? error.message : String(error)}`;
        throw new ModelProviderError(message);
      }

      const requestId = response.headers.get("x-request-id") ?? undefined;
      let rawText: string;
      try {
        rawText = await readBoundedModelResponseText(response, this.maxResponseBytes);
      } catch {
        throw new ModelProviderError("Model response exceeded the configured size limit or could not be read.", response.status, requestId);
      } finally {
        clearTimeout(timeout);
      }
      let payload: unknown;
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        if (!response.ok) throw new ModelProviderError(`Model returned HTTP ${response.status} with a non-JSON body.`, response.status, requestId);
        throw new ModelProviderError("Model returned a non-JSON response.", response.status, requestId);
      }
      try {
        assertModelJsonComplexity(payload);
      } catch {
        throw new ModelProviderError("Model response JSON exceeded structural complexity limits.", response.status, requestId);
      }
      if (!response.ok) {
        const providerMessage = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
          ? payload.error.message.slice(0, 500)
          : `HTTP ${response.status}`;
        throw new ModelProviderError(`Model provider rejected the request: ${providerMessage}`, response.status, requestId);
      }

      const usage = this.readUsage(payload);
      const finishReason = isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0]) && typeof payload.choices[0].finish_reason === "string"
        ? payload.choices[0].finish_reason
        : isRecord(payload) && typeof payload.status === "string"
          ? payload.status
          : undefined;
      return { text: extractModelText(payload), raw: payload, requestId, finishReason, usage };
    };

    const result = await attempt(request.maxOutputTokens);
    // 推理模型（reasoning tokens 计入 max_tokens）在复杂结构化任务中会把预算
    // 全部用于思考,finish_reason=length 时输出被截断甚至为零——上游会误报成
    // JSON 解析失败。此处自愈:预算翻倍重试一次(封顶 32K);仍截断才给出
    // 明确的截断错误,而不是让下游面对一段坏 JSON。
    if (result.finishReason === "length" && typeof request.maxOutputTokens === "number" && request.maxOutputTokens < LENGTH_RETRY_TOKEN_CAP) {
      const widened = Math.min(request.maxOutputTokens * 2, LENGTH_RETRY_TOKEN_CAP);
      const retried = await attempt(widened);
      if (retried.finishReason === "length") {
        throw new ModelProviderError(
          `Model output was truncated at ${widened} max tokens (finish_reason=length); increase the output token budget for reasoning-heavy stages.`,
          undefined,
          retried.requestId,
        );
      }
      return retried;
    }
    return result;
  }

  private responsesBody(model: string, request: ModelGenerationRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      input: request.messages.map((message) => ({ role: message.role, content: responsesContent(message) })),
      stream: false,
    };
    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    if (request.temperature !== undefined && this.options.includeTemperature !== false) body.temperature = request.temperature;
    if (request.seed !== undefined && this.options.includeSeed) body.seed = request.seed;
    if (request.metadata) body.metadata = request.metadata;
    if (request.responseSchema && this.structuredOutput === "json_schema") {
      body.text = { format: { type: "json_schema", name: request.schemaName ?? "content_package", strict: true, schema: request.responseSchema } };
    } else if (this.structuredOutput === "json_object") {
      body.text = { format: { type: "json_object" } };
    }
    return body;
  }

  private chatBody(model: string, request: ModelGenerationRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((message) => ({ role: message.role, content: chatContent(message.content) })),
      stream: false,
    };
    if (request.maxOutputTokens !== undefined) body[this.options.chatMaxTokensField ?? "max_tokens"] = request.maxOutputTokens;
    if (request.temperature !== undefined && this.options.includeTemperature !== false) body.temperature = request.temperature;
    if (request.seed !== undefined && this.options.includeSeed) body.seed = request.seed;
    if (request.responseSchema && this.structuredOutput === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: request.schemaName ?? "content_package", strict: true, schema: request.responseSchema },
      };
    } else if (this.structuredOutput === "json_object") {
      body.response_format = { type: "json_object" };
    }
    return body;
  }

  private readUsage(payload: unknown): ModelGenerationResponse["usage"] {
    if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
    const inputTokens = numeric(payload.usage.input_tokens) ?? numeric(payload.usage.prompt_tokens);
    const outputTokens = numeric(payload.usage.output_tokens) ?? numeric(payload.usage.completion_tokens);
    const totalTokens = numeric(payload.usage.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
    return { inputTokens, outputTokens, totalTokens };
  }
}

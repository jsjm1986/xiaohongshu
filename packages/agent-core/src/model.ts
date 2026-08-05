import type { PromptContentPart, PromptMessage } from "./types.js";
import { GENERATION_OUTPUT_TOKENS } from "./output-budget.js";

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
  /** Cancels the provider request and any length-retry attempt. */
  signal?: AbortSignal;
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
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    /** Physical provider requests represented by this response (2 after one length expansion). */
    modelCalls?: number;
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
  /** Provider/model output capability. Normal stages still use request.maxOutputTokens. */
  maxOutputTokenLimit?: number;
  fetch?: typeof globalThis.fetch;
}

export interface ModelResponseDiagnostics {
  /** Shape-only diagnostics. Never contains model text, prompts, credentials or headers. */
  topLevelKeys: string[];
  choiceMessageKeys?: string[];
  contentKind?: "missing" | "string" | "array" | "other";
  contentChars?: number;
  reasoningContentChars?: number;
  outputItemTypes?: string[];
  /** The client already made its single correction request for a reasoning-only response. */
  emptyOutputRecoveryAttempted?: boolean;
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    /** Explicitly separates transport retries from completed-but-invalid model responses. */
    public readonly retryable?: boolean,
    /** Preserves provider termination metadata even when no visible output was returned. */
    public readonly finishReason?: string,
    /** Usage already spent by a completed response, including a controlled length expansion. */
    public readonly usage?: ModelGenerationResponse['usage'],
    /** Safe response-shape telemetry for completed responses with no visible output. */
    public readonly responseDiagnostics?: ModelResponseDiagnostics,
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

export function modelResponseDiagnostics(payload: unknown): ModelResponseDiagnostics {
  if (!isRecord(payload)) return { topLevelKeys: [] };
  const diagnostics: ModelResponseDiagnostics = {
    topLevelKeys: Object.keys(payload).sort().slice(0, 30),
  };
  if (Array.isArray(payload.output)) {
    diagnostics.outputItemTypes = [...new Set(payload.output.flatMap((item) =>
      isRecord(item) && typeof item.type === "string" ? [item.type] : []))].slice(0, 20);
  }
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  if (message) {
    diagnostics.choiceMessageKeys = Object.keys(message).sort().slice(0, 30);
    const content = message.content;
    diagnostics.contentKind = content === undefined || content === null
      ? "missing"
      : typeof content === "string" ? "string" : Array.isArray(content) ? "array" : "other";
    diagnostics.contentChars = typeof content === "string"
      ? content.length
      : Array.isArray(content)
        ? content.reduce((sum, part) => sum + (isRecord(part) && typeof part.text === "string" ? part.text.length : 0), 0)
        : 0;
    diagnostics.reasoningContentChars = typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0;
  }
  return diagnostics;
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

const DEFAULT_LENGTH_RETRY_TOKEN_CAP = GENERATION_OUTPUT_TOKENS;

function sumOptional(left?: number, right?: number): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function mergeUsage(
  left: ModelGenerationResponse["usage"],
  right: ModelGenerationResponse["usage"],
): ModelGenerationResponse["usage"] {
  return {
    inputTokens: sumOptional(left?.inputTokens, right?.inputTokens),
    outputTokens: sumOptional(left?.outputTokens, right?.outputTokens),
    totalTokens: sumOptional(left?.totalTokens, right?.totalTokens),
    cacheHitTokens: sumOptional(left?.cacheHitTokens, right?.cacheHitTokens),
    cacheMissTokens: sumOptional(left?.cacheMissTokens, right?.cacheMissTokens),
    modelCalls: (left?.modelCalls ?? 1) + (right?.modelCalls ?? 1),
  };
}

export class OpenAICompatibleClient implements ModelProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly transport: OpenAITransport;
  private readonly structuredOutput: StructuredOutputMode;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxOutputTokenLimit: number;

  constructor(private readonly options: OpenAICompatibleClientOptions) {
    if (!options.apiKey.trim()) throw new Error("An API key is required for OpenAICompatibleClient.");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("A Fetch API implementation is required.");
    this.baseUrl = normalizeOpenAIBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.transport = options.transport ?? "responses";
    this.structuredOutput = options.structuredOutput ?? "json_schema";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_MODEL_RESPONSE_BYTES;
    this.maxOutputTokenLimit = Number.isSafeInteger(options.maxOutputTokenLimit) && (options.maxOutputTokenLimit ?? 0) > 0
      ? options.maxOutputTokenLimit!
      : DEFAULT_LENGTH_RETRY_TOKEN_CAP;
  }

  async generate(request: ModelGenerationRequest): Promise<ModelGenerationResponse> {
    const model = request.model ?? this.options.model;
    if (!model) throw new Error("No model was configured for this generation request.");
    const endpoint = this.transport === "responses" ? "/responses" : "/chat/completions";
    const attempt = async (
      maxOutputTokens: number | undefined,
      attemptRequest: ModelGenerationRequest = request,
    ): Promise<ModelGenerationResponse> => {
      const effectiveRequest = maxOutputTokens === undefined
        ? attemptRequest
        : { ...attemptRequest, maxOutputTokens };
      const body = this.transport === "responses"
        ? this.responsesBody(model, effectiveRequest)
        : this.chatBody(model, effectiveRequest);
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) abortFromCaller();
      else request.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error(`Model request timed out after ${this.timeoutMs} ms.`)), this.timeoutMs);
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
        request.signal?.removeEventListener("abort", abortFromCaller);
        const cancelled = request.signal?.aborted === true;
        const message = cancelled
          ? "Model request cancelled."
          : error instanceof Error && error.name === "AbortError"
            ? `Model request timed out after ${this.timeoutMs} ms.`
            : `Model request failed: ${error instanceof Error ? error.message : String(error)}`;
        const wrapped = new ModelProviderError(message);
        if (cancelled) wrapped.name = "AbortError";
        throw wrapped;
      }

      const requestId = response.headers.get("x-request-id") ?? undefined;
      let rawText: string;
      try {
        rawText = await readBoundedModelResponseText(response, this.maxResponseBytes);
      } catch {
        throw new ModelProviderError(
          "Model response exceeded the configured size limit or could not be read.",
          response.status,
          requestId,
          response.status === 429 || response.status >= 500,
        );
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abortFromCaller);
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
      // Read termination metadata before requiring visible text. Reasoning models can
      // consume the whole output budget and return finish_reason=length with an empty
      // content field. That is one controlled length retry, not a transport outage.
      let text = "";
      try {
        text = extractModelText(payload);
      } catch (error) {
        if (error instanceof ModelProviderError && /did not contain output text/iu.test(error.message)) {
          // Preserve the completed response metadata below; generate() decides whether
          // this is the single controlled length expansion or a terminal empty output.
        } else if (error instanceof ModelProviderError) {
          throw new ModelProviderError(error.message, response.status, requestId, false, finishReason, undefined, modelResponseDiagnostics(payload));
        } else {
          throw error;
        }
      }
      return { text, raw: payload, requestId, finishReason, usage: { ...usage, modelCalls: 1 } };
    };

    const isLengthFinish = (value?: string): boolean => value === "length" || value === "max_output_tokens";
    const isReasoningOnlyStop = (result: ModelGenerationResponse): boolean => {
      if (result.finishReason !== "stop" || result.text.trim()) return false;
      const diagnostics = modelResponseDiagnostics(result.raw);
      return (diagnostics.contentKind === "missing" || diagnostics.contentChars === 0)
        && (diagnostics.reasoningContentChars ?? 0) > 0;
    };
    const incompleteOutputError = (tokens: number | undefined, result: ModelGenerationResponse): ModelProviderError =>
      new ModelProviderError(
        isLengthFinish(result.finishReason)
          ? `Model output was truncated${tokens ? ` at ${tokens} max tokens` : ""} (finish_reason=${result.finishReason}); increase the output token budget for this reasoning-heavy stage.`
          : "Model response did not contain output text.",
        200,
        result.requestId,
        false,
        result.finishReason,
        result.usage,
        modelResponseDiagnostics(result.raw),
      );

    const result = await attempt(request.maxOutputTokens);
    // A 1M context window is an input capacity. Reasoning output still has its own
    // budget. When that budget is exhausted, widen exactly once to the declared model capability; never
    // hand the result to the outer six-attempt transport retry loop.
    if (isLengthFinish(result.finishReason)) {
      if (typeof request.maxOutputTokens !== "number" || request.maxOutputTokens >= this.maxOutputTokenLimit) {
        throw incompleteOutputError(request.maxOutputTokens, result);
      }
      // One deliberate jump to the declared provider capability. Do not walk through
      // 8K→16K→32K and do not hand truncation to the outer transport retry loop.
      const widened = this.maxOutputTokenLimit;
      const retried = await attempt(widened);
      const combinedUsage = mergeUsage(result.usage, retried.usage);
      if (isLengthFinish(retried.finishReason) || !retried.text.trim()) {
        throw incompleteOutputError(widened, { ...retried, usage: combinedUsage });
      }
      return { ...retried, usage: combinedUsage };
    }
    if (isReasoningOnlyStop(result)) {
      // Some reasoning-compatible gateways occasionally return only private reasoning
      // and then stop normally. Retry the same frozen task once with an appended delivery
      // instruction. The original prompt remains an exact prefix for provider caching,
      // and private reasoning is neither persisted nor sent back to the model.
      const requiresJson = this.structuredOutput === "json_object"
        || (this.structuredOutput === "json_schema" && request.responseSchema !== undefined);
      const recoveryRequest: ModelGenerationRequest = {
        ...request,
        messages: [
          ...request.messages,
          {
            role: "user",
            content: requiresJson
              ? "The previous attempt stopped after internal reasoning without a visible answer. Return only the final answer now, following the required JSON structure exactly. Do not include reasoning or explanation."
              : "The previous attempt stopped after internal reasoning without a visible answer. Return only the final answer now. Do not include reasoning or explanation.",
          },
        ],
        ...(typeof request.seed === "number" ? { seed: request.seed + 1 } : {}),
        ...(typeof request.temperature === "number" ? { temperature: Math.min(request.temperature, 0.35) } : {}),
      };
      const recovered = await attempt(request.maxOutputTokens, recoveryRequest);
      const combinedUsage = mergeUsage(result.usage, recovered.usage);
      if (!recovered.text.trim() || isLengthFinish(recovered.finishReason)) {
        const diagnostics = modelResponseDiagnostics(recovered.raw);
        diagnostics.emptyOutputRecoveryAttempted = true;
        throw new ModelProviderError(
          isLengthFinish(recovered.finishReason)
            ? `Model output was truncated${request.maxOutputTokens ? ` at ${request.maxOutputTokens} max tokens` : ""} (finish_reason=${recovered.finishReason}) after empty-output recovery.`
            : "Model response did not contain output text after one empty-output recovery attempt.",
          200,
          recovered.requestId,
          false,
          recovered.finishReason,
          combinedUsage,
          diagnostics,
        );
      }
      return { ...recovered, usage: combinedUsage };
    }
    if (!result.text.trim()) throw incompleteOutputError(request.maxOutputTokens, result);
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
    const promptDetails = isRecord(payload.usage.prompt_tokens_details) ? payload.usage.prompt_tokens_details : undefined;
    const cacheHitTokens = numeric(payload.usage.prompt_cache_hit_tokens) ?? numeric(promptDetails?.cached_tokens);
    const cacheMissTokens = numeric(payload.usage.prompt_cache_miss_tokens);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
      && cacheHitTokens === undefined && cacheMissTokens === undefined) return undefined;
    return { inputTokens, outputTokens, totalTokens, cacheHitTokens, cacheMissTokens, modelCalls: 1 };
  }
}

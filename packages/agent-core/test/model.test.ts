import { describe, expect, it, vi } from "vitest";

import {
  extractModelText,
  ModelProviderError,
  normalizeOpenAIBaseUrl,
  OpenAICompatibleClient,
} from "../src/index.js";

const messages = [{ role: "user" as const, content: "return json" }];

describe("OpenAI-compatible client", () => {
  it("uses JSON Unicode escapes for non-ASCII prompts", async () => {
    let requestBody = "";
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
      }), { status: 200 });
    });
    const client = new OpenAICompatibleClient({
      apiKey: "secret",
      model: "chat-model",
      transport: "chat_completions",
      structuredOutput: "json_object",
      fetch,
    });

    await client.generate({ messages: [{ role: "user", content: "返回中文 JSON" }] });

    expect(requestBody).not.toContain("返回中文");
    expect(requestBody).toContain("\\u8fd4\\u56de\\u4e2d\\u6587");
    expect(JSON.parse(requestBody).messages[0].content).toBe("返回中文 JSON");
  });

  it("uses Responses API by default and reads output_text", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "configured-model", input: messages, max_output_tokens: 300, stream: false });
      expect(body.text.format).toMatchObject({ type: "json_schema", name: "draft", strict: true });
      expect(body.seed).toBeUndefined();
      return new Response(JSON.stringify({ output_text: "{\"ok\":true}", usage: { input_tokens: 10, output_tokens: 3 }, status: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_1" },
      });
    });
    const client = new OpenAICompatibleClient({ apiKey: "secret", model: "configured-model", fetch });
    const result = await client.generate({ messages, responseSchema: { type: "object" }, schemaName: "draft", maxOutputTokens: 300, seed: 42 });
    expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.any(Object));
    expect(result).toMatchObject({ text: "{\"ok\":true}", requestId: "req_1", finishReason: "completed", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } });
  });

  it("supports Chat Completions and compatible seed opt-in", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "chat-model", messages, seed: 7, max_completion_tokens: 99, stream: false });
      expect(body.response_format.json_schema.name).toBe("content_package");
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"candidate\":1}" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }), { status: 200 });
    });
    const client = new OpenAICompatibleClient({
      apiKey: "secret",
      model: "chat-model",
      baseUrl: "https://compatible.example/v1/",
      transport: "chat_completions",
      includeSeed: true,
      chatMaxTokensField: "max_completion_tokens",
      fetch,
    });
    const result = await client.generate({ messages, responseSchema: { type: "object" }, seed: 7, maxOutputTokens: 99 });
    expect(fetch).toHaveBeenCalledWith("https://compatible.example/v1/chat/completions", expect.any(Object));
    expect(result.text).toBe("{\"candidate\":1}");
    expect(result.usage?.totalTokens).toBe(10);
  });

  it("accepts a copied full compatible endpoint without duplicating its path", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
    }), { status: 200 }));
    const client = new OpenAICompatibleClient({
      apiKey: "secret",
      model: "chat-model",
      baseUrl: " https://compatible.example/v1/chat/completions/ ",
      transport: "chat_completions",
      fetch,
    });

    await client.generate({ messages });

    expect(normalizeOpenAIBaseUrl("https://compatible.example/v1/responses/")).toBe("https://compatible.example/v1");
    expect(fetch).toHaveBeenCalledWith("https://compatible.example/v1/chat/completions", expect.any(Object));
  });

  it("maps canonical multimodal parts to Responses input content and keeps the raw body ASCII-safe", async () => {
    let rawBody = "";
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      rawBody = String(init?.body ?? "");
      const body = JSON.parse(rawBody);
      expect(body.input[0].content).toEqual([
        { type: "input_text", text: "分析图片中的中文" },
        { type: "input_image", image_url: "https://example.test/示例.png", detail: "high" },
      ]);
      return new Response(JSON.stringify({ output_text: "{}" }), { status: 200 });
    });
    const client = new OpenAICompatibleClient({ apiKey: "secret", model: "vision-model", fetch });
    await client.generate({ messages: [{ role: "user", content: [
      { type: "text", text: "分析图片中的中文" },
      { type: "image_url", image_url: { url: "https://example.test/示例.png", detail: "high" } },
    ] }] });
    expect(rawBody).not.toMatch(/[^\x00-\x7F]/u);
    expect(rawBody).not.toContain("中文");
  });

  it("maps canonical multimodal parts to Chat Completions content", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toEqual([
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
      ]);
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    });
    const client = new OpenAICompatibleClient({
      apiKey: "secret",
      model: "vision-model",
      transport: "chat_completions",
      fetch,
    });
    await client.generate({ messages: [{ role: "user", content: [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
    ] }] });
  });

  it("extracts nested Responses content and chat content arrays", () => {
    expect(extractModelText({ output: [{ content: [{ type: "output_text", text: "one" }, { type: "output_text", text: "two" }] }] })).toBe("onetwo");
    expect(extractModelText({ choices: [{ message: { content: [{ type: "text", text: "chat" }] } }] })).toBe("chat");
  });

  it("requires a model at request or client level", async () => {
    const client = new OpenAICompatibleClient({ apiKey: "secret", fetch: vi.fn() as unknown as typeof fetch });
    await expect(client.generate({ messages })).rejects.toThrow(/No model/u);
  });

  it("surfaces sanitized provider errors without credentials", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad schema" } }), { status: 400, headers: { "x-request-id": "req_bad" } }));
    const client = new OpenAICompatibleClient({ apiKey: "top-secret", model: "m", fetch });
    const promise = client.generate({ messages });
    await expect(promise).rejects.toBeInstanceOf(ModelProviderError);
    await expect(promise).rejects.not.toThrow(/top-secret/u);
  });

  it("aborts an in-flight provider request from the caller signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (observedSignal?.aborted) onAbort();
        else observedSignal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    const client = new OpenAICompatibleClient({ apiKey: "secret", model: "m", fetch, timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = client.generate({ messages, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Model request cancelled." });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects provider responses that exceed the configured byte limit", async () => {
    const fetch = vi.fn(async () => new Response("123456"));
    const client = new OpenAICompatibleClient({
      apiKey: "secret",
      model: "m",
      maxResponseBytes: 5,
      fetch,
    });
    await expect(client.generate({ messages })).rejects.toThrow(/size limit/u);
  });

  it("rejects provider JSON that exceeds structural complexity limits", async () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 34; index += 1) deep = { nested: deep };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ output_text: "{}", deep })));
    const client = new OpenAICompatibleClient({ apiKey: "secret", model: "m", fetch });
    await expect(client.generate({ messages })).rejects.toThrow(/structural complexity/u);
  });
});

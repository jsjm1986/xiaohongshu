import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { ModelProvider } from '@content-agent/agent-core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import type { ApiOptionsInput } from '../src/config.js';
import { GenerationService } from '../src/generation.service.js';
import { modelOutputTokenLimit, type ResolvedProviderSettings } from '../src/settings.service.js';

const ADMIN_PASSWORD = 'Config-integration-admin-123!';

async function withApplication<T>(
  input: ApiOptionsInput,
  run: (app: NestExpressApplication, baseUrl: string) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-config-'));
  let app: NestExpressApplication | undefined;
  try {
    app = await createApplication({
      dataDir,
      adminUsername: 'admin',
      adminPassword: ADMIN_PASSWORD,
      masterEncryptionKey: 'config-integration-master-key',
      platformApiKey: '',
      logger: false,
      ...input,
    });
    await app.listen(0, '127.0.0.1');
    return await run(app, await app.getUrl());
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function login(baseUrl: string): Promise<Response> {
  return fetch(new URL('/api/auth/login', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
}

function cookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  assert.ok(value, `missing ${name} Set-Cookie header`);
  return value;
}

test('production login emits HSTS and Secure session and CSRF cookies by default', async () => {
  await withApplication({ production: true }, async (_app, baseUrl) => {
    const response = await login(baseUrl);
    assert.equal(response.status, 201);
    assert.equal(
      response.headers.get('strict-transport-security'),
      'max-age=31536000; includeSubDomains',
    );
    assert.match(cookie(response, 'ca_session'), /;\s*Secure(?:;|$)/iu);
    assert.match(cookie(response, 'ca_csrf'), /;\s*Secure(?:;|$)/iu);
  });
});

test('explicit insecure-cookie mode leaves HSTS enabled for a production proxy', async () => {
  await withApplication(
    { production: true, secureCookies: false },
    async (_app, baseUrl) => {
      const response = await login(baseUrl);
      assert.equal(response.status, 201);
      assert.equal(
        response.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains',
      );
      assert.doesNotMatch(cookie(response, 'ca_session'), /;\s*Secure(?:;|$)/iu);
      assert.doesNotMatch(cookie(response, 'ca_csrf'), /;\s*Secure(?:;|$)/iu);
    },
  );
});



test('DeepSeek output capability is 384K while other models use the 64K standard budget', () => {
  assert.equal(modelOutputTokenLimit({ provider: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://gateway.example' }), 384_000);
  assert.equal(modelOutputTokenLimit({ provider: 'custom', model: 'alias', baseUrl: 'https://api.deepseek.com' }), 384_000);
  assert.equal(modelOutputTokenLimit({ provider: 'openai', model: 'gpt-compatible', baseUrl: 'https://api.example.com' }), 64_000);
});
test('GenerationService passes configured retry attempts and delay to the real model client', async () => {
  const requestTimes: number[] = [];
  const requestPaths: string[] = [];
  const server = createServer((request, response) => {
    requestTimes.push(Date.now());
    requestPaths.push(request.url ?? '');
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (requestTimes.length === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: 'temporary outage' } }));
      return;
    }
    response.end(JSON.stringify({ output_text: JSON.stringify({ ok: true }) }));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    const port = (server.address() as AddressInfo).port;
    await withApplication({
      platformApiKey: 'integration-api-key',
      platformBaseUrl: `http://127.0.0.1:${port}/v1`,
      platformModel: 'integration-model',
      platformTransport: 'responses',
      modelRetryAttempts: 2,
      modelRetryBaseDelayMs: 120,
      modelMaxConcurrentRequests: 1,
    }, async (app) => {
      const service = app.get(GenerationService);
      const factory = service as unknown as {
        modelProvider(settings: ResolvedProviderSettings): ModelProvider | undefined;
      };
      const provider = factory.modelProvider({
        mode: 'platform',
        provider: 'openai',
        model: 'integration-model',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        transport: 'responses',
        apiKey: 'integration-api-key',
        temperature: 0,
      });
      assert.ok(provider);
      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Return JSON.' }],
      });
      assert.equal(result.text, JSON.stringify({ ok: true }));
    });

    assert.deepEqual(requestPaths, ['/v1/responses', '/v1/responses']);
    assert.equal(requestTimes.length, 2);
    const retryDelay = requestTimes[1]! - requestTimes[0]!;
    assert.ok(retryDelay >= 80, `retry delay ${retryDelay}ms ignored configured base delay`);
    assert.ok(retryDelay < 2_000, `retry delay ${retryDelay}ms used an unexpected default`);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});


test('GenerationService records sanitized per-stage token and cache usage', async () => {
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      output_text: '{"ok":true}',
      status: 'completed',
      usage: {
        input_tokens: 1_000,
        output_tokens: 40,
        total_tokens: 1_040,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
      },
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    const port = (server.address() as AddressInfo).port;
    await withApplication({
      platformApiKey: 'integration-api-key',
      platformBaseUrl: `http://127.0.0.1:${port}/v1`,
      platformModel: 'deepseek-v4-flash',
      platformTransport: 'responses',
      modelRetryAttempts: 1,
    }, async (app) => {
      const service = app.get(GenerationService) as unknown as {
        modelProvider(settings: ResolvedProviderSettings, usageJobId?: string): ModelProvider | undefined;
        event(jobId: string, event: string, details: Record<string, unknown>): void;
      };
      const captured: Array<{ jobId: string; event: string; details: Record<string, unknown> }> = [];
      service.event = (jobId, event, details) => { captured.push({ jobId, event, details }); };
      const provider = service.modelProvider({
        mode: 'platform', provider: 'deepseek', model: 'deepseek-v4-flash',
        baseUrl: `http://127.0.0.1:${port}/v1`, transport: 'responses',
        apiKey: 'integration-api-key', temperature: 0, configVersion: 'v1',
      }, 'usage-job');
      assert.ok(provider);
      await provider.generate({
        messages: [{ role: 'user', content: 'secret prompt text' }],
        maxOutputTokens: 8_000,
        metadata: { purpose: 'generate_core', candidateIndex: 2, stage: 1 },
      });
      assert.equal(captured.length, 3);
      assert.deepEqual(captured.map((item) => item.event), [
        'model_stage_started', 'model_provider_attempt', 'model_usage',
      ]);
      assert.ok(captured.every((item) => item.jobId === 'usage-job'));
      const started = captured[0]!.details;
      const providerAttempt = captured[1]!.details;
      const usage = captured[2]!.details;
      assert.equal(typeof started.callId, 'string');
      assert.equal(providerAttempt.callId, started.callId);
      assert.equal(usage.callId, started.callId);
      assert.deepEqual(started, {
        callId: started.callId,
        purpose: 'generate_core', candidateIndex: 2, stage: 1, attempt: undefined, identity: undefined,
        messageCount: 1, textParts: 1, textChars: 18, imageCount: 0,
        schemaName: undefined, schemaChars: 0,
        estimatedInputTokens: started.estimatedInputTokens,
        requestedMaxOutputTokens: 8_000,
      });
      assert.equal(typeof started.estimatedInputTokens, 'number');
      assert.ok(Number(started.estimatedInputTokens) > 0);
      assert.deepEqual(providerAttempt, {
        callId: started.callId,
        purpose: 'generate_core', candidateIndex: 2, stage: 1, attempt: undefined, identity: undefined,
        providerAttempt: 1, maxAttempts: 1, outcome: 'completed',
        elapsedMs: providerAttempt.elapsedMs, providerRequests: 1, willRetry: false,
      });
      assert.deepEqual(usage, {
        callId: started.callId,
        purpose: 'generate_core', candidateIndex: 2, stage: 1, attempt: undefined, identity: undefined,
        outcome: 'completed', elapsedMs: usage.elapsedMs,
        messageCount: 1, textParts: 1, textChars: 18, imageCount: 0,
        schemaName: undefined, schemaChars: 0,
        estimatedInputTokens: started.estimatedInputTokens,
        requestedMaxOutputTokens: 8_000, providerRequests: 1,
        inputTokens: 1_000, outputTokens: 40, totalTokens: 1_040,
        cacheHitTokens: 800, cacheMissTokens: 200, cacheRate: 0.8,
        finishReason: 'completed', status: undefined, retryable: undefined, failureKind: undefined,
      });
      const serialized = JSON.stringify(captured);
      assert.ok(!serialized.includes('secret prompt text'));
      assert.ok(!serialized.includes('integration-api-key'));
      assert.ok(!serialized.includes('{"ok":true}'));
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

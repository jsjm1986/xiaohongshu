import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import type { SessionPrincipal } from '../src/models.js';
import type { ResolvedProviderSettings } from '../src/settings.service.js';

const PASSWORD = 'Analysis-resilience-bootstrap-123!';
const NEW_PASSWORD = 'Analysis-resilience-updated-456!';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withApp<T>(
  modelServer: Server,
  options: { modelRetryAttempts?: number; modelRetryBaseDelayMs?: number } = {},
  run: (input: {
    app: NestExpressApplication;
    service: IntelligenceService;
    projectId: string;
    principal: SessionPrincipal;
    modelBaseUrl: string;
  }) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-analysis-resilience-'));
  const port = await listen(modelServer);
  let app: NestExpressApplication | undefined;
  try {
    app = await createApplication({
      dataDir,
      adminUsername: 'admin',
      adminPassword: PASSWORD,
      masterEncryptionKey: 'analysis-resilience-master-key',
      platformApiKey: 'platform-secret-that-must-not-be-logged',
      platformBaseUrl: `http://127.0.0.1:${port}/v1`,
      platformModel: 'analysis-test-model',
      platformTransport: 'chat_completions',
      modelRetryAttempts: options.modelRetryAttempts ?? 2,
      modelRetryBaseDelayMs: options.modelRetryBaseDelayMs ?? 0,
      logger: false,
    });
    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();
    let cookie = '';
    let csrf = '';
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      if (csrf && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('x-csrf-token', csrf);
      if (typeof init.body === 'string') headers.set('content-type', 'application/json');
      const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
      const body = await response.json().catch(() => ({})) as Record<string, any>;
      return { response, body };
    };
    const login = await request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
    csrf = login.body.csrfToken;
    await request('/api/auth/change-password', {
      method: 'POST', body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    });
    const project = await request('/api/projects', {
      method: 'POST', body: JSON.stringify({ name: '分析韧性测试项目' }),
    });
    assert.equal(project.response.status, 201, JSON.stringify(project.body));
    const principal: SessionPrincipal = {
      kind: 'session', userId: login.body.user.id, username: 'admin', systemRole: 'admin',
      userKind: 'research', mustChangePassword: false, tokenHash: '', csrfHash: '',
    };
    return await run({
      app,
      service: app.get(IntelligenceService),
      projectId: String(project.body.id),
      principal,
      modelBaseUrl: `http://127.0.0.1:${port}/v1`,
    });
  } finally {
    await app?.close();
    await close(modelServer);
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function bodyOf(request: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
}

test('分析输出在 16K 截断时自动扩容到 32K，且诊断日志不含提示词、密钥或响应正文', async () => {
  const budgets: number[] = [];
  const secretPrompt = 'SECRET_PROMPT_MUST_NOT_APPEAR_IN_LOGS';
  const secretResponse = 'SECRET_RESPONSE_MUST_NOT_APPEAR_IN_LOGS';
  let call = 0;
  const server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    budgets.push(Number(body.max_tokens));
    call += 1;
    response.setHeader('content-type', 'application/json');
    if (call === 1) {
      response.end(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: secretResponse } }],
        usage: { prompt_tokens: 100, completion_tokens: 16_000, completion_tokens_details: { reasoning_tokens: 15_900 } },
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ok: true }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 10 } },
    }));
  });

  await withApp(server, {}, async ({ service, modelBaseUrl }) => {
    const logs: string[] = [];
    (service as any).logger = {
      log: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    };
    const settings: ResolvedProviderSettings = {
      mode: 'platform', provider: 'openai', model: 'analysis-test-model', baseUrl: modelBaseUrl,
      transport: 'chat_completions', apiKey: 'platform-secret-that-must-not-be-logged', temperature: 0,
    };
    const result = await (service as any).callAnalysisModel(
      settings, secretPrompt, [], 0, { taskId: 'task-safe-log', stage: 'project-blueprint', attempt: 1 },
    );
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(budgets, [16_000, 32_000]);
    const joined = logs.join('\n');
    assert.match(joined, /analysis_output_budget_expanded/u);
    assert.match(joined, /project-blueprint/u);
    assert.match(joined, /reasoningTokens/u);
    assert.doesNotMatch(joined, new RegExp(secretPrompt));
    assert.doesNotMatch(joined, new RegExp(secretResponse));
    assert.doesNotMatch(joined, /platform-secret-that-must-not-be-logged/u);
    assert.doesNotMatch(joined, /analysis-test-model|127\.0\.0\.1/u);
  });
});

test('分析重试次数和指数退避读取统一配置，HTTP 200 的不完整 JSON 也会重试', async () => {
  const requestTimes: number[] = [];
  let call = 0;
  const server = createServer(async (request, response) => {
    await bodyOf(request);
    requestTimes.push(Date.now());
    call += 1;
    response.setHeader('content-type', 'application/json');
    if (call === 1) {
      response.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '{"broken":' } }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ recovered: true }) } }],
    }));
  });

  await withApp(server, { modelRetryAttempts: 2, modelRetryBaseDelayMs: 90 }, async ({ service, projectId, principal }) => {
    const result = await service.runEnrichmentModel(projectId, principal, 'return JSON', 'draft');
    assert.deepEqual(result, { recovered: true });
    assert.equal(requestTimes.length, 2);
    const delay = requestTimes[1]! - requestTimes[0]!;
    assert.ok(delay >= 70, `configured retry delay was ignored: ${delay}ms`);
    assert.ok(delay < 2_000, `unexpected retry delay: ${delay}ms`);
  });
});

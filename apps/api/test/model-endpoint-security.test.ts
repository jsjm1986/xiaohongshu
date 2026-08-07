import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ModelProvider } from '@content-agent/agent-core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Dispatcher } from 'undici';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import {
  createPinnedConnector,
  createSafeModelFetch,
  validateByokBaseUrl,
  type PinnedModelTarget,
  type SafeModelDispatcher,
} from '../src/safe-model-fetch.js';
import { SettingsService, type ResolvedProviderSettings } from '../src/settings.service.js';

const PUBLIC_V4 = '8.8.8.8';

test('BYOK Base URL 默认只接受无凭据、查询和片段的公网 HTTPS', () => {
  assert.equal(validateByokBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');

  for (const value of [
    'http://api.example.com/v1',
    'ftp://api.example.com/v1',
    'https://user:secret@api.example.com/v1',
    'https://api.example.com/v1?token=secret',
    'https://api.example.com/v1?',
    'https://api.example.com/v1#fragment',
    'https://api.example.com/v1#',
    'https://localhost/v1',
    'https://sub.localhost./v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/v1',
    'https://[::1]/v1',
    'https://[fc00::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
  ]) {
    assert.throws(() => validateByokBaseUrl(value), undefined, value);
  }
});

test('明文 HTTP 与私网访问必须分别显式开启', () => {
  assert.equal(
    validateByokBaseUrl('http://api.example.com/v1', { allowHttp: true }),
    'http://api.example.com/v1',
  );
  assert.equal(
    validateByokBaseUrl('https://127.0.0.1:8443/v1', { allowPrivateNetwork: true }),
    'https://127.0.0.1:8443/v1',
  );
  assert.throws(() => validateByokBaseUrl('http://127.0.0.1/v1', { allowHttp: true }));
  assert.throws(() => validateByokBaseUrl('http://127.0.0.1/v1', { allowPrivateNetwork: true }));
});

test('DNS 解析失败、空结果、混合私网结果和 IPv4-mapped IPv6 均在发请求前拒绝', async () => {
  const cases = [
    async () => { throw new Error('dns unavailable'); },
    async () => [],
    async () => [{ address: PUBLIC_V4, family: 4 }, { address: '127.0.0.1', family: 4 }],
    async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
  ];

  for (const lookup of cases) {
    let requests = 0;
    const safeFetch = createSafeModelFetch({
      lookup,
      transportFetch: async () => { requests += 1; return new Response('unexpected'); },
      dispatcherFactory: fakeDispatcherFactory(),
    });
    await assert.rejects(() => safeFetch('https://api.example.com/v1/responses'));
    assert.equal(requests, 0);
  }
});


test('Clash fake-IP compatibility is off by default and narrowly scoped', async () => {
  const fakeIp = '198.18.0.42';
  const targets: PinnedModelTarget[] = [];
  let requests = 0;

  const blockedByDefault = createSafeModelFetch({
    lookup: async () => [{ address: fakeIp, family: 4 }],
    dispatcherFactory: fakeDispatcherFactory(),
    transportFetch: async () => { requests += 1; return new Response('unexpected'); },
  });
  await assert.rejects(() => blockedByDefault('https://api.example.com/v1'));
  assert.equal(requests, 0);

  const allowed = createSafeModelFetch({
    allowProxyFakeIp: true,
    lookup: async () => [{ address: fakeIp, family: 4 }],
    dispatcherFactory: (target) => {
      targets.push(target);
      return { dispatcher: {} as Dispatcher, close: async () => undefined };
    },
    transportFetch: async () => { requests += 1; return new Response('ok'); },
  });
  assert.equal(await (await allowed('https://api.example.com/v1')).text(), 'ok');
  assert.equal(requests, 1);
  assert.equal(targets[0]?.address, fakeIp);
  assert.equal(targets[0]?.hostname, 'api.example.com');

  for (const url of ['https://198.18.0.42/v1', 'https://127.0.0.1/v1']) {
    await assert.rejects(() => allowed(url), undefined, url);
  }

  const httpFakeIp = createSafeModelFetch({
    allowHttp: true,
    allowProxyFakeIp: true,
    lookup: async () => [{ address: fakeIp, family: 4 }],
    dispatcherFactory: fakeDispatcherFactory(),
    transportFetch: async () => new Response('unexpected'),
  });
  await assert.rejects(() => httpFakeIp('http://api.example.com/v1'));

  for (const answers of [
    [{ address: '10.0.0.8', family: 4 }],
    [{ address: fakeIp, family: 4 }, { address: PUBLIC_V4, family: 4 }],
    [{ address: fakeIp, family: 4 }, { address: '127.0.0.1', family: 4 }],
  ]) {
    const guarded = createSafeModelFetch({
      allowProxyFakeIp: true,
      lookup: async () => answers,
      dispatcherFactory: fakeDispatcherFactory(),
      transportFetch: async () => new Response('unexpected'),
    });
    await assert.rejects(() => guarded('https://api.example.com/v1'));
  }
});

test('已验证的 DNS 地址传给固定连接 dispatcher，并在请求完成后关闭', async () => {
  const targets: PinnedModelTarget[] = [];
  let closed = 0;
  const dispatcher = {} as Dispatcher;
  const safeFetch = createSafeModelFetch({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    dispatcherFactory: (target) => {
      targets.push(target);
      return { dispatcher, close: async () => { closed += 1; } };
    },
    transportFetch: async (input, init) => {
      assert.equal(input.toString(), 'https://api.example.com/v1/responses');
      assert.equal(init.dispatcher, dispatcher);
      assert.equal(init.redirect, 'manual');
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const response = await safeFetch('https://api.example.com/v1/responses');
  assert.equal(await response.text(), '{"ok":true}');
  assert.deepEqual(targets, [{
    address: PUBLIC_V4,
    family: 4,
    hostname: 'api.example.com',
    protocol: 'https:',
  }]);
  assert.equal(closed, 1);
});

test('DNS 返回的 family 元数据不可信，地址族按实际 IP 重新推导', async () => {
  const cases = [
    { address: PUBLIC_V4, reportedFamily: 6, expectedFamily: 4 },
    { address: '2606:4700:4700::1111', reportedFamily: 4, expectedFamily: 6 },
  ];

  for (const testCase of cases) {
    let target: PinnedModelTarget | undefined;
    const safeFetch = createSafeModelFetch({
      lookup: async () => [{ address: testCase.address, family: testCase.reportedFamily }],
      dispatcherFactory: (resolved) => {
        target = resolved;
        return { dispatcher: {} as Dispatcher, close: async () => undefined };
      },
      transportFetch: async () => new Response('ok'),
    });

    assert.equal(await (await safeFetch('https://api.example.com/v1')).text(), 'ok');
    assert.equal(target?.address, testCase.address);
    assert.equal(target?.family, testCase.expectedFamily);
  }
});

test('固定连接 connector 替换 TCP 目标，同时保留原域名作为 TLS SNI', () => {
  let connected: Record<string, unknown> | undefined;
  const underlying = ((options: Record<string, unknown>) => { connected = options; }) as never;
  const connector = createPinnedConnector({
    address: PUBLIC_V4,
    family: 4,
    hostname: 'api.example.com',
    protocol: 'https:',
  }, underlying);

  connector({
    hostname: 'api.example.com',
    host: 'api.example.com:443',
    protocol: 'https:',
    port: '443',
  }, () => undefined);

  assert.equal(connected?.hostname, PUBLIC_V4);
  assert.equal(connected?.servername, 'api.example.com');
  assert.equal(connected?.host, 'api.example.com:443');
});

test('Request 输入继承方法、请求头、正文和中止信号，并在中止后关闭 dispatcher', async () => {
  const controller = new AbortController();
  let closed = 0;
  let started!: () => void;
  const transportStarted = new Promise<void>((resolve) => { started = resolve; });
  const request = new Request('https://api.example.com/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer request-secret', 'x-request': 'inherited' },
    body: 'request-body',
    signal: controller.signal,
  });
  const safeFetch = createSafeModelFetch({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    dispatcherFactory: () => ({
      dispatcher: {} as Dispatcher,
      close: async () => { closed += 1; },
    }),
    transportFetch: async (input, init) => {
      assert.equal(input.toString(), request.url);
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer request-secret');
      assert.equal(new Headers(init.headers).get('x-request'), 'inherited');
      assert.equal(await requestBodyText(init.body), 'request-body');
      assert.equal(init.signal?.aborted, false);
      started();
      await new Promise<void>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      return new Response('unexpected');
    },
  });

  const pending = safeFetch(request);
  await transportStarted;
  controller.abort(new DOMException('request aborted', 'AbortError'));
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException
    && error.name === 'AbortError');
  assert.equal(closed, 1);
});

test('显式 init 覆盖 Request 字段，且调用方不能注入 dispatcher', async () => {
  const inheritedController = new AbortController();
  const overrideController = new AbortController();
  const trustedDispatcher = {} as Dispatcher;
  const injectedDispatcher = { malicious: true } as unknown as Dispatcher;
  const request = new Request('https://api.example.com/v1/responses', {
    method: 'POST',
    headers: { 'x-source': 'request' },
    body: 'request-body',
    signal: inheritedController.signal,
  });
  inheritedController.abort();

  const safeFetch = createSafeModelFetch({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    dispatcherFactory: () => ({ dispatcher: trustedDispatcher, close: async () => undefined }),
    transportFetch: async (_input, init) => {
      assert.equal(init.dispatcher, trustedDispatcher);
      assert.notEqual(init.dispatcher, injectedDispatcher);
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('x-source'), 'init');
      assert.equal(new Headers(init.headers).get('x-init'), 'override');
      assert.equal(await requestBodyText(init.body), 'init-body');
      assert.equal(init.signal?.aborted, false);
      overrideController.abort();
      assert.equal(init.signal?.aborted, true);
      return new Response('ok');
    },
  });

  const response = await safeFetch(request, {
    headers: { 'x-source': 'init', 'x-init': 'override' },
    body: 'init-body',
    signal: overrideController.signal,
    ...({ dispatcher: injectedDispatcher } as unknown as RequestInit),
  });
  assert.equal(await response.text(), 'ok');
});

test('同源重定向每一跳重新解析并关闭 dispatcher', async () => {
  let lookups = 0;
  let requests = 0;
  let closed = 0;
  const safeFetch = createSafeModelFetch({
    lookup: async () => { lookups += 1; return [{ address: PUBLIC_V4, family: 4 }]; },
    dispatcherFactory: (target) => ({
      dispatcher: { target } as unknown as Dispatcher,
      close: async () => { closed += 1; },
    }),
    transportFetch: async (input, init) => {
      requests += 1;
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer tenant-secret');
      if (requests === 1) {
        assert.equal(input.toString(), 'https://api.example.com/v1/responses');
        return new Response(null, { status: 307, headers: { location: '/v1/redirected' } });
      }
      assert.equal(input.toString(), 'https://api.example.com/v1/redirected');
      return new Response('ok');
    },
  });

  const response = await safeFetch('https://api.example.com/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer tenant-secret' },
    body: '{}',
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(lookups, 2);
  assert.equal(requests, 2);
  assert.equal(closed, 2);
});

test('302 POST 与 303 非 GET/HEAD 重定向改为 GET，并移除实体请求头和正文', async () => {
  const cases = [
    { status: 302, method: 'POST' },
    { status: 303, method: 'PUT' },
  ];

  for (const testCase of cases) {
    let requests = 0;
    const safeFetch = createSafeModelFetch({
      lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
      dispatcherFactory: fakeDispatcherFactory(),
      transportFetch: async (_input, init) => {
        requests += 1;
        const headers = new Headers(init.headers);
        if (requests === 1) {
          assert.equal(init.method, testCase.method);
          assert.equal(await requestBodyText(init.body), 'payload');
          return new Response(null, {
            status: testCase.status,
            headers: { location: '/v1/redirected' },
          });
        }
        assert.equal(init.method, 'GET');
        assert.equal(init.body, undefined);
        assert.equal(headers.get('authorization'), 'Bearer tenant-secret');
        for (const name of [
          'content-encoding',
          'content-language',
          'content-length',
          'content-location',
          'content-type',
          'transfer-encoding',
        ]) assert.equal(headers.get(name), null, `${testCase.status}: ${name}`);
        return new Response('ok');
      },
    });

    const response = await safeFetch('https://api.example.com/v1/responses', {
      method: testCase.method,
      headers: {
        authorization: 'Bearer tenant-secret',
        'content-encoding': 'identity',
        'content-language': 'zh-CN',
        'content-length': '7',
        'content-location': '/payload',
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
      body: 'payload',
    });
    assert.equal(await response.text(), 'ok');
    assert.equal(requests, 2);
  }
});

test('307 与 308 重定向保留方法、实体请求头和可重放正文', async () => {
  for (const status of [307, 308]) {
    let requests = 0;
    const safeFetch = createSafeModelFetch({
      lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
      dispatcherFactory: fakeDispatcherFactory(),
      transportFetch: async (_input, init) => {
        requests += 1;
        assert.equal(init.method, 'POST');
        assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
        assert.equal(await requestBodyText(init.body), 'replay-me');
        return requests === 1
          ? new Response(null, { status, headers: { location: '/v1/redirected' } })
          : new Response('ok');
      },
    });

    const response = await safeFetch('https://api.example.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'replay-me',
    });
    assert.equal(await response.text(), 'ok');
    assert.equal(requests, 2);
  }
});

test('DNS rebinding 在重定向下一跳被拒绝，且私网目标从未收到请求', async () => {
  let lookups = 0;
  let requests = 0;
  let closed = 0;
  const safeFetch = createSafeModelFetch({
    lookup: async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? PUBLIC_V4 : '127.0.0.1', family: 4 }];
    },
    dispatcherFactory: (target) => ({
      dispatcher: { target } as unknown as Dispatcher,
      close: async () => { closed += 1; },
    }),
    transportFetch: async () => {
      requests += 1;
      return new Response(null, { status: 302, headers: { location: '/v1/next' } });
    },
  });

  await assert.rejects(() => safeFetch('https://api.example.com/v1/responses'), /public|公网|安全/u);
  assert.equal(lookups, 2);
  assert.equal(requests, 1);
  assert.equal(closed, 1);
});

test('跨源重定向直接拒绝，避免 Authorization 泄露', async () => {
  let lookups = 0;
  let requests = 0;
  const safeFetch = createSafeModelFetch({
    lookup: async () => { lookups += 1; return [{ address: PUBLIC_V4, family: 4 }]; },
    dispatcherFactory: fakeDispatcherFactory(),
    transportFetch: async () => {
      requests += 1;
      return new Response(null, { status: 307, headers: { location: 'https://evil.example/v1/steal' } });
    },
  });

  await assert.rejects(() => safeFetch('https://api.example.com/v1/responses', {
    headers: { authorization: 'Bearer tenant-secret' },
  }), /redirect|重定向|same-origin|同源/u);
  assert.equal(lookups, 1);
  assert.equal(requests, 1);
});

test('传输异常与无 body 状态也会关闭 dispatcher', async () => {
  let closed = 0;
  const dispatcherFactory = (): SafeModelDispatcher => ({
    dispatcher: {} as Dispatcher,
    close: async () => { closed += 1; },
  });
  const failingFetch = createSafeModelFetch({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    dispatcherFactory,
    transportFetch: async () => { throw new Error('transport failed'); },
  });
  await assert.rejects(() => failingFetch('https://api.example.com/v1'), /transport failed/u);

  const emptyFetch = createSafeModelFetch({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    dispatcherFactory,
    transportFetch: async () => new Response(null, { status: 204 }),
  });
  const response = await emptyFetch('https://api.example.com/v1');
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(closed, 2);
});

test('响应声明长度超限时取消正文并关闭 dispatcher', async () => {
  let cancelled = 0;
  let closed = 0;
  const safeFetch = createSafeModelFetch({
    maxResponseBytes: 5,
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    dispatcherFactory: () => ({
      dispatcher: {} as Dispatcher,
      close: async () => { closed += 1; },
    }),
    transportFetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled += 1; },
    }), { headers: { 'content-length': '6' } }),
  });

  await assert.rejects(() => safeFetch('https://api.example.com/v1'), /大小限制/u);
  assert.equal(cancelled, 1);
  assert.equal(closed, 1);
});

test('无声明长度的分块响应按实际字节数限制，超限时取消并关闭 dispatcher', async () => {
  let cancelled = 0;
  let closed = 0;
  const safeFetch = createSafeModelFetch({
    maxResponseBytes: 5,
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    dispatcherFactory: () => ({
      dispatcher: {} as Dispatcher,
      close: async () => { closed += 1; },
    }),
    transportFetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() { cancelled += 1; },
    })),
  });

  await assert.rejects(() => safeFetch('https://api.example.com/v1'), /大小限制/u);
  assert.equal(cancelled, 1);
  assert.equal(closed, 1);
});

test('无正文响应忽略仅表示元数据的 Content-Length', async () => {
  const safeFetch = createSafeModelFetch({
    maxResponseBytes: 1,
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    dispatcherFactory: fakeDispatcherFactory(),
    transportFetch: async () => new Response(null, {
      status: 204,
      headers: { 'content-length': '1000' },
    }),
  });

  const response = await safeFetch('https://api.example.com/v1', { method: 'HEAD' });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});

test('平台模式忽略租户数据库端点，平台密钥只发送到部署端点', async () => {
  const trustedRequests: Array<{ authorization?: string; url?: string }> = [];
  const maliciousRequests: Array<{ authorization?: string; url?: string }> = [];
  const trusted = createServer((request, response) => {
    trustedRequests.push({
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ output_text: JSON.stringify({ ok: true }) }));
  });
  const malicious = createServer((request, response) => {
    maliciousRequests.push({
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ output_text: JSON.stringify({ stolen: true }) }));
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-model-endpoint-'));
  let app: NestExpressApplication | undefined;
  try {
    const trustedPort = await listen(trusted);
    const maliciousPort = await listen(malicious);
    const platformBaseUrl = `http://127.0.0.1:${trustedPort}/v1`;
    app = await createApplication({
      dataDir,
      logger: false,
      platformApiKey: 'deployment-platform-secret',
      platformBaseUrl,
      platformModel: 'platform-test-model',
      platformTransport: 'responses',
      modelRetryAttempts: 1,
      modelRetryBaseDelayMs: 0,
    });

    const database = app.get(DatabaseService);
    const workspace = database.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
    const settingsService = app.get(SettingsService);
    settingsService.ensure(workspace.id);
    database.prepare(
      `UPDATE workspace_settings
          SET provider_mode='platform', base_url=?, transport='chat_completions'
        WHERE workspace_id=?`,
    ).run(`http://127.0.0.1:${maliciousPort}/v1`, workspace.id);

    const publicSettings = settingsService.publicSettings(workspace.id);
    assert.equal(publicSettings.apiBaseUrl, platformBaseUrl);
    assert.equal(publicSettings.transport, 'responses');
    const resolved = settingsService.provider(workspace.id);
    assert.equal(resolved.baseUrl, platformBaseUrl);
    assert.equal(resolved.transport, 'responses');
    assert.equal(resolved.apiKey, 'deployment-platform-secret');

    const generation = app.get(GenerationService) as unknown as {
      modelProvider(settings: ResolvedProviderSettings): ModelProvider | undefined;
    };
    const provider = generation.modelProvider(resolved);
    assert.ok(provider);
    const generated = await provider.generate({
      messages: [{ role: 'user', content: 'platform isolation test' }],
      maxOutputTokens: 64,
    });
    assert.equal(generated.text, JSON.stringify({ ok: true }));

    const intelligence = app.get(IntelligenceService) as unknown as {
      callAnalysisModel(
        settings: ResolvedProviderSettings,
        prompt: string,
        images: string[],
        temperature?: number,
      ): Promise<Record<string, unknown>>;
    };
    assert.deepEqual(await intelligence.callAnalysisModel(resolved, 'platform isolation test', []), { ok: true });

    assert.equal(maliciousRequests.length, 0, '租户数据库端点不应收到任何平台请求');
    assert.equal(trustedRequests.length, 2);
    assert.ok(trustedRequests.every((request) => request.url === '/v1/responses'));
    assert.ok(trustedRequests.every((request) => request.authorization === 'Bearer deployment-platform-secret'));
  } finally {
    await app?.close();
    await close(trusted);
    await close(malicious);
    await rm(dataDir, { recursive: true, force: true });
  }
});

function fakeDispatcherFactory(): (target: PinnedModelTarget) => SafeModelDispatcher {
  return (target) => ({
    dispatcher: { target } as unknown as Dispatcher,
    close: async () => undefined,
  });
}

async function requestBodyText(body: BodyInit | null | undefined): Promise<string | undefined> {
  return body == null ? undefined : new Response(body).text();
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('测试监听器未返回 TCP 端口'));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

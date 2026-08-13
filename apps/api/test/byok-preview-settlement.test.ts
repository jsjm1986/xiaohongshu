import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

/**
 * BYOK 与确定性预览的结算边角。核心不变量:**额度是平台模型调用的对价**——
 * 没有用平台 key 的地方,一次都不能扣。
 *
 * - BYOK 工作区:入队就不扣款(而不是先扣再退),任务终态后余额仍为 0,
 *   流水表不得出现该工作区的扣款记录;
 * - platform 模式但服务器没配平台 key(本测试环境即如此):生成走确定性
 *   预览完成,同样全程零扣款、预览产物按硬门禁 blocked。
 *
 * 覆盖边界声明:「入队时 platform 扣 1 → 运行中切 BYOK → 完成时按当前
 * providerSettings keep=0 退 1」的切换场景依赖真实平台模型完成一次生成,
 * 无法在离线测试里端到端跑通;该语义由 generation.service 完成路径的
 * keep 判定(providerSettings.mode === 'platform' && apiKey ? 1 : 0)承载,
 * 失败路径的等价退款已被 quota-settlement / must-include-preflight 钉住。
 */

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';
let database: DatabaseService;
// 一个只会说 401 的假 BYOK 网关:4xx(非 429)让 LLM 客户端 fail fast,
// 任务秒级到 failed 终态——假域名/拒连端口都会陷进整套重试退避,拖分钟级。
let byokGateway: Server;
let byokGatewayUrl = '';

async function call(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

const post = (path: string, body: Record<string, unknown> = {}) => call(path, { method: 'POST', body: JSON.stringify(body) });

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-byok-settle-'));
  byokGateway = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid api key (settlement test gateway)' } }));
  });
  await new Promise<void>((resolve) => byokGateway.listen(0, '127.0.0.1', resolve));
  const gatewayAddress = byokGateway.address() as { port: number };
  byokGatewayUrl = `http://127.0.0.1:${gatewayAddress.port}/v1`;
  // platformApiKey 显式置空:config 的 fallback 链会吃 OPENAI_API_KEY /
  // ANTHROPIC_AUTH_TOKEN 等环境变量(开发机上常见),不显式钉死的话
  // 「无平台 key」场景在有这些变量的机器上会静默变成「有 key 且扣款」。
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'byok-settle-test-master-key-0000',
    platformApiKey: '',
    byokAllowHttp: true,
    byokAllowPrivateNetwork: true,
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await post('/api/auth/login', { username: 'admin', password: 'Admin-bootstrap-123!' });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await post('/api/auth/change-password', { currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' });
  database = app.get(DatabaseService);
});

after(async () => {
  await app.close();
  await new Promise<void>((resolve) => byokGateway.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

function quotaUsed(workspaceId: string): number {
  const row = database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as { quota_used: number } | undefined;
  return Number(row?.quota_used ?? 0);
}

function ledgerRows(workspaceId: string): Array<{ delta: number; reason: string }> {
  return database
    .prepare('SELECT delta, reason FROM quota_ledger WHERE workspace_id=? ORDER BY id')
    .all(workspaceId) as Array<{ delta: number; reason: string }>;
}

async function seedProjectWithKnowledge(name: string): Promise<{ projectId: string; workspaceId: string }> {
  const workspace = await post('/api/workspaces', { name });
  assert.equal(workspace.response.status, 201, JSON.stringify(workspace.body));
  const project = await post('/api/projects', { name: `${name}-项目`, domain: '眼袋', workspaceId: workspace.body.id });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  const projectId = String(project.body.id);
  // 正式生成的前置:完整且已批准的创作蓝图(prepareGenerationPlan 硬性要求),
  // 用全链路测试共享的 fixture。
  seedApprovedProjectBlueprint(app, projectId);
  return { projectId, workspaceId: String(workspace.body.id) };
}

async function waitForTerminal(jobId: string, timeoutMs = 120_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const { body } = await call(`/api/generations/${jobId}`);
    if (['completed', 'failed', 'canceled'].includes(String(body.status))) return String(body.status);
    if (Date.now() - start > timeoutMs) throw new Error(`任务未在 ${timeoutMs}ms 内到终态: ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

test('BYOK 工作区：入队就不扣款，终态后余额与流水都是零', async () => {
  const { projectId, workspaceId } = await seedProjectWithKnowledge('BYOK结算');
  const settings = await call('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      workspaceId, providerMode: 'byok', provider: 'openai',
      apiKey: 'sk-byok-test-not-a-real-key', apiBaseUrl: byokGatewayUrl,
      monthlyQuota: 10,
    }),
  });
  assert.equal(settings.response.status, 200, JSON.stringify(settings.body));

  const generation = await post('/api/generations', { projectId, topic: 'BYOK 结算边角' });
  assert.equal(generation.response.status, 201, JSON.stringify(generation.body));
  assert.equal(quotaUsed(workspaceId), 0, 'BYOK 入队不得扣平台额度');

  // 网关恒 401(4xx fail fast),任务秒级失败;失败结算对 consumed=0 必须
  // 是 0——余额与流水都不得因结算动作产生负数或凭空冲正。
  const status = await waitForTerminal(String(generation.body.id));
  assert.equal(status, 'failed', 'BYOK 假 key 任务应失败');
  assert.equal(quotaUsed(workspaceId), 0, 'BYOK 任务失败结算后余额必须仍为 0');
  assert.deepEqual(ledgerRows(workspaceId), [], 'BYOK 工作区不得出现任何平台额度流水');
});

test('platform 模式无平台 key：确定性预览完成，全程零扣款且产物按硬门禁 blocked', async () => {
  const { projectId, workspaceId } = await seedProjectWithKnowledge('预览结算');
  const quota = await call('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ workspaceId, monthlyQuota: 10 }),
  });
  assert.equal(quota.response.status, 200, JSON.stringify(quota.body));

  const generation = await post('/api/generations', { projectId, topic: '预览结算边角' });
  assert.equal(generation.response.status, 201, JSON.stringify(generation.body));
  assert.equal(quotaUsed(workspaceId), 0, '无平台 key 时入队不得扣款(钱是为模型调用付的)');

  const status = await waitForTerminal(String(generation.body.id));
  assert.equal(status, 'completed', '确定性预览应能完成');
  assert.equal(quotaUsed(workspaceId), 0, '预览完成后余额仍为 0');
  assert.deepEqual(ledgerRows(workspaceId), [], '预览生成不得出现平台额度流水');

  const detail = await call(`/api/generations/${generation.body.id}`);
  const candidate = detail.body.candidates?.[0];
  assert.ok(candidate, '预览任务应有候选');
  assert.equal(candidate.generationMode, 'deterministic_preview');
  assert.equal(candidate.validation?.qualityStatus, 'blocked', '预览产物必须被硬门禁拦下,不可交付');
});

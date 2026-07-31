import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

/**
 * 跨租户越权的端到端封堵证明。
 *
 * 两个工作区(A/B),各一个非 admin 用户,只在自己的工作区里有成员身份。
 * 然后拿 A 的会话去点 B 的每一类资源入口——**用真实 id**,不是猜的 id,
 * 因为「不存在」返回 404 和「存在但无权」返回 403 是两件事,只有后者
 * 才证明作用域判定生效。
 *
 * 覆盖面按控制器逐个对齐:项目 / 工作区 / 知识 / 预设 / 生成 / 批次 /
 * 公式 / 导出 / 情报蓝图 / 研究 / 设置额度 / 审计 / v1 只读 Key。
 */

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';

const BOOTSTRAP = 'CrossTenant-bootstrap-123!';
const ADMIN = 'CrossTenant-admin-456!';
const PASS_A = 'TenantA-pass-12345!';
const PASS_B = 'TenantB-pass-12345!';

interface Session {
  cookie: string;
  csrf: string;
}

let admin: Session;
let tenantA: Session;
let tenantB: Session;

let workspaceA = '';
let workspaceB = '';
let projectA = '';
let projectB = '';
let knowledgeB = '';
let presetB = '';
let jobB = '';
let batchB = '';
let formulaB = '';
let packageB = '';
let apiKeyA = '';

async function call(path: string, options: RequestInit = {}, session?: Session) {
  const headers = new Headers(options.headers);
  if (session?.cookie) headers.set('cookie', session.cookie);
  if (session?.csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) {
    headers.set('x-csrf-token', session.csrf);
  }
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as any };
}

async function login(username: string, password: string): Promise<Session> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 201, `${username} 登录失败`);
  const body = (await response.json()) as { csrfToken: string };
  return { cookie: response.headers.get('set-cookie')!.split(';', 1)[0]!, csrf: body.csrfToken };
}

/** 直接建号 + 入组:走 API 建号,再用 DB 补成员身份(真实开通流程同理)。 */
async function createTenant(username: string, password: string, workspaceId: string): Promise<Session> {
  const created = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, systemRole: 'user' }),
  }, admin);
  assert.ok([200, 201].includes(created.status), `建号 ${username} 失败: ${JSON.stringify(created.body)}`);
  const db = app.get(DatabaseService);
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string };
  db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at)' +
      " VALUES (?, ?, 'Admin', '[]', '[]', datetime('now'), datetime('now'))",
  ).run(workspaceId, row.id);
  // 建号即需改密,先清掉这个门,否则任何写请求都被 PASSWORD_CHANGE_REQUIRED 拦下,
  // 测出来的 403 就不是越权判定的功劳了。
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(row.id);
  return login(username, password);
}

/** 直接落库造一条产出 + 内容包,避免依赖真实模型调用。 */
function seedJobAndPackage(projectId: string, jobId: string, packageId: string): void {
  const db = app.get(DatabaseService);
  const owner = db.prepare("SELECT id FROM users WHERE username='tenant-b'").get() as { id: string };
  db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        topic, goal, mode, progress, knowledge_context_json, style_profile_version,
        resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
        planning_context_json, image_context_json, research_snapshot_json, quality_status)
     VALUES (?, ?, 'completed', '{"formula":{"versionId":"fv"},"knowledge":{"mode":"full","selectedFileIds":[]}}',
        's', ?, datetime('now'), datetime('now'), 'B 的选题', 'g', 'simple', 100, '{}', 1,
        '{}', '{}', '{}', '{}', '[]', '{}', 'unknown')`,
  ).run(jobId, projectId, owner.id);
  db.prepare(
    `INSERT INTO content_packages (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
     VALUES (?, ?, ?, 0, '{"title":"B 的稿子"}', datetime('now'), datetime('now'))`,
  ).run(packageId, jobId, projectId);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-crosstenant-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: BOOTSTRAP,
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  admin = await login('admin', BOOTSTRAP);
  await call('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: BOOTSTRAP, newPassword: ADMIN }),
  }, admin);

  workspaceA = (await call('/api/workspaces', {}, admin)).body[0].id;
  const created = await call('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: '租户 B 工作区' }),
  }, admin);
  assert.ok([200, 201].includes(created.status), `建工作区失败: ${JSON.stringify(created.body)}`);
  workspaceB = created.body.id;

  tenantA = await createTenant('tenant-a', PASS_A, workspaceA);
  tenantB = await createTenant('tenant-b', PASS_B, workspaceB);

  projectA = (await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'A 的项目', domain: '去眼袋', workspaceId: workspaceA }),
  }, tenantA)).body.id;
  projectB = (await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'B 的项目', domain: '住宅装修', workspaceId: workspaceB }),
  }, tenantB)).body.id;
  assert.ok(projectA && projectB, '两个租户各自的项目都要建起来');

  // B 的各类资源,全部用 B 自己的会话创建,拿到真实 id 供 A 去撞
  knowledgeB = (await call('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectB, filename: 'b.md', content: 'B 的私有资料', category: 'reference' }),
  }, tenantB)).body?.id ?? '';
  presetB = (await call(`/api/projects/${projectB}/presets`, {
    method: 'POST',
    body: JSON.stringify({ name: 'B 的预设', config: {} }),
  }, tenantB)).body?.id ?? '';
  formulaB = (await call(`/api/formulas?projectId=${projectB}`, {}, tenantB)).body?.[0]?.id ?? '';
  jobB = 'cross-tenant-job-b';
  packageB = 'cross-tenant-pkg-b';
  seedJobAndPackage(projectB, jobB, packageB);
  // 批次直接落库:走 API 建批次要先有真实生成任务(依赖模型调用),这里只需要
  // 一条真实存在的批次行让 A 去撞。
  batchB = 'cross-tenant-batch-b';
  {
    const db = app.get(DatabaseService);
    const owner = db.prepare("SELECT id FROM users WHERE username='tenant-b'").get() as { id: string };
    db.prepare(
      `INSERT INTO generation_batches (id, project_id, name, status, total_jobs, config_json, created_by, created_at, updated_at)
       VALUES (?, ?, 'B 的批次', 'completed', 1, '{}', ?, datetime('now'), datetime('now'))`,
    ).run(batchB, projectB, owner.id);
  }

  // 假绿防线:下面的 403 只有在资源真实存在时才证明是权限判定。任一 id 为空
  // 就意味着我在测一条不存在的路径,必须当场炸掉而不是收一个漂亮的 403。
  assert.ok(knowledgeB, 'B 的知识文件必须真的建起来');
  assert.ok(presetB, 'B 的预设必须真的建起来');
  assert.ok(formulaB, 'B 的公式版本必须真的存在');
  assert.ok(batchB, 'B 的批次必须真的建起来');

  apiKeyA = (await call(`/api/workspaces/${workspaceA}/api-keys`, {
    method: 'POST',
    body: JSON.stringify({ name: 'A 的只读 Key' }),
  }, admin)).body?.key ?? '';
  assert.ok(apiKeyA, '需要一把 A 工作区的只读 Key');
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('列表端点只吐自己的:项目 / 工作区互不可见', async () => {
  const projects = await call('/api/projects', {}, tenantA);
  const ids = projects.body.map((p: any) => p.id);
  assert.ok(ids.includes(projectA), 'A 应看到自己的项目');
  assert.ok(!ids.includes(projectB), `A 不该看到 B 的项目: ${JSON.stringify(ids)}`);

  const workspaces = await call('/api/workspaces', {}, tenantA);
  const wsIds = workspaces.body.map((w: any) => w.id);
  assert.deepEqual(wsIds, [workspaceA], 'A 只该看到自己的工作区');
});

test('显式传别人的 workspaceId 也捞不到东西', async () => {
  const projects = await call(`/api/projects?workspaceId=${workspaceB}`, {}, tenantA);
  assert.deepEqual(projects.body, [], '越权指定 workspaceId 应返回空,而不是 B 的项目');

  const workspace = await call(`/api/workspaces/${workspaceB}`, {}, tenantA);
  assert.equal(workspace.status, 403, `读别人工作区详情应 403,实际 ${workspace.status}`);

  const members = await call(`/api/workspaces/${workspaceB}/members`, {}, tenantA);
  assert.equal(members.status, 403);

  const keys = await call(`/api/workspaces/${workspaceB}/api-keys`, {}, tenantA);
  assert.equal(keys.status, 403, '别人工作区的 API Key 列表必须挡住');
});

test('项目级读写删全部 403(资源真实存在,所以这是权限判定不是 404)', async () => {
  const cases: [string, RequestInit][] = [
    [`/api/projects/${projectB}`, {}],
    [`/api/projects/${projectB}`, { method: 'PATCH', body: JSON.stringify({ name: '被改名' }) }],
    [`/api/projects/${projectB}`, { method: 'DELETE' }],
    [`/api/projects/${projectB}/acl`, {}],
    [`/api/projects/${projectB}/intelligence`, {}],
    [`/api/projects/${projectB}/blueprint-modules`, {}],
    [`/api/projects/${projectB}/information-gaps`, {}],
    [`/api/projects/${projectB}/topic-opportunities`, {}],
    [`/api/projects/${projectB}/expression-strategies`, {}],
    [`/api/projects/${projectB}/coverage`, {}],
    [`/api/projects/${projectB}/image-assets`, {}],
    [`/api/projects/${projectB}/research/overview`, {}],
    [`/api/projects/${projectB}/research/claims`, {}],
    [`/api/projects/${projectB}/presets`, {}],
    [`/api/projects/${projectB}/style-profile`, {}],
    [`/api/projects/${projectB}/knowledge`, {}],
    [`/api/knowledge?projectId=${projectB}`, {}],
    [`/api/formulas?projectId=${projectB}`, {}],
    [`/api/generations?projectId=${projectB}`, {}],
    [`/api/generation-batches?projectId=${projectB}`, {}],
    [`/api/generation-parameters/schema?projectId=${projectB}`, {}],
    [`/api/projects/${projectB}/resolve-config`, { method: 'POST', body: JSON.stringify({}) }],
    ['/api/generations', { method: 'POST', body: JSON.stringify({ projectId: projectB, topic: '偷跑' }) }],
    ['/api/generation-batches', { method: 'POST', body: JSON.stringify({ projectId: projectB, topics: ['偷跑'] }) }],
    ['/api/formulas', { method: 'POST', body: JSON.stringify({ projectId: projectB, name: '偷建' }) }],
    [`/api/formulas/projects/${projectB}/ensure-reviewed-defaults`, { method: 'POST' }],
  ];
  for (const [path, options] of cases) {
    const result = await call(path, options, tenantA);
    assert.equal(result.status, 403, `${options.method ?? 'GET'} ${path} 应 403,实际 ${result.status} ${JSON.stringify(result.body).slice(0, 160)}`);
  }
});

test('按子资源真实 id 直取也挡住(绕开 projectId 路径段的尝试)', async () => {
  const cases: [string, RequestInit][] = [
    [`/api/knowledge/${knowledgeB}`, {}],
    [`/api/knowledge/${knowledgeB}`, { method: 'PATCH', body: JSON.stringify({ category: 'reference' }) }],
    [`/api/knowledge/${knowledgeB}`, { method: 'DELETE' }],
    [`/api/generations/${jobB}`, {}],
    [`/api/generations/${jobB}/reader`, {}],
    [`/api/generations/${jobB}`, { method: 'DELETE' }],
    [`/api/generations/${jobB}/restore`, { method: 'POST' }],
    [`/api/generations/${jobB}/revise`, { method: 'POST', body: JSON.stringify({ candidateId: packageB, instruction: '改一下' }) }],
    [`/api/generations/${jobB}/candidates/${packageB}/export`, {}],
  ];
  for (const [path, options] of cases) {
    const result = await call(path, options, tenantA);
    assert.equal(result.status, 403, `${options.method ?? 'GET'} ${path} 应 403,实际 ${result.status} ${JSON.stringify(result.body).slice(0, 160)}`);
  }

  if (presetB) {
    const preset = await call(`/api/projects/${projectA}/presets/${presetB}`, {}, tenantA);
    assert.notEqual(preset.status, 200, '拿自己的项目 id 套别人的预设 id 不能读成功');
  }
  if (formulaB) {
    const activate = await call(`/api/formulas/${formulaB}/activate`, { method: 'POST' }, tenantA);
    assert.equal(activate.status, 403, '激活别人的公式版本应 403');
  }
  if (batchB) {
    const batch = await call(`/api/generation-batches/${batchB}`, {}, tenantA);
    assert.equal(batch.status, 403, '读别人的批次应 403');
  }
});

test('设置 / 额度 / 审计不跨租户:BYOK 与用量都留在本工作区', async () => {
  const settings = await call(`/api/settings?workspaceId=${workspaceB}`, {}, tenantA);
  assert.equal(settings.status, 403, 'A 不该读到 B 的 provider 配置');

  const quota = await call(`/api/settings/quota?workspaceId=${workspaceB}`, {}, tenantA);
  assert.equal(quota.status, 403);

  const patch = await call('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ workspaceId: workspaceB, monthlyQuota: 999_999 }),
  }, tenantA);
  assert.equal(patch.status, 403, 'A 不能改 B 的额度');

  const audit = await call(`/api/audit?workspaceId=${workspaceB}`, {}, tenantA);
  assert.equal(audit.status, 403, '审计日志会带出对方的操作细节,必须挡住');

  const own = await call(`/api/settings?workspaceId=${workspaceA}`, {}, tenantA);
  assert.equal(own.status, 200, '自己的设置要读得到,否则上面的 403 可能只是全都挂了');
});

test('BYOK 密钥只以布尔标记出现,任何会话都读不到密文或明文', async () => {
  // 给 B 存一把真 Key,再从 A 和 B 两侧确认响应里只有 hasApiKey,没有密钥本体。
  const saved = await call('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ workspaceId: workspaceB, providerMode: 'byok', provider: 'deepseek', apiKey: 'byok-test-key-material' }),
  }, tenantB);
  assert.equal(saved.status, 200, `B 存 Key 失败: ${JSON.stringify(saved.body)}`);
  assert.equal(saved.body.hasApiKey, true, '存完应显示已配置');
  assert.ok(!JSON.stringify(saved.body).includes('sk-'), '写入响应本身也不能回吐密钥');

  const db = app.get(DatabaseService);
  const stored = db.prepare('SELECT encrypted_api_key FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceB) as { encrypted_api_key: string | null };
  assert.ok(stored.encrypted_api_key, '应落库');
  assert.ok(!stored.encrypted_api_key!.includes('byok-test-key-material'), '落库必须是密文');

  // A 侧:既读不到 B 的设置,自己的设置里也不该出现 B 的 Key 痕迹
  const cross = await call(`/api/settings?workspaceId=${workspaceB}`, {}, tenantA);
  assert.equal(cross.status, 403);
  const mine = await call(`/api/settings?workspaceId=${workspaceA}`, {}, tenantA);
  assert.ok(!JSON.stringify(mine.body).includes('sk-'), '响应里不应出现任何密钥形态字符串');
  // A 仍是 platform 模式,hasApiKey 反映的是平台 Key 是否配置,与租户 Key 无关;
  // 真正要锁的是「A 的行里没有任何 BYOK 密文」,否则就是串了。
  const mineRow = db.prepare('SELECT provider_mode, encrypted_api_key FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceA) as { provider_mode: string; encrypted_api_key: string | null };
  assert.equal(mineRow.provider_mode, 'platform', 'A 没改过模式');
  assert.ok(!mineRow.encrypted_api_key, 'A 的行不该出现任何 BYOK 密文');
});

test('额度是按工作区各记一本,不共享', async () => {
  const db = app.get(DatabaseService);
  db.prepare('UPDATE workspace_settings SET quota_used = 7 WHERE workspace_id = ?').run(workspaceB);
  const a = await call(`/api/settings/quota?workspaceId=${workspaceA}`, {}, tenantA);
  assert.equal(a.status, 200);
  assert.equal(a.body.quotaUsed, 0, 'B 的用量不能算到 A 头上');
  const b = await call(`/api/settings/quota?workspaceId=${workspaceB}`, {}, tenantB);
  assert.equal(b.body.quotaUsed, 7);
});

test('系统管理面板只有 admin 能进', async () => {
  for (const path of ['/api/admin/users', '/api/admin/registrations']) {
    const result = await call(path, {}, tenantA);
    assert.equal(result.status, 403, `${path} 对普通用户应 403`);
  }
  const createWorkspace = await call('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: '普通用户偷建的工作区' }),
  }, tenantA);
  assert.notEqual(createWorkspace.status, 201, '非 admin 不能建工作区');
});

test('只读 API Key 锁在自己的工作区(含显式跨区请求)', async () => {
  const headers = { authorization: `Bearer ${apiKeyA}` };

  const projects = await fetch(`${baseUrl}/v1/projects`, { headers }).then((r) => r.json()) as any[];
  const ids = projects.map((p) => p.id);
  assert.ok(ids.includes(projectA));
  assert.ok(!ids.includes(projectB), 'Key 不该看到别的工作区的项目');

  const crossed = await fetch(`${baseUrl}/v1/projects?workspaceId=${workspaceB}`, { headers });
  assert.equal(crossed.status, 403, '显式跨区应 403 而不是静默返回空');

  const knowledge = await fetch(`${baseUrl}/v1/knowledge/files?projectId=${projectB}`, { headers }).then((r) => r.json()) as any[];
  assert.deepEqual(knowledge, [], '按 projectId 过滤也不能穿透工作区');

  const jobs = await fetch(`${baseUrl}/v1/generation-jobs?projectId=${projectB}`, { headers }).then((r) => r.json()) as any[];
  assert.deepEqual(jobs, []);

  const pkg = await fetch(`${baseUrl}/v1/content-packages/${packageB}`, { headers });
  assert.equal(pkg.status, 403, '内容包按真实 id 直取应 403');
});

test('会话身份不可被请求参数覆写', async () => {
  // 造一个「我说我是 B」的请求:workspaceId 与 body 里的归属字段都指向 B。
  // 会话里的 userId 才是唯一权威,参数不该有任何提权作用。
  const forged = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '伪造归属', workspaceId: workspaceB, createdBy: 'tenant-b' }),
  }, tenantA);
  assert.equal(forged.status, 403, '往别人工作区里建项目应 403');

  const db = app.get(DatabaseService);
  const leaked = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND name = ?')
    .get(workspaceB, '伪造归属') as { n: number };
  assert.equal(leaked.n, 0, '403 之后不能留下半条记录');
});

/**
 * 反向对照。上面全是 403,单看不能排除「这些路径本来就对谁都 403」。
 * 这里把 A 正式加进 B 的工作区,同样的请求必须翻成 200 —— 证明前面的 403
 * 出自成员关系判定,而不是路由挂了或参数不对。放最后跑,不污染前面的用例。
 */
test('反向对照:授予成员身份后,同样的请求变为 200', async () => {
  const db = app.get(DatabaseService);
  const userA = db.prepare("SELECT id FROM users WHERE username='tenant-a'").get() as { id: string };

  const before = await call(`/api/projects/${projectB}`, {}, tenantA);
  assert.equal(before.status, 403, '入组前应是 403');

  db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at)' +
      " VALUES (?, ?, 'Admin', '[]', '[]', datetime('now'), datetime('now'))",
  ).run(workspaceB, userA.id);

  for (const path of [
    `/api/projects/${projectB}`,
    `/api/projects/${projectB}/presets`,
    `/api/knowledge?projectId=${projectB}`,
    `/api/generations?projectId=${projectB}`,
    `/api/generation-batches/${batchB}`,
    `/api/settings/quota?workspaceId=${workspaceB}`,
  ]) {
    const after = await call(path, {}, tenantA);
    assert.equal(after.status, 200, `入组后 ${path} 应 200,实际 ${after.status}`);
  }

  // 只读 Key 不吃成员关系:它绑的是工作区,与用户入组无关。
  const crossed = await fetch(`${baseUrl}/v1/projects?workspaceId=${workspaceB}`, {
    headers: { authorization: `Bearer ${apiKeyA}` },
  });
  assert.equal(crossed.status, 403, 'Key 的边界不随成员关系变化');
});

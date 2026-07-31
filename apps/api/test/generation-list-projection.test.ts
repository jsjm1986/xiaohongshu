import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

/**
 * 列表接口的轻量投影。
 *
 * 起因是实测:26 个任务的 GET /api/generations?projectId= 返回 10.5 MB,单个任务
 * 366 KB——mapJob(row, false) 只省掉候选,planningContext(87KB)、researchSnapshot、
 * configImpact 三份重复(各 56.8KB)照样全量返回,而列表页一个字段都用不到。
 *
 * 这些用例锁住:列表只给消费方真正需要的字段,重字段一律不在列表里出现;
 * 详情接口不受影响(它本来就该给全)。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';
const jobId = 'listproj-job-1';

const PASSWORD = 'Listproj-bootstrap-123!';
const NEW_PASSWORD = 'Listproj-updated-456!';

/** 列表页与完整版历史页真正读到的字段(两边需求的并集) */
const REQUIRED_LIST_FIELDS = [
  'id', 'projectId', 'projectName', 'topic', 'goal', 'mode', 'status', 'qualityStatus',
  'progress', 'createdAt', 'seed', 'formulaVersion', 'presetId',
];

/** 可选字段:无值时后端不输出该键(既有约定,消费方一律用 ?. 读) */
const OPTIONAL_LIST_FIELDS = ['error', 'completedAt', 'batchId', 'opportunityId'];

/** 列表里绝不该出现的重字段(详情接口才给) */
const FORBIDDEN_LIST_FIELDS = [
  'planningContext', 'researchSnapshot', 'configImpact', 'configImpactReport',
  'parameterImpactReport', 'configPreview', 'resolutionSnapshot', 'diagnosticProxies',
  'impactReport', 'impacts', 'impactPreview', 'candidates', 'knowledgeContext',
  'sourceImageAssets', 'opportunitySelectionAudit',
];

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-listproj-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201);
  const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '列表投影项目', domain: '去眼袋' }) });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = project.body.id;

  // 造一个带重字段的任务:用真实生成太慢且依赖模型,这里直接落库。
  // planningContext 塞一坨大对象,用来验证它确实没进列表投影。
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  const bulky = JSON.stringify({ padding: 'x'.repeat(50_000), nested: { deep: Array.from({ length: 200 }, (_, i) => ({ i })) } });
  db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        topic, goal, mode, progress, knowledge_context_json, style_profile_version,
        resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
        planning_context_json, image_context_json, research_snapshot_json, quality_status)
     VALUES (?, ?, 'completed', ?, 'seed-1', ?, datetime('now'), datetime('now'),
        '列表投影用任务', '目标', 'simple', 100, '{}', 1,
        ?, ?, '{}', ?, '[]', ?, 'passed')`,
  ).run(jobId, projectId, JSON.stringify({ formula: { versionId: 'fv-test' }, knowledge: { mode: 'full', selectedFileIds: [] }, task: { audienceStage: 'collecting', entry: 'search' }, parameters: { padding: 'y'.repeat(20_000) } }), admin.id, bulky, bulky, bulky, bulky);
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('列表返回消费方需要的全部字段', async () => {
  const { response, body } = await request(`/api/generations?projectId=${projectId}`);
  assert.equal(response.status, 200, JSON.stringify(body).slice(0,400));
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length > 0, '前置:应有一个任务');
  for (const field of REQUIRED_LIST_FIELDS) {
    assert.ok(field in body.items[0], `列表缺少字段 ${field}`);
  }
});

// 可选字段无值时后端不输出该键(既有约定)。这条锁住「不会输出 null 或空串」,
// 否则前端 `job.error && ...` 之类的判断会把空串当成有错误。
test('可选字段要么不存在,要么是有意义的值,不出现 null/空串', async () => {
  const { body } = await request(`/api/generations?projectId=${projectId}`);
  const job = body.items[0];
  for (const field of OPTIONAL_LIST_FIELDS) {
    if (!(field in job)) continue;
    assert.notEqual(job[field], null, `${field} 不应为 null`);
    assert.notEqual(job[field], '', `${field} 不应为空串`);
  }
});

test('列表不含重字段:planningContext / configImpact 等一律不出现', async () => {
  const { body } = await request(`/api/generations?projectId=${projectId}`);
  assert.ok(body.items.length > 0, '前置:应有一个任务');
  for (const field of FORBIDDEN_LIST_FIELDS) {
    assert.equal(field in body.items[0], false, `列表不应包含重字段 ${field}`);
  }
});

test('单个任务的列表投影体积远小于详情', async () => {
  const { body: list } = await request(`/api/generations?projectId=${projectId}`);
  assert.ok(list.items.length > 0, '前置:应有一个任务');
  const listSize = JSON.stringify(list.items[0]).length;
  const { body: detail } = await request(`/api/generations/${list.items[0].id}`);
  const detailSize = JSON.stringify(detail).length;
  // 实测详情单条 366KB;投影应在 2KB 量级。给一个宽松但有意义的上限。
  assert.ok(listSize < 4000, `列表单条 ${listSize} 字节,应小于 4000`);
  assert.ok(listSize < detailSize, '列表投影必须比详情小');
});

// resolvedConfig 不能整份带上(它是 configPreview 膨胀的主因之一),但配方回填
// (extractRecipe)要读 resolvedConfig.task,所以保留瘦身版:只有 task 一个键。
test('resolvedConfig 只保留 task,不带整份配置', async () => {
  const { body } = await request(`/api/generations?projectId=${projectId}`);
  const rc = body.items[0].resolvedConfig;
  assert.ok(rc, 'resolvedConfig 应存在(配方回填需要)');
  assert.deepEqual(Object.keys(rc), ['task']);
});

// 整份 opportunitySnapshot 有 37 个字段、单条 14 KB,是瘦身后剩下的最大项;
// 而消费方只在 opportunityId 缺失时用它兜底取 id。
test('opportunitySnapshot 只保留 id 兜底键', async () => {
  const { body } = await request(`/api/generations?projectId=${projectId}`);
  // 值为 undefined 的键在 JSON 里会消失,所以断言的是「不含 id/opportunityId
  // 之外的任何键」,而不是这两个键一定存在。
  const keys = Object.keys(body.items[0].opportunitySnapshot ?? {});
  const extra = keys.filter((k) => k !== 'id' && k !== 'opportunityId');
  assert.deepEqual(extra, [], `快照不应含其他字段,实际多出 ${extra.join(',')}`);
  // 有 id 的任务必须把它带出来(兜底路径不能断)
  const withSnapshot = body.items.find((j: any) => j.opportunitySnapshot?.id);
  if (withSnapshot) assert.equal(typeof withSnapshot.opportunitySnapshot.id, 'string');
});

test('详情接口不受影响:仍然给全字段与候选', async () => {
  const { body: list } = await request(`/api/generations?projectId=${projectId}`);
  assert.ok(list.items.length > 0, '前置:应有一个任务');
  const { response, body } = await request(`/api/generations/${list.items[0].id}`);
  assert.equal(response.status, 200);
  // 瘦身只针对列表,详情该有的重字段必须还在
  for (const field of ['planningContext', 'resolvedConfig', 'parameterImpactReport']) {
    assert.ok(field in body, `详情缺少字段 ${field}`);
  }
});

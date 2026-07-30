import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

/**
 * 完善度预检的 HTTP 端到端:分档逻辑的单测在 knowledge-preflight.test.ts,这里验证
 * 真实链路——路由权限、取缺口、跑证据匹配、跨项目隔离。
 *
 * 单测只能保证分档函数对给定输入正确;它保证不了「服务端真的把知识库分节喂进去了」。
 * 上一版补充功能的上下文压缩就是死代码却测试全绿,教训在此。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';
let otherProjectId = '';

const BOOTSTRAP = 'Admin-bootstrap-123!';
const ADMIN = 'Admin-updated-456!';

const PRICE_CONTENT = [
  '# 价格口径',
  '',
  '整装报价包含主材与人工，以当期确认为准。',
].join('\n');

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : await response.arrayBuffer();
  return { response, body: body as any };
}

/** 直接建缺口:走 API 才能保证 data_json 的形状和真实使用一致。 */
async function createGap(project: string, input: Record<string, unknown>) {
  const created = await request(`/api/projects/${project}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({ label: '缺口', question: '问题?', ...input }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  return created.body;
}

/**
 * 落一个只有分析器才能写的 sourceStatus。
 *
 * 人工路径(POST/PATCH)有 assertNoAnalyzerOnlySource 守卫,supplied_fact 会被拦成 400
 * ——人填的答案不该声称资料里有出处。这里直接改库模拟分析器落库,而不是放宽那道门禁。
 * 'unacknowledged' 这类库里的历史脏值也只能这么造。
 */
async function createGapWithSourceStatus(
  project: string,
  input: Record<string, unknown>,
  sourceStatus: string,
) {
  const created = await createGap(project, input);
  const id = String(created.id);
  app.get(DatabaseService).prepare(
    "UPDATE information_gaps SET data_json = json_set(data_json, '$.sourceStatus', ?) WHERE id = ?",
  ).run(sourceStatus, id);
  return id;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-preflight-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: BOOTSTRAP,
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: BOOTSTRAP }) });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: BOOTSTRAP, newPassword: ADMIN }) });

  const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '预检项目', domain: '装修' }) });
  projectId = project.body.id;
  const other = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '另一个项目', domain: '装修' }) });
  otherProjectId = other.body.id;

  const uploaded = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({ projectId, filename: 'price.md', content: PRICE_CONTENT, category: 'fact', evidenceStatus: 'observed' }),
  });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('答案抄自知识库 → evidence_backed,且真的带回证据 id', async () => {
  // 这一条是全套里最重要的:它证明服务端确实把知识库分节喂给了匹配函数。
  // 若 selection 传空,这条会掉到 approved_only —— 死代码会被抓住。
  await createGap(projectId, { label: '整装报价范围', answer: '整装报价包含主材与人工' });

  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const row = result.body.gaps.find((gap: any) => gap.label === '整装报价范围');
  assert.equal(row.tier, 'evidence_backed', JSON.stringify(row));
  assert.ok(row.sectionEvidenceIds.length >= 1, '必须回带真实证据 id');
  assert.match(row.sectionEvidenceIds[0], /^evidence_section_/u);
});

test('多行答案且无资料支撑 → will_be_dropped,并说明原因', async () => {
  await createGap(projectId, { label: '资质编号', answer: '编号待确认\n证件在门店' });

  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  const row = result.body.gaps.find((gap: any) => gap.label === '资质编号');
  assert.equal(row.tier, 'will_be_dropped', JSON.stringify(row));
  assert.match(row.reasons.join(''), /换行/u);
});

test('单行答案无资料支撑 → approved_only', async () => {
  await createGap(projectId, { label: '营业时间', answer: '每天九点到六点' });

  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  const row = result.body.gaps.find((gap: any) => gap.label === '营业时间');
  assert.equal(row.tier, 'approved_only', JSON.stringify(row));
  assert.deepEqual(row.sectionEvidenceIds, []);
});

test('没有答案 → blank', async () => {
  await createGap(projectId, { label: '优惠政策' });

  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  const row = result.body.gaps.find((gap: any) => gap.label === '优惠政策');
  assert.equal(row.tier, 'blank');
});

test('汇总带口径说明,且不承诺这是质量评分', async () => {
  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  assert.match(result.body.note, /不是内容质量评分/u);
  assert.match(result.body.note, /保守下界/u);
  assert.equal(typeof result.body.canGenerate, 'boolean');
});

test('只返回本项目的缺口,不串项目', async () => {
  await createGap(otherProjectId, { label: '别的项目的缺口', answer: '不该出现' });

  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  const labels = result.body.gaps.map((gap: any) => gap.label);
  assert.ok(!labels.includes('别的项目的缺口'), '跨项目缺口泄漏');
});

test('空知识库项目也能预检,不报 500', async () => {
  // 没有任何知识文件时 evidenceDocumentSelection 走 EMPTY_SELECTION 分支。
  const result = await request(`/api/projects/${otherProjectId}/knowledge/preflight`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const row = result.body.gaps.find((gap: any) => gap.label === '别的项目的缺口');
  // 无资料可依,单行答案仍可自证
  assert.equal(row.tier, 'approved_only');
});

test('传了资料但没分析过 → analysis=missing 且 canGenerate=false', async () => {
  /*
   * 用户实际遇到的场景:上传知识库后页面显示「可以生成,缺口都已落实」。
   * 那时项目没有 project_intelligence 行,缺口数为 0,旧实现据此判可生成。
   * 这条守住真实链路——分析状态是从库里读的,不是前端猜的。
   */
  const fresh = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '只传资料未分析', domain: '装修' }) });
  const freshId = fresh.body.id;
  await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({ projectId: freshId, filename: 'a.md', content: PRICE_CONTENT, category: 'fact', evidenceStatus: 'observed' }),
  });

  const result = await request(`/api/projects/${freshId}/knowledge/preflight`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.analysis, 'missing');
  assert.equal(result.body.canGenerate, false, '没分析过不能说可以生成');
  assert.deepEqual(result.body.gaps, [], '还没有缺口');
});

test('引用真实存在的证据 → 不报失效(误报回归守卫)', async () => {
  /*
   * 线上误报的形态:每条缺口都挂「有 N 条引用的证据已经找不到了」,实测 69 条引用里
   * 只有 1 条真失效。根因是拿「支撑这条答案的分节」当成了「存在的分节」。
   *
   * 单测能覆盖判据,但覆盖不了「服务端有没有把全集传进去」——所以要在真实链路上验。
   */
  const sections = await request(`/api/projects/${projectId}/knowledge/evidence-sections`);
  const realEvidenceId = sections.body.documents[0]?.sections[0]?.evidenceId as string;
  assert.ok(realEvidenceId, '需要一条真实证据 id 才能验');

  // 答案故意写成资料里没有的句子:引用有效,但内容不支撑答案
  await createGap(projectId, {
    label: '引用有效但答案无支撑',
    answer: '这句话资料里没有原文',
    evidenceIds: [realEvidenceId],
  });

  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  const row = result.body.gaps.find((gap: any) => gap.label === '引用有效但答案无支撑');
  assert.deepEqual(row.staleDeclaredEvidenceIds, [], '引用还在就不能报失效');
  assert.doesNotMatch(row.reasons.join(''), /失效/u);
});

test('引用失效的 supplied_fact 缺口,接口返回 evidence_stale', async () => {
  /*
   * sourceStatus 必须真的到达分档。
   *
   * preflight() 直接读 data_json 而不经 normalizeGap,漏传这个字段的话 evidence_stale
   * 永远不触发,Task 1 的判据从接口上看不出效果——分档函数的单测抓不到这种断链。
   */
  await createGapWithSourceStatus(
    projectId,
    // 答案单行(能自证),引用一个不存在的证据 id(失效实证),内容与已上传资料无关
    { label: '门店地址', answer: '门店在城南老街的临街铺面', evidenceIds: ['evidence_section_已删除的资料_1'] },
    'supplied_fact',
  );

  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const row = result.body.gaps.find((gap: any) => gap.label === '门店地址');
  assert.equal(row.tier, 'evidence_stale', JSON.stringify(row));
  assert.ok(result.body.tiers.evidence_stale >= 1, JSON.stringify(result.body.tiers));
});

test('认不出的 sourceStatus 不会污染分档', async () => {
  // 库里实测存在的历史脏值,不在 GAP_SOURCE_STATUSES 之内:不能被当成 supplied_fact。
  await createGapWithSourceStatus(
    projectId,
    { label: '停车方式', answer: '门口可以临时停车', evidenceIds: ['evidence_section_已删除的资料_2'] },
    'unacknowledged',
  );

  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  const row = result.body.gaps.find((gap: any) => gap.label === '停车方式');
  assert.equal(row.tier, 'approved_only', JSON.stringify(row));
});

test('未登录取不到预检', async () => {
  const saved = cookie;
  cookie = '';
  const result = await request(`/api/projects/${projectId}/knowledge/preflight`);
  cookie = saved;
  assert.equal(result.response.status, 401);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import { KnowledgeService } from '../src/knowledge.service.js';
import type { SessionPrincipal } from '../src/models.js';

let app: NestExpressApplication;
let dataDir = '';
let projectId = '';
let principal: SessionPrincipal;

const PASSWORD = 'Analysis-race-bootstrap-123!';
const NEW_PASSWORD = 'Analysis-race-updated-456!';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-analysis-race-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'analysis-race-encryption-key',
    platformApiKey: '',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  let cookie = '';
  let csrf = '';
  const request = async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('cookie', cookie);
    if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
    if (typeof options.body === 'string') headers.set('content-type', 'application/json');
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    return { response, body };
  };
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '分析并发保护项目' }),
  });
  projectId = project.body.id;
  principal = {
    kind: 'session',
    userId: login.body.user.id,
    username: 'admin',
    systemRole: 'admin',
    userKind: 'research',
    mustChangePassword: false,
    tokenHash: '',
    csrfHash: '',
  };
  await app.get(KnowledgeService).import({
    projectId,
    filename: 'facts.md',
    content: '# 第一版\n\n分析开始时的资料。',
    evidenceStatus: '已知事实',
    principal,
  });
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('分析期间知识版本变化时，旧快照不能落库', async () => {
  const intelligence = app.get(IntelligenceService);
  const original = (intelligence as any).analyzeWithCurrentModel;
  let releaseFirstStage!: () => void;
  let firstStageStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStageStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirstStage = resolve; });
  let stage = 0;
  (intelligence as any).analyzeWithCurrentModel = async () => {
    stage += 1;
    if (stage === 1) {
      firstStageStarted();
      await release;
      return {
        intelligence: { projectSummary: '基于旧资料的分析' },
        blueprintModules: {
          knowledge_map: {}, domain_model: {}, audience_model: {}, scenario_model: {},
          role_model: {}, claim_policy: {}, surface_language: {},
        },
      };
    }
    if (stage === 2) {
      return {
        informationGaps: [{ key: 'old-gap', title: '旧资料缺口', sourceStatus: 'unknown' }],
        expressionStrategies: [],
      };
    }
    return { topicOpportunities: [] };
  };

  try {
    const running = intelligence.analyzeProject(projectId, principal, true);
    await started;
    await app.get(KnowledgeService).import({
      projectId,
      filename: 'facts.md',
      content: '# 第二版\n\n分析执行期间上传的新资料。',
      evidenceStatus: '已知事实',
      principal,
    });
    releaseFirstStage();

    await assert.rejects(running, /资料在分析期间发生了变化|重新分析/);
    const db = app.get(DatabaseService);
    assert.equal(
      Number((db.prepare('SELECT COUNT(*) AS count FROM project_intelligence WHERE project_id=?').get(projectId) as { count: number }).count),
      0,
      '过期分析不能留下 project_intelligence',
    );
    assert.equal(
      Number((db.prepare('SELECT COUNT(*) AS count FROM information_gaps WHERE project_id=?').get(projectId) as { count: number }).count),
      0,
      '过期分析不能留下缺口',
    );
    const task = db.prepare(
      "SELECT status FROM analysis_tasks WHERE project_id=? AND kind='project' ORDER BY created_at DESC LIMIT 1",
    ).get(projectId) as { status: string };
    assert.equal(task.status, 'failed');
  } finally {
    (intelligence as any).analyzeWithCurrentModel = original;
  }
});

test('新分析淘汰旧分析批次，但保留人工创建并批准的缺口', async () => {
  const db = app.get(DatabaseService);
  const now = new Date().toISOString();
  const oldTaskId = 'old-analysis-task';
  const oldResultId = 'old-analysis-result';
  db.prepare(
    `INSERT INTO analysis_tasks
     (id, project_id, kind, target_id, status, source_fingerprint, attempt_count, result_id,
      created_by, created_at, updated_at, completed_at)
     VALUES (?, ?, 'project', NULL, 'completed', 'old-fingerprint', 1, ?, ?, ?, ?, ?)`,
  ).run(oldTaskId, projectId, oldResultId, principal.userId, now, now, now);
  db.prepare(
    `INSERT INTO project_intelligence
     (id, project_id, version, status, source_fingerprint, map_json, created_by, created_at, updated_at,
      approved_by, approved_at)
     VALUES (?, ?, 1, 'approved', 'old-fingerprint', '{}', ?, ?, ?, ?, ?)`,
  ).run(oldResultId, projectId, principal.userId, now, now, principal.userId, now);
  db.prepare(
    `INSERT INTO information_gaps
     (id, project_id, title, priority, status, source_analysis_id, data_json, created_by,
      created_at, updated_at, approved_by, approved_at)
     VALUES ('old-analysis-gap', ?, '旧分析缺口', 50, 'approved', ?,
      '{"sourceStatus":"unknown"}', ?, ?, ?, ?, ?)`,
  ).run(projectId, oldTaskId, principal.userId, now, now, principal.userId, now);
  db.prepare(
    `INSERT INTO information_gaps
     (id, project_id, title, priority, status, source_analysis_id, data_json, created_by,
      created_at, updated_at, approved_by, approved_at)
     VALUES ('manual-approved-gap', ?, '人工批准缺口', 50, 'approved', NULL,
      '{"answer":"人工核实答案","sourceStatus":"user_supplied"}', ?, ?, ?, ?, ?)`,
  ).run(projectId, principal.userId, now, now, principal.userId, now);

  const intelligence = app.get(IntelligenceService);
  const original = (intelligence as any).analyzeWithCurrentModel;
  let stage = 0;
  (intelligence as any).analyzeWithCurrentModel = async () => {
    stage += 1;
    if (stage === 1) {
      return {
        intelligence: { projectSummary: '新分析' },
        blueprintModules: {
          knowledge_map: {}, domain_model: {}, audience_model: {}, scenario_model: {},
          role_model: {}, claim_policy: {}, surface_language: {},
        },
      };
    }
    if (stage === 2) {
      return {
        informationGaps: [{ key: 'new-gap', title: '新分析缺口', sourceStatus: 'unknown' }],
        expressionStrategies: [],
      };
    }
    return { topicOpportunities: [] };
  };

  try {
    const result = await intelligence.analyzeProject(projectId, principal, true);
    assert.equal((result.intelligence as Record<string, unknown>).status, 'draft');
    assert.equal(
      (db.prepare('SELECT status FROM project_intelligence WHERE id=?').get(oldResultId) as { status: string }).status,
      'stale',
    );
    assert.equal(
      (db.prepare("SELECT status FROM information_gaps WHERE id='old-analysis-gap'").get() as { status: string }).status,
      'stale',
    );
    assert.equal(
      (db.prepare("SELECT status FROM information_gaps WHERE id='manual-approved-gap'").get() as { status: string }).status,
      'approved',
      '人工缺口不属于旧分析派生产物，不能被重跑误伤',
    );
    const currentIds = intelligence.listGaps(projectId).map((gap) => String(gap.id));
    assert.ok(currentIds.includes('manual-approved-gap'));
    assert.ok(currentIds.some((id) => !['old-analysis-gap', 'manual-approved-gap'].includes(id)));
    assert.equal(currentIds.includes('old-analysis-gap'), false);
  } finally {
    (intelligence as any).analyzeWithCurrentModel = original;
  }
});

test('选题刷新期间知识版本变化时，旧输入结果不能落库', async () => {
  const intelligence = app.get(IntelligenceService);
  const original = (intelligence as any).analyzeWithCurrentModel;
  let releaseModel!: () => void;
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseModel = resolve; });
  (intelligence as any).analyzeWithCurrentModel = async () => {
    modelStarted();
    await release;
    return { topicOpportunities: [{ title: '基于旧资料的选题' }] };
  };

  try {
    const running = intelligence.refreshTopicOpportunities(projectId, principal, { userGuidance: '竞态检查' });
    await started;
    await app.get(KnowledgeService).import({
      projectId,
      filename: 'facts.md',
      content: '# 第三版\n\n选题刷新期间上传的新资料。',
      evidenceStatus: '已知事实',
      principal,
    });
    releaseModel();

    await assert.rejects(running, /选题刷新期间发生了变化|本次结果未保存/);
    const db = app.get(DatabaseService);
    assert.equal(
      Number((db.prepare("SELECT COUNT(*) AS count FROM topic_opportunities WHERE title='基于旧资料的选题'").get() as { count: number }).count),
      0,
    );
    const task = db.prepare(
      "SELECT status FROM analysis_tasks WHERE project_id=? AND source_fingerprint LIKE '%:topic-refresh:%' ORDER BY created_at DESC LIMIT 1",
    ).get(projectId) as { status: string };
    assert.equal(task.status, 'failed');
  } finally {
    releaseModel?.();
    (intelligence as any).analyzeWithCurrentModel = original;
  }
});

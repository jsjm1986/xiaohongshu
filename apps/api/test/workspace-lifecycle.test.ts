import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

/**
 * 数据主权两端点(医美行业客户数据敏感度高):
 * - 导出:「给我数据」——结构化 JSON 一次带走,知识原文内联;
 * - 物理清除:「删我数据」——仅对已软删工作区,级联硬删+盘上文件清理,
 *   审计刻意留痕(删除动作本身必须可追溯)。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';

async function call(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { response, body };
}

const post = (path: string, body: Record<string, unknown> = {}) => call(path, { method: 'POST', body: JSON.stringify(body) });

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-lifecycle-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'workspace-lifecycle-master-key!!',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await post('/api/auth/login', { username: 'admin', password: 'Admin-bootstrap-123!' });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await post('/api/auth/change-password', { currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' });
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('工作区导出带全量结构化数据与知识原文；物理清除仅对软删工作区且清盘上文件', async () => {
  const workspace = await post('/api/workspaces', { name: '生命周期测试' });
  assert.equal(workspace.response.status, 201, JSON.stringify(workspace.body));
  const workspaceId = String(workspace.body.id);
  const project = await post('/api/projects', { name: '生命周期项目', domain: '眼袋', workspaceId });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  const projectId = String(project.body.id);
  const knowledge = await post('/api/knowledge', {
    projectId, filename: 'facts.md', category: 'facts', evidenceStatus: 'observed',
    content: '# 事实\n\n恢复期一般一周。', metadata: { kind: 'fact' },
  });
  assert.equal(knowledge.response.status, 201, JSON.stringify(knowledge.body));

  // 导出:结构齐全,知识原文内联
  const exported = await call(`/api/admin/workspaces/${workspaceId}/export`);
  assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
  assert.match(exported.response.headers.get('content-disposition') ?? '', /attachment/u);
  assert.equal(exported.body.workspace.id, workspaceId);
  assert.equal(exported.body.projects.length, 1);
  assert.equal(exported.body.knowledgeFiles.length, 1);
  assert.match(String(exported.body.knowledgeFiles[0].content), /恢复期一般一周/u);

  // 物理清除的二段式:未软删 → 拒绝
  const early = await call(`/api/admin/workspaces/${workspaceId}/purge`, { method: 'DELETE' });
  assert.equal(early.response.status, 400);
  assert.match(String(early.body.message), /先删除工作区/u);

  const database = app.get(DatabaseService);
  // storage_path 相对 dataDir 存储
  const storagePath = join(dataDir, String((database.prepare(
    'SELECT k.storage_path FROM knowledge_files k JOIN projects p ON p.id=k.project_id WHERE p.workspace_id=?',
  ).get(workspaceId) as { storage_path: string }).storage_path));
  assert.ok(existsSync(storagePath), '盘上知识原文应存在');

  // 软删 → 物理清除
  const softDeleted = await call(`/api/workspaces/${workspaceId}`, { method: 'DELETE' });
  assert.equal(softDeleted.response.status, 200, JSON.stringify(softDeleted.body));
  const purged = await call(`/api/admin/workspaces/${workspaceId}/purge`, { method: 'DELETE' });
  assert.equal(purged.response.status, 200, JSON.stringify(purged.body));
  assert.equal(purged.body.knowledgeFilesRemoved, 1);

  // 业务行级联清空,盘上文件删除,审计留痕
  assert.equal(database.prepare('SELECT COUNT(*) AS v FROM workspaces WHERE id=?').get(workspaceId)!.v, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS v FROM projects WHERE workspace_id=?').get(workspaceId)!.v, 0);
  assert.equal(existsSync(storagePath), false, '盘上知识原文必须物理删除');
  const auditRow = database.prepare(
    "SELECT COUNT(*) AS v FROM audit_logs WHERE action='workspace.purge' AND entity_id=?",
  ).get(workspaceId) as { v: number };
  assert.equal(Number(auditRow.v), 1, '物理清除动作必须留审计痕迹');
});

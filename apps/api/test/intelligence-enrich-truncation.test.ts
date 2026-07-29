import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceEnrichService } from '../src/intelligence-enrich.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';

/*
  两件事必须对上层可见,不能静默发生:

  1. 单次起草上限(MAX_DRAFT_GAPS)截断。入口按钮写的是真实待补总数,
     实收少于它的时候用户得知道少了几条,否则是静默丢数据。
  2. 知识文件正文读不出来。原先直接抛 ENOENT,冒到 500,前端弹窗显示服务端
     英文原文「Internal server error」。
*/

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';
let enrich: IntelligenceEnrichService;
let database: DatabaseService;
let principal: { userId: string; systemRole: string };

const PASSWORD = 'Truncate-bootstrap-123!';
const NEW_PASSWORD = 'Truncate-updated-456!';
const LIMIT = 15;

let modelReply: Record<string, unknown> = { items: [] };

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

async function createGap(title: string) {
  const res = await request(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({ title, question: `${title}的具体情况?`, sourceStatus: 'unknown' }),
  });
  assert.equal(res.response.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-truncate-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  principal = { userId: login.body.user?.id ?? login.body.id, systemRole: 'admin' };

  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201, JSON.stringify(changed.body));

  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '截断与缺文件项目', domain: '装修' }),
  });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = project.body.id;

  enrich = app.get(IntelligenceEnrichService);
  database = app.get(DatabaseService);
  const intelligence = app.get(IntelligenceService);
  (intelligence as unknown as Record<string, unknown>).runEnrichmentModel = async () => modelReply;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('待补超过单次上限时回报真实总数,不是截断后的条数', async () => {
  await request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({
      filename: '资料.md',
      content: '## 报价说明\n整装报价按平米计,含主材。\n\n## 工期\n常规两居 45 天。',
      category: '未分类',
      evidenceStatus: '已知事实',
    }),
  });

  const total = LIMIT + 2;
  const ids: string[] = [];
  for (let index = 0; index < total; index += 1) ids.push(await createGap(`缺口${index + 1}`));

  // 模型对收到的每条都作答,所以实收条数 = 截断后的条数
  modelReply = {
    items: ids.map((gapId) => ({
      gapId,
      content: '### 小标题\n\n这是一段足够长的补充内容,用于通过最短长度校验。',
      confidence: 'medium',
    })),
  };

  const result = await enrich.generateEnrichmentDraft(projectId, principal as never);
  assert.equal(result.gaps.length, LIMIT, '起草条数应当被上限截断');
  assert.equal(result.totalPending, total, 'totalPending 必须是截断前的真实总数');
  assert.equal(result.limit, LIMIT, '要把上限一并回报,前端才能分辨截断与漏答');
  assert.deepEqual(result.unreadableFiles, [], '文件都在,不该报读取失败');
});

test('正文读不出来时跳过该文件,并在结果里点名', async () => {
  const upload = await request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({
      filename: '会丢的文件.md',
      content: '## 售后\n保修两年,含五金件。',
      category: '未分类',
      evidenceStatus: '已知事实',
    }),
  });
  assert.equal(upload.response.status, 201, JSON.stringify(upload.body));

  // 制造存储层丢文件:库里有行,磁盘上没有正文
  const row = database
    .prepare('SELECT storage_path FROM knowledge_files WHERE id = ?')
    .get(upload.body.id) as { storage_path: string };
  const absolute = join(dataDir, row.storage_path);
  const backup = await readFile(absolute);
  await rm(absolute);

  try {
    const gapId = await createGap('售后条款');
    modelReply = {
      items: [{
        gapId,
        content: '### 售后\n\n这是一段足够长的补充内容,用于通过最短长度校验。',
        confidence: 'medium',
      }],
    };

    const result = await enrich.generateEnrichmentDraft(projectId, principal as never);
    // 另一份资料还在,所以起草照常完成——一个文件丢了不该让整批失败
    assert.ok(result.gaps.length > 0, '还有可读资料时应当照常起草');
    assert.deepEqual(result.unreadableFiles, ['会丢的文件.md'], '读不出的文件要点名回报');
  } finally {
    await writeFile(absolute, backup);
  }
});

test('一份资料都读不出来时给中文提示,不是 ENOENT', async () => {
  // 把所有文件正文都挪走,模拟存储目录整体失联
  const rows = database
    .prepare('SELECT id, storage_path FROM knowledge_files WHERE project_id = ? AND deleted_at IS NULL')
    .all(projectId) as Array<{ id: string; storage_path: string }>;
  assert.ok(rows.length > 0, '前置:项目里得有知识文件');

  const backups: Array<{ path: string; data: Buffer }> = [];
  for (const row of rows) {
    const absolute = join(dataDir, row.storage_path);
    backups.push({ path: absolute, data: await readFile(absolute) });
    await rm(absolute);
  }

  try {
    await assert.rejects(
      () => enrich.generateEnrichmentDraft(projectId, principal as never),
      (error: Error) => {
        // 关键:不能是 ENOENT 冒到 500。要中文、要点名文件、要给可执行的下一步
        assert.doesNotMatch(error.message, /ENOENT|no such file/i, '不能把系统错误原样抛给用户');
        assert.match(error.message, /读取失败/, '要说明是读取失败');
        assert.match(error.message, /重新上传|检查文件/, '要给出可执行的下一步');
        return true;
      },
    );
  } finally {
    for (const item of backups) await writeFile(item.path, item.data);
  }
});

test('合并目标文件读不出来时拒绝合并,避免丢掉原文', async () => {
  /*
   * 这条比起草更要紧:合并会把结果存成同名文件的新版本。原文读不出来却继续,
   * 就会把原文当成空的,合并结果里整份既有内容凭空消失——用户点「确认保存」
   * 之后才发现,而那时新版本已经落库了。
   */
  const target = '合并目标.md';
  const upload = await request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({
      filename: target,
      content: '## 既有内容\n这一段绝对不能在合并后消失。',
      category: '未分类',
      evidenceStatus: '已知事实',
    }),
  });
  assert.equal(upload.response.status, 201, JSON.stringify(upload.body));

  const row = database
    .prepare('SELECT storage_path FROM knowledge_files WHERE id = ?')
    .get(upload.body.id) as { storage_path: string };
  const absolute = join(dataDir, row.storage_path);
  const backup = await readFile(absolute);
  await rm(absolute);

  try {
    const gapId = await createGap('合并用缺口');
    modelReply = { document: '## 合并结果\n只有补充内容,原文没了。' };
    await assert.rejects(
      () => enrich.mergeEnrichedKnowledge(
        projectId,
        [{ gapId, status: 'confirmed', content: '这是一段足够长的补充内容,用于通过校验。' }],
        target,
        principal as never,
      ),
      (error: Error) => {
        assert.doesNotMatch(error.message, /ENOENT|no such file/i);
        assert.match(error.message, /读取失败/);
        return true;
      },
    );
  } finally {
    await writeFile(absolute, backup);
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../src/app.js';
import { importLegacy } from '../../../scripts/import-legacy.js';

test('legacy importer creates projects and skips identical data on a second run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'content-agent-import-'));
  const dataDir = join(root, 'data');
  const sourceDir = join(root, 'legacy');
  const projectsDir = join(sourceDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await writeFile(
    join(projectsDir, 'sample.json'),
    JSON.stringify({
      id: 'sample-project',
      name: '示例项目',
      domain: '测试领域',
      product_points: ['信息点一'],
    }),
    'utf8',
  );
  await writeFile(join(projectsDir, 'index.json'), JSON.stringify(['sample-project']), 'utf8');
  await writeFile(join(sourceDir, '医美种草方法论_最终版.md'), '# 方法论\n\n正文', 'utf8');
  await writeFile(join(sourceDir, '提示词_纯文本版.txt'), '提示词正文', 'utf8');
  await writeFile(join(sourceDir, '无关报告.md'), '# 不应导入', 'utf8');

  const initialPassword = 'Importer-bootstrap-123!';
  const password = 'Importer-updated-456!';
  const app = await createApplication({
    dataDir,
    adminPassword: initialPassword,
    secureCookies: false,
    logger: false,
  });
  try {
    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: initialPassword }),
    });
    assert.equal(loginResponse.status, 201);
    const loginBody = (await loginResponse.json()) as { csrfToken: string };
    const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const changeResponse = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-csrf-token': loginBody.csrfToken,
      },
      body: JSON.stringify({ currentPassword: initialPassword, newPassword: password }),
    });
    assert.equal(changeResponse.status, 201);

    const options = { source: sourceDir, baseUrl, username: 'admin', password };
    const first = await importLegacy(options);
    assert.deepEqual(first, {
      projectsCreated: 1,
      projectsSkipped: 0,
      filesImported: 2,
      filesSkipped: 0,
    });

    const second = await importLegacy(options);
    assert.deepEqual(second, {
      projectsCreated: 0,
      projectsSkipped: 1,
      filesImported: 0,
      filesSkipped: 2,
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

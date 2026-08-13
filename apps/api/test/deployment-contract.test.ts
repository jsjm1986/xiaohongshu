import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const rootFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('Docker Compose 强制生产模式并把数据写入挂载的 /data', () => {
  const compose = rootFile('docker-compose.yml');
  assert.match(compose, /NODE_ENV:\s*production/u);
  assert.match(compose, /CONTENT_AGENT_DATA_DIR:\s*\/data/u);
  assert.match(compose, /CONTENT_AGENT_DB_PATH:\s*\/data\/app\.db/u);
  assert.match(compose, /\.\/data:\/data/u);
});

test('Docker Compose 文件通过真实 compose config 解析且不启动容器', (context) => {
  const availability = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
  });
  if (availability.error || availability.status !== 0) {
    context.skip(
      `当前环境无 docker compose，跳过真实解析：${availability.error?.message ?? availability.stderr.trim()}`,
    );
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'content-agent-compose-config-'));
  try {
    const composePath = join(work, 'compose.yaml');
    writeFileSync(composePath, rootFile('docker-compose.yml'), 'utf8');
    writeFileSync(
      join(work, '.env'),
      'NODE_ENV=production\nMASTER_ENCRYPTION_KEY=compose-config-test-only\n',
      'utf8',
    );
    const parsed = spawnSync(
      'docker',
      ['compose', '--project-directory', work, '-f', composePath, 'config', '--quiet'],
      { encoding: 'utf8' },
    );
    assert.equal(
      parsed.status,
      0,
      `docker compose config --quiet 失败：${parsed.stderr || parsed.stdout}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('生产环境示例只认显式 master key，并记录轮换与 fake-IP 例外', () => {
  const example = rootFile('.env.example');
  const readme = rootFile('README.md');
  assert.match(example, /^NODE_ENV=production$/mu);
  assert.match(example, /^MASTER_ENCRYPTION_KEY=$/mu);
  assert.match(example, /^# MASTER_ENCRYPTION_KEY_PREVIOUS=$/mu);
  assert.match(example, /^# CONTENT_AGENT_DB_PATH=\.\/data\/app\.db$/mu);
  assert.match(example, /CONTENT_AGENT_BYOK_ALLOW_PROXY_FAKE_IP=false/u);
  assert.doesNotMatch(example, /^SESSION_SECRET=/mu);
  assert.doesNotMatch(readme, /修改初始管理员密码、SESSION_SECRET/u);
  assert.match(readme, /NODE_ENV=development/u, '本地启动必须明确覆盖生产模板模式');
});

test('生产 start 严格要求 .env 存在，开发 watch 才允许缺省', () => {
  const pkg = JSON.parse(rootFile('apps/api/package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts.start, 'node --env-file=../../.env dist/main.js');
  assert.match(pkg.scripts.dev ?? '', /--env-file-if-exists=/u);
});

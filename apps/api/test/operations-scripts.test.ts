import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { resolveOptions } from '../src/config.js';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '../../..');
const backupScript = join(root, 'scripts/backup-production.sh');
const backupHelper = join(root, 'scripts/prepare-backup.mjs');
const backupManifestHelper = join(root, 'scripts/backup-manifest.mjs');
const storagePathsModule = join(root, 'scripts/storage-paths.mjs');
const healthScript = join(root, 'scripts/health-watch.sh');

const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

async function loadPrepareBackup() {
  return import(`${pathToFileURL(backupHelper).href}?test=${Date.now()}-${Math.random()}`) as Promise<{
    prepareBackup: (
      repositoryRoot: string,
      stageDir: string,
      hooks?: {
        afterDatabaseSnapshot?: () => Promise<void>;
        afterFilesCopied?: (filesTarget: string) => Promise<void>;
      },
    ) => Promise<void>;
  }>;
}

function createStorageFixtureDatabase(
  path: string,
  rows: Array<{
    table: 'knowledge_files' | 'image_assets';
    storagePath: string;
    content: string;
    deletedAt?: string | null;
  }>,
) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE knowledge_files (
      storage_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE image_assets (
      storage_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  for (const row of rows) {
    database.prepare(
      `INSERT INTO ${row.table} (storage_path, bytes, sha256, deleted_at) VALUES (?,?,?,?)`,
    ).run(
      row.storagePath,
      Buffer.byteLength(row.content),
      sha256(row.content),
      row.deletedAt ?? null,
    );
  }
  database.close();
}

async function createMinimalBackupRepository(repository: string) {
  await mkdir(join(repository, 'data'), { recursive: true });
  await writeFile(join(repository, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
  const database = new DatabaseSync(join(repository, 'data/app.db'));
  database.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('safe-destination')");
  database.close();
}

async function startHealthServer(
  payload: Record<string, unknown> = { status: 'ok', databaseWritable: true },
  statusCode = 200,
) {
  const server = createServer((_request, response) => {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/health`,
  };
}

async function runHealthWatch(
  work: string,
  healthUrl: string,
  overrides: NodeJS.ProcessEnv = {},
) {
  const logs = join(work, 'logs');
  const support = join(work, 'support');
  await mkdir(logs, { recursive: true });
  await mkdir(support, { recursive: true });
  return execFile('bash', [healthScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: work,
      PATH: `${join(work, 'bin')}:${process.env.PATH ?? ''}`,
      CONTENT_AGENT_ROOT: work,
      CONTENT_AGENT_OPS_LOG_DIR: logs,
      CONTENT_AGENT_SUPPORT_DIR: support,
      CONTENT_AGENT_BACKUP_DIR: join(work, 'backups'),
      CONTENT_AGENT_BACKUP_HELPER: backupHelper,
      CONTENT_AGENT_NODE_BIN: process.execPath,
      OPS_ENV_FILE: join(work, 'missing-ops.env'),
      HEALTH_URL: healthUrl,
      PUBLIC_HEALTH_URL: '',
      ALERT_WEBHOOK: '',
      ...overrides,
    },
  });
}

async function installWatchCommandFakes(
  work: string,
  launchctlOutput = 'active count = 0\nlast exit code = 0\n',
) {
  const bin = join(work, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'launchctl'),
    `#!/bin/sh\nprintf '%b' ${JSON.stringify(launchctlOutput)}\n`,
    'utf8',
  );
  await writeFile(join(bin, 'osascript'), '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(join(bin, 'launchctl'), 0o700);
  await chmod(join(bin, 'osascript'), 0o700);
}

async function createBackupPair(
  work: string,
  stamp: string,
  options: { corruptDatabase?: boolean } = {},
) {
  const backupDir = join(work, 'backups');
  const source = join(work, `backup-files-${stamp}`);
  const database = join(backupDir, `app-${stamp}.db.gz`);
  const files = join(backupDir, `files-${stamp}.tar.gz`);
  await mkdir(join(source, 'data'), { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(source, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
  await writeFile(join(source, 'data/marker.txt'), 'files\n', 'utf8');
  await writeFile(
    database,
    options.corruptDatabase ? 'not-a-gzip' : gzipSync(Buffer.from('sqlite-snapshot')),
  );
  await execFile('tar', ['-czf', files, '-C', source, '.env', 'data']);
  await rm(source, { recursive: true, force: true });
  return { database, files };
}

async function readAlertLog(work: string) {
  try {
    return await readFile(join(work, 'logs/alerts.log'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function waitForEarlySecond() {
  while (Date.now() % 1000 > 80) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test('备份脚本以 600 权限归档数据库、知识、图片与环境文件，远端同步不删除既有文件', async (t) => {
  if (spawnSync('rsync', ['--version']).status !== 0) {
    t.skip('运行环境没有 rsync');
    return;
  }
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-contract-'));
  const remote = join(work, 'remote');
  try {
    await mkdir(join(work, 'data/knowledge'), { recursive: true });
    await mkdir(join(work, 'data/images'), { recursive: true });
    await mkdir(remote, { recursive: true });
    await writeFile(join(work, 'data/knowledge/fact.md'), '# fact\n', 'utf8');
    await writeFile(join(work, 'data/images/source.webp'), 'image-bytes', 'utf8');
    await writeFile(join(work, '.env'), 'MASTER_ENCRYPTION_KEY=test-only\n', 'utf8');
    await writeFile(join(remote, 'keep.txt'), 'must survive sync\n', 'utf8');

    const database = new DatabaseSync(join(work, 'data/app.db'));
    database.exec("CREATE TABLE proof(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO proof(value) VALUES ('ok');");
    database.close();

    await execFile('bash', [backupScript], {
      env: {
        ...process.env,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: join(work, 'data/backups/auto'),
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_REMOTE: `${remote}/`,
      },
    });

    const names = await readdir(join(work, 'data/backups/auto'));
    const dbName = names.find((name) => name.endsWith('.db.gz'));
    const filesName = names.find((name) => name.startsWith('files-') && name.endsWith('.tar.gz'));
    assert.ok(dbName);
    assert.ok(filesName);
    assert.equal(
      names.filter((name) => name.startsWith('.') && name !== '.content-agent-backup-dir').length,
      0,
      '成功后不得残留临时归档',
    );
    assert.equal((await stat(join(work, 'data/backups/auto', dbName))).mode & 0o777, 0o600);
    assert.equal((await stat(join(work, 'data/backups/auto', filesName))).mode & 0o777, 0o600);

    const listing = await execFile('tar', ['-tzf', join(work, 'data/backups/auto', filesName)], {
      encoding: 'utf8',
    });
    assert.match(listing.stdout, /data\/knowledge\/fact\.md/u);
    assert.match(listing.stdout, /data\/images\/source\.webp/u);
    assert.match(listing.stdout, /\.env/u);
    assert.equal(await readFile(join(remote, 'keep.txt'), 'utf8'), 'must survive sync\n');
    assert.ok((await readdir(remote)).some((name) => name.endsWith('.db.gz')));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份从仓库 .env 解析自定义 dataDir 与独立 databasePath，不会归档旧默认库', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-paths-'));
  const customData = join(work, 'runtime-data');
  const databasePath = join(work, 'database/live.sqlite');
  const backupDir = join(work, 'backups');
  try {
    await mkdir(join(work, 'data/knowledge'), { recursive: true });
    await mkdir(join(work, 'data/images'), { recursive: true });
    await mkdir(join(customData, 'knowledge'), { recursive: true });
    await mkdir(join(customData, 'images'), { recursive: true });
    await mkdir(join(work, 'database'), { recursive: true });
    await writeFile(join(work, 'data/knowledge/fact.md'), '旧知识\n', 'utf8');
    await writeFile(join(work, 'data/images/source.webp'), 'old-image', 'utf8');
    await writeFile(join(customData, 'knowledge/fact.md'), '新知识\n', 'utf8');
    await writeFile(join(customData, 'images/source.webp'), 'new-image', 'utf8');
    await writeFile(
      join(work, '.env'),
      [
        'CONTENT_AGENT_DATA_DIR=./runtime-data',
        `CONTENT_AGENT_DB_PATH=${databasePath}`,
        'MASTER_ENCRYPTION_KEY=test-only',
        '',
      ].join('\n'),
      'utf8',
    );

    const oldDatabase = new DatabaseSync(join(work, 'data/app.db'));
    oldDatabase.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('old');");
    oldDatabase.close();
    const liveDatabase = new DatabaseSync(databasePath);
    liveDatabase.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('new');");
    liveDatabase.close();

    await execFile('bash', [backupScript], {
      env: {
        ...process.env,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: backupDir,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_REMOTE: '',
      },
    });

    const names = await readdir(backupDir);
    const dbName = names.find((name) => name.endsWith('.db.gz'));
    const filesName = names.find((name) => name.startsWith('files-') && name.endsWith('.tar.gz'));
    assert.ok(dbName);
    assert.ok(filesName);
    const snapshotPath = join(work, 'snapshot.db');
    await writeFile(snapshotPath, gunzipSync(await readFile(join(backupDir, dbName))));
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      assert.equal(snapshot.prepare('SELECT value FROM proof').get()?.value, 'new');
    } finally {
      snapshot.close();
    }
    const knowledge = await execFile(
      'tar',
      ['-xOf', join(backupDir, filesName), 'data/knowledge/fact.md'],
      { encoding: 'utf8' },
    );
    const image = await execFile(
      'tar',
      ['-xOf', join(backupDir, filesName), 'data/images/source.webp'],
      { encoding: 'utf8' },
    );
    assert.equal(knowledge.stdout, '新知识\n');
    assert.equal(image.stdout, 'new-image');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('prepare-backup 在数据库快照后源文件被删除时拒绝 staging', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-prepare-delete-race-'));
  const dataDir = join(work, 'data');
  const source = join(dataDir, 'knowledge/race.md');
  try {
    await mkdir(join(dataDir, 'knowledge'), { recursive: true });
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await writeFile(source, 'snapshot-content', 'utf8');
    createStorageFixtureDatabase(join(dataDir, 'app.db'), [{
      table: 'knowledge_files',
      storagePath: 'knowledge/race.md',
      content: 'snapshot-content',
    }]);
    const { prepareBackup } = await loadPrepareBackup();
    await assert.rejects(
      prepareBackup(work, join(work, 'stage'), {
        afterDatabaseSnapshot: async () => unlink(source),
      }),
      /knowledge_files.*knowledge\/race\.md.*missing/u,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('prepare-backup 在文件复制后内容改写时拒绝 staging', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-prepare-rewrite-race-'));
  const dataDir = join(work, 'data');
  try {
    await mkdir(join(dataDir, 'images'), { recursive: true });
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await writeFile(join(dataDir, 'images/source.webp'), 'expected-bytes', 'utf8');
    createStorageFixtureDatabase(join(dataDir, 'app.db'), [{
      table: 'image_assets',
      storagePath: 'images/source.webp',
      content: 'expected-bytes',
    }]);
    const { prepareBackup } = await loadPrepareBackup();
    await assert.rejects(
      prepareBackup(work, join(work, 'stage'), {
        afterFilesCopied: async (filesTarget) => {
          await writeFile(join(filesTarget, 'data/images/source.webp'), 'tampered-byte!', 'utf8');
        },
      }),
      /image_assets.*images\/source\.webp.*(?:bytes|sha256)/u,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('prepare-backup 拒绝活动资源 storage_path 逃逸 staging data 目录', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-prepare-path-escape-'));
  const dataDir = join(work, 'data');
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    createStorageFixtureDatabase(join(dataDir, 'app.db'), [{
      table: 'knowledge_files',
      storagePath: '../outside.md',
      content: 'outside',
    }]);
    const { prepareBackup } = await loadPrepareBackup();
    await assert.rejects(
      prepareBackup(work, join(work, 'stage')),
      /knowledge_files.*\.\.\/outside\.md.*escapes staging data/u,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份配置指向不存在的数据库时失败关闭且不回退默认旧库', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-fail-closed-'));
  const backupDir = join(work, 'backups');
  const shellMarker = join(work, 'env-must-not-execute');
  try {
    await mkdir(join(work, 'data'), { recursive: true });
    await writeFile(
      join(work, '.env'),
      `CONTENT_AGENT_DATA_DIR=./runtime-data\nCONTENT_AGENT_DB_PATH=$(touch ${shellMarker})\n`,
      'utf8',
    );
    const oldDatabase = new DatabaseSync(join(work, 'data/app.db'));
    oldDatabase.exec('CREATE TABLE old_data(value TEXT)');
    oldDatabase.close();

    const result = spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: backupDir,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_REMOTE: '',
      },
    });

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(shellMarker), false, '.env 必须按数据解析，不能交给 shell 执行');
    assert.equal(
      existsSync(backupDir)
        && (await readdir(backupDir)).some((name) => name.endsWith('.db.gz')),
      false,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份首个最终归档发布后收到 TERM 会清理整对与临时文件', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-publish-term-'));
  const backupDir = join(work, 'backups');
  const bin = join(work, 'bin');
  try {
    await mkdir(join(work, 'data'), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    const database = new DatabaseSync(join(work, 'data/app.db'));
    database.exec('CREATE TABLE proof(value TEXT)');
    database.close();
    const realMove = (await execFile('bash', ['-lc', 'command -v mv'], {
      encoding: 'utf8',
    })).stdout.trim();
    await writeFile(
      join(bin, 'mv'),
      [
        '#!/bin/sh',
        `${JSON.stringify(realMove)} "$@" || exit $?`,
        'case "${2:-}" in',
        '  */app-*.db.gz) kill -TERM "$PPID"; sleep 1 ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(join(bin, 'mv'), 0o700);

    const result = spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: backupDir,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_REMOTE: '',
      },
    });

    assert.notEqual(result.status, 0);
    const names = existsSync(backupDir) ? await readdir(backupDir) : [];
    assert.equal(names.some((name) => name.endsWith('.db.gz')), false);
    assert.equal(names.some((name) => name.endsWith('.tar.gz')), false);
    assert.equal(
      names.filter((name) => name.startsWith('.') && name !== '.content-agent-backup-dir').length,
      0,
      `TERM 后残留: ${names.join(',')}`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份拒绝覆盖同时间戳既有成功归档且失败清理不删除旧文件', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-publish-collision-'));
  const backupDir = join(work, 'backups');
  const bin = join(work, 'bin');
  const stamp = '20260814-021500';
  const oldDatabase = join(backupDir, `app-${stamp}.db.gz`);
  const oldFiles = join(backupDir, `files-${stamp}.tar.gz`);
  try {
    await mkdir(join(work, 'data'), { recursive: true });
    await mkdir(backupDir, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    const database = new DatabaseSync(join(work, 'data/app.db'));
    database.exec('CREATE TABLE proof(value TEXT)');
    database.close();
    await writeFile(oldDatabase, 'existing-database-archive', 'utf8');
    await writeFile(oldFiles, 'existing-files-archive', 'utf8');
    const realDate = (await execFile('bash', ['-lc', 'command -v date'], {
      encoding: 'utf8',
    })).stdout.trim();
    await writeFile(
      join(bin, 'date'),
      [
        '#!/bin/sh',
        `if [ "\${1:-}" = "+%Y%m%d-%H%M%S" ]; then printf '%s\\n' ${JSON.stringify(stamp)}; exit 0; fi`,
        `exec ${JSON.stringify(realDate)} "$@"`,
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(join(bin, 'date'), 0o700);

    const result = spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: backupDir,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_REMOTE: '',
      },
    });

    assert.notEqual(result.status, 0);
    assert.equal(await readFile(oldDatabase, 'utf8'), 'existing-database-archive');
    assert.equal(await readFile(oldFiles, 'utf8'), 'existing-files-archive');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('成功备份最后发布 600 manifest 且声明的归档可恢复', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-manifest-success-'));
  const backupDir = join(work, 'backups');
  try {
    await mkdir(join(work, 'data/knowledge'), { recursive: true });
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await writeFile(join(work, 'data/knowledge/readable.md'), 'restorable\n', 'utf8');
    const database = new DatabaseSync(join(work, 'data/app.db'));
    database.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('manifest-ok')");
    database.close();

    await execFile('bash', [backupScript], {
      env: {
        ...process.env,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: backupDir,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_REMOTE: '',
      },
    });

    const names = await readdir(backupDir);
    const manifestName = names.find((name) => /^complete-\d{8}-\d{6}\.json$/u.test(name));
    assert.ok(manifestName);
    const manifestPath = join(backupDir, manifestName);
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      schema: string;
      stamp: string;
      gitCommit: string | null;
      database: { file: string; size: number; sha256: string };
      files: { file: string; size: number; sha256: string };
      createdAt: string;
    };
    assert.equal(manifest.schema, 'content-agent-backup/v2');
    assert.equal(manifest.gitCommit, null);
    assert.equal(manifest.database.file, `app-${manifest.stamp}.db.gz`);
    assert.equal(manifest.files.file, `files-${manifest.stamp}.tar.gz`);
    for (const artifact of [manifest.database, manifest.files]) {
      const bytes = await readFile(join(backupDir, artifact.file));
      assert.equal(bytes.length, artifact.size);
      assert.equal(sha256(bytes), artifact.sha256);
    }
    assert.ok(Number.isFinite(Date.parse(manifest.createdAt)));
    const restored = join(work, 'restored.db');
    await writeFile(restored, gunzipSync(await readFile(join(backupDir, manifest.database.file))));
    const restoredDatabase = new DatabaseSync(restored, { readOnly: true });
    assert.equal(restoredDatabase.prepare('SELECT value FROM proof').get()?.value, 'manifest-ok');
    restoredDatabase.close();
    const restoredKnowledge = await execFile(
      'tar',
      ['-xOf', join(backupDir, manifest.files.file), 'data/knowledge/readable.md'],
      { encoding: 'utf8' },
    );
    assert.equal(restoredKnowledge.stdout, 'restorable\n');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份目录在 git 仓库内时把 HEAD 写入 v2 manifest', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-git-commit-'));
  const backupDir = join(work, 'backups');
  try {
    await mkdir(join(work, 'data/knowledge'), { recursive: true });
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await writeFile(join(work, 'data/knowledge/readable.md'), 'from-git\n', 'utf8');
    const database = new DatabaseSync(join(work, 'data/app.db'));
    database.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('git-ok')");
    database.close();
    await execFile('git', ['init'], { cwd: work });
    await execFile('git', ['add', '.'], { cwd: work });
    await execFile(
      'git',
      [
        '-c', 'user.name=Backup Test',
        '-c', 'user.email=backup@test.local',
        '-c', 'commit.gpgsign=false',
        'commit', '-m', 'fixture',
      ],
      { cwd: work },
    );
    const head = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' })).stdout.trim();

    await execFile('bash', [backupScript], {
      env: {
        ...process.env,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: backupDir,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_REMOTE: '',
      },
    });

    const names = await readdir(backupDir);
    const manifestName = names.find((name) => /^complete-\d{8}-\d{6}\.json$/u.test(name));
    assert.ok(manifestName);
    const manifest = JSON.parse(await readFile(join(backupDir, manifestName), 'utf8')) as {
      schema: string;
      gitCommit: string | null;
    };
    assert.equal(manifest.schema, 'content-agent-backup/v2');
    assert.equal(manifest.gitCommit, head);
    assert.match(head, /^[0-9a-f]{40}$/u);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('inspect 仍接受无 gitCommit 的 v1 manifest', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-v1-inspect-'));
  try {
    const stamp = '20260814-010203';
    const databasePath = join(work, `app-${stamp}.db.gz`);
    const filesPath = join(work, `files-${stamp}.tar.gz`);
    await writeFile(databasePath, gzipSync(Buffer.from('legacy-db')));
    await writeFile(filesPath, gzipSync(Buffer.from('legacy-files')));
    const { writeManifest, inspectBackups } = await import(
      `${pathToFileURL(backupManifestHelper).href}?legacy=${Date.now()}`
    ) as {
      writeManifest: (
        stamp: string,
        databasePath: string,
        filesPath: string,
        outputPath: string,
        gitCommit?: string | null,
      ) => Promise<unknown>;
      inspectBackups: (dir: string) => Promise<{ mode: string; latest: { stamp: string } | null }>;
    };
    const v1Path = join(work, `complete-${stamp}.json`);
    await writeFile(
      v1Path,
      `${JSON.stringify({
        schema: 'content-agent-backup/v1',
        stamp,
        database: {
          file: `app-${stamp}.db.gz`,
          size: (await stat(databasePath)).size,
          sha256: sha256(await readFile(databasePath)),
        },
        files: {
          file: `files-${stamp}.tar.gz`,
          size: (await stat(filesPath)).size,
          sha256: sha256(await readFile(filesPath)),
        },
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const inspected = await inspectBackups(work);
    assert.equal(inspected.mode, 'manifest');
    assert.equal(inspected.latest?.stamp, stamp);
    assert.ok(writeManifest);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('SIGKILL 崩溃点留下的无 manifest 归档不被承认为可恢复备份', async (context) => {
  for (const crashAt of ['after_db_publish', 'after_files_publish', 'before_manifest_publish']) {
    await context.test(crashAt, async () => {
      const work = await mkdtemp(join(tmpdir(), `content-agent-backup-crash-${crashAt}-`));
      const backupDir = join(work, 'backups');
      const { server, url } = await startHealthServer();
      try {
        await mkdir(join(work, 'data'), { recursive: true });
        await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
        const database = new DatabaseSync(join(work, 'data/app.db'));
        database.exec('CREATE TABLE proof(value TEXT)');
        database.close();
        const result = spawnSync('bash', [backupScript], {
          encoding: 'utf8',
          env: {
            ...process.env,
            CONTENT_AGENT_ROOT: work,
            CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
            CONTENT_AGENT_BACKUP_DIR: backupDir,
            CONTENT_AGENT_NODE_BIN: process.execPath,
            CONTENT_AGENT_BACKUP_HELPER: backupHelper,
            CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
            CONTENT_AGENT_BACKUP_TEST_CRASH_AT: crashAt,
            OPS_ENV_FILE: join(work, 'missing-ops.env'),
            BACKUP_REMOTE: '',
          },
        });
        assert.equal(result.signal, 'SIGKILL');
        assert.equal(
          (await readdir(backupDir)).some((name) => name.startsWith('complete-')),
          false,
        );
        await installWatchCommandFakes(work);
        await runHealthWatch(work, url, {
          CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        });
        assert.match(await readAlertLog(work), /\[backup_uncommitted\]/u);
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await rm(work, { recursive: true, force: true });
      }
    });
  }
});

test('备份 helper 的数据库路径模式与 API 一样按仓库根解析相对路径并保留绝对路径', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-resolve-'));
  try {
    await writeFile(
      join(work, '.env'),
      'CONTENT_AGENT_DATA_DIR=./runtime-data\nCONTENT_AGENT_DB_PATH=./database/live.sqlite\n',
      'utf8',
    );
    const relative = await execFile(
      process.execPath,
      [backupHelper, '--print-database-path', work],
      { encoding: 'utf8' },
    );
    assert.equal(relative.stdout.trim(), join(work, 'database/live.sqlite'));

    const absolutePath = join(tmpdir(), 'content-agent-external.sqlite');
    await writeFile(
      join(work, '.env'),
      `CONTENT_AGENT_DATA_DIR=./runtime-data\nCONTENT_AGENT_DB_PATH=${absolutePath}\n`,
      'utf8',
    );
    const absolute = await execFile(
      process.execPath,
      [backupHelper, '--print-database-path', work],
      { encoding: 'utf8' },
    );
    assert.equal(absolute.stdout.trim(), absolutePath);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('storage-paths 可安全导入并用 Node parseEnv 统一解析 dataDir 与独立 DB_PATH', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-storage-paths-'));
  try {
    await writeFile(
      join(work, '.env'),
      'CONTENT_AGENT_DATA_DIR="./runtime data"\nCONTENT_AGENT_DB_PATH=./database/live.sqlite\n',
      'utf8',
    );
    const storagePaths = await import(`${pathToFileURL(storagePathsModule).href}?test=${Date.now()}`) as {
      resolveRepositoryStoragePaths: (repositoryRoot: string) => Promise<{
        repositoryRoot: string;
        envFile: string;
        dataDir: string;
        databasePath: string;
      }>;
    };
    const resolved = await storagePaths.resolveRepositoryStoragePaths(work);
    assert.deepEqual(resolved, {
      repositoryRoot: work,
      envFile: join(work, '.env'),
      dataDir: join(work, 'runtime data'),
      databasePath: join(work, 'database/live.sqlite'),
    });

    const absoluteDataDir = join(tmpdir(), 'content-agent-absolute-data');
    const absoluteDatabasePath = join(tmpdir(), 'content-agent-absolute.sqlite');
    await writeFile(
      join(work, '.env'),
      `CONTENT_AGENT_DATA_DIR=${absoluteDataDir}\nCONTENT_AGENT_DB_PATH=${absoluteDatabasePath}\n`,
      'utf8',
    );
    const absolute = await storagePaths.resolveRepositoryStoragePaths(work);
    assert.equal(absolute.dataDir, absoluteDataDir);
    assert.equal(absolute.databasePath, absoluteDatabasePath);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('storage-paths 与 API resolveOptions 对拍相对、绝对、空值和引号路径', async () => {
  const storagePaths = await import(`${pathToFileURL(storagePathsModule).href}?compare=${Date.now()}`) as {
    resolveStoragePaths: (
      repositoryRoot: string,
      repositoryEnv: Record<string, string>,
    ) => { dataDir: string; databasePath: string };
  };
  const absoluteDataDir = join(tmpdir(), 'content-agent-compare-data');
  const absoluteDatabasePath = join(tmpdir(), 'content-agent-compare.sqlite');
  const cases = [
    'CONTENT_AGENT_DATA_DIR=./runtime-data\nCONTENT_AGENT_DB_PATH=./database/live.sqlite\n',
    `CONTENT_AGENT_DATA_DIR=${absoluteDataDir}\nCONTENT_AGENT_DB_PATH=${absoluteDatabasePath}\n`,
    'CONTENT_AGENT_DATA_DIR=\nCONTENT_AGENT_DB_PATH=\n',
    'CONTENT_AGENT_DATA_DIR="./runtime data"\nCONTENT_AGENT_DB_PATH="./database/live db.sqlite"\n',
  ];
  const originalDataDir = process.env.CONTENT_AGENT_DATA_DIR;
  const originalDatabasePath = process.env.CONTENT_AGENT_DB_PATH;
  try {
    for (const source of cases) {
      const parsed = parseEnv(source);
      process.env.CONTENT_AGENT_DATA_DIR = parsed.CONTENT_AGENT_DATA_DIR;
      process.env.CONTENT_AGENT_DB_PATH = parsed.CONTENT_AGENT_DB_PATH;
      const scriptPaths = storagePaths.resolveStoragePaths(root, parsed);
      const apiPaths = resolveOptions({ logger: false });
      assert.equal(scriptPaths.dataDir, apiPaths.dataDir, source);
      assert.equal(scriptPaths.databasePath, apiPaths.databasePath, source);
    }
  } finally {
    if (originalDataDir === undefined) delete process.env.CONTENT_AGENT_DATA_DIR;
    else process.env.CONTENT_AGENT_DATA_DIR = originalDataDir;
    if (originalDatabasePath === undefined) delete process.env.CONTENT_AGENT_DB_PATH;
    else process.env.CONTENT_AGENT_DB_PATH = originalDatabasePath;
  }
});

test('看门狗失败率查询使用仓库 .env 指向的独立数据库', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-db-path-'));
  const databasePath = join(work, 'database/live.sqlite');
  const { server, url } = await startHealthServer();
  try {
    await mkdir(join(work, 'data'), { recursive: true });
    await mkdir(join(work, 'database'), { recursive: true });
    await writeFile(
      join(work, '.env'),
      `CONTENT_AGENT_DATA_DIR=./runtime-data\nCONTENT_AGENT_DB_PATH=${databasePath}\n`,
      'utf8',
    );
    const oldDatabase = new DatabaseSync(join(work, 'data/app.db'));
    oldDatabase.exec(`
      CREATE TABLE generation_jobs(status TEXT, completed_at TEXT);
      INSERT INTO generation_jobs VALUES ('completed', datetime('now'));
    `);
    oldDatabase.close();
    const liveDatabase = new DatabaseSync(databasePath);
    liveDatabase.exec(`
      CREATE TABLE generation_jobs(status TEXT, completed_at TEXT);
      INSERT INTO generation_jobs VALUES
        ('failed', datetime('now')),
        ('failed', datetime('now')),
        ('failed', datetime('now'));
    `);
    liveDatabase.close();

    await runHealthWatch(work, url);
    const alerts = await readFile(join(work, 'logs/alerts.log'), 'utf8');
    assert.match(alerts, /\[failure_rate\].*3\/3/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗保留真实 HTTP 503 响应体并对本机与公网报告数据库不可写', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-health-503-'));
  const { server, url } = await startHealthServer(
    { status: 'unavailable', databaseWritable: false },
    503,
  );
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await runHealthWatch(work, url, { PUBLIC_HEALTH_URL: url });
    const alerts = await readFile(join(work, 'logs/alerts.log'), 'utf8');
    assert.match(alerts, /\[service_db_unwritable\]/u);
    assert.match(alerts, /\[public_db_unwritable\]/u);
    assert.doesNotMatch(alerts, /\[(?:service|public)_down\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗把传输成功但返回 HTML 的 HTTP 503 报告为协议降级而非 down', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-health-503-html-'));
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'text/html' });
    response.end('<html><body>maintenance</body></html>');
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/health`;
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await runHealthWatch(work, url, { PUBLIC_HEALTH_URL: url });
    const alerts = await readFile(join(work, 'logs/alerts.log'), 'utf8');
    assert.match(alerts, /\[service_degraded\].*协议/u);
    assert.match(alerts, /\[public_degraded\].*协议/u);
    assert.doesNotMatch(alerts, /\[(?:service|public)_down\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗自身无法保存健康响应时报告降级而非网络 down', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-health-local-error-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    await writeFile(join(work, 'bin/mktemp'), '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(join(work, 'bin/mktemp'), 0o700);
    await runHealthWatch(work, url);
    const alerts = await readAlertLog(work);
    assert.match(alerts, /\[service_degraded\].*探活/u);
    assert.doesNotMatch(alerts, /\[service_down\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗报告备份 launchd 最近一次非零退出', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-exit-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work, 'active count = 0\nlast exit code = 9\n');
    await runHealthWatch(work, url);
    assert.match(await readAlertLog(work), /\[backup_failed\].*exit=9/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗报告默认阈值下已有 49 小时的备份', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-stale-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    const pair = await createBackupPair(work, '20260812-010203');
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
    await utimes(pair.database, old, old);
    await utimes(pair.files, old, old);
    await runHealthWatch(work, url);
    assert.match(await readAlertLog(work), /\[backup_stale\].*48/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗把只有数据库归档的最新备份报告为不成对', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-unpaired-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    await mkdir(join(work, 'backups'), { recursive: true });
    await writeFile(
      join(work, 'backups/app-20260814-010203.db.gz'),
      gzipSync(Buffer.from('sqlite-snapshot')),
    );
    await runHealthWatch(work, url);
    const alerts = await readAlertLog(work);
    assert.match(alerts, /\[backup_unpaired\]/u);
    assert.doesNotMatch(alerts, /\[backup_missing\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗报告损坏的最新备份对', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-corrupt-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    await createBackupPair(work, '20260814-020304', { corruptDatabase: true });
    await runHealthWatch(work, url);
    assert.match(await readAlertLog(work), /\[backup_corrupt\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗在没有任何自动备份时报告缺失', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-missing-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    await runHealthWatch(work, url);
    assert.match(await readAlertLog(work), /\[backup_missing\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗使用可配置的正整数备份小时阈值', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-age-config-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    const pair = await createBackupPair(work, '20260812-030405');
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
    await utimes(pair.database, old, old);
    await utimes(pair.files, old, old);
    await runHealthWatch(work, url, { BACKUP_MAX_AGE_HOURS: '72' });
    assert.doesNotMatch(await readAlertLog(work), /\[backup_stale\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗拒绝非正整数的备份小时阈值', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-age-invalid-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    await assert.rejects(
      runHealthWatch(work, url, { BACKUP_MAX_AGE_HOURS: '0' }),
      (error: unknown) => {
        const failure = error as { stderr?: string };
        assert.match(failure.stderr ?? '', /BACKUP_MAX_AGE_HOURS.*正整数/u);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('备份任务正在运行时看门狗不误报归档缺失', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-running-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work, 'active count = 1\nlast exit code = 0\n');
    await runHealthWatch(work, url);
    const alerts = await readAlertLog(work);
    assert.doesNotMatch(alerts, /\[backup_(?:missing|unpaired)\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('手工备份持有有效进程锁时看门狗不误报归档缺失', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-lock-running-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    const lock = join(work, 'support/backup.lock');
    await mkdir(lock, { recursive: true });
    const started = (await execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(process.pid)],
      { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } },
    )).stdout.trim().replace(/\s+/gu, ' ');
    await writeFile(join(lock, 'owner'), `${process.pid}\n${started}\nwatch-token\n`, 'utf8');
    await runHealthWatch(work, url);
    assert.doesNotMatch(
      await readAlertLog(work),
      /\[backup_(?:missing|unpaired)\]/u,
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗以 600 缓存文件标识并跳过重复完整性解压', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-cache-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    await createBackupPair(work, '20260814-040506');
    const countFile = join(work, 'archive-command-count.log');
    const gzipPath = (await execFile('bash', ['-lc', 'command -v gzip'], {
      encoding: 'utf8',
    })).stdout.trim();
    const tarPath = (await execFile('bash', ['-lc', 'command -v tar'], {
      encoding: 'utf8',
    })).stdout.trim();
    await writeFile(
      join(work, 'bin/gzip'),
      `#!/bin/sh\nprintf 'gzip\\n' >> ${JSON.stringify(countFile)}\nexec ${JSON.stringify(gzipPath)} "$@"\n`,
      'utf8',
    );
    await writeFile(
      join(work, 'bin/tar'),
      `#!/bin/sh\nprintf 'tar\\n' >> ${JSON.stringify(countFile)}\nexec ${JSON.stringify(tarPath)} "$@"\n`,
      'utf8',
    );
    await chmod(join(work, 'bin/gzip'), 0o700);
    await chmod(join(work, 'bin/tar'), 0o700);

    await runHealthWatch(work, url);
    const firstCount = (await readFile(countFile, 'utf8')).trim().split('\n').length;
    await runHealthWatch(work, url);
    const secondCount = (await readFile(countFile, 'utf8')).trim().split('\n').length;

    assert.equal(firstCount, 3);
    assert.equal(secondCount, firstCount);
    const cache = await stat(join(work, 'support/.backup-verification-cache'));
    assert.equal(cache.mode & 0o777, 0o600);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗用内容哈希识别同秒等长改写并重新深检损坏归档', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-backup-cache-rewrite-'));
  const { server, url } = await startHealthServer();
  try {
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    await installWatchCommandFakes(work);
    const pair = await createBackupPair(work, '20260814-050607');
    const countFile = join(work, 'archive-rewrite-command-count.log');
    const gzipPath = (await execFile('bash', ['-lc', 'command -v gzip'], {
      encoding: 'utf8',
    })).stdout.trim();
    const tarPath = (await execFile('bash', ['-lc', 'command -v tar'], {
      encoding: 'utf8',
    })).stdout.trim();
    await writeFile(
      join(work, 'bin/gzip'),
      `#!/bin/sh\nprintf 'gzip\\n' >> ${JSON.stringify(countFile)}\nexec ${JSON.stringify(gzipPath)} "$@"\n`,
      'utf8',
    );
    await writeFile(
      join(work, 'bin/tar'),
      `#!/bin/sh\nprintf 'tar\\n' >> ${JSON.stringify(countFile)}\nexec ${JSON.stringify(tarPath)} "$@"\n`,
      'utf8',
    );
    await chmod(join(work, 'bin/gzip'), 0o700);
    await chmod(join(work, 'bin/tar'), 0o700);

    await runHealthWatch(work, url);
    const firstCount = (await readFile(countFile, 'utf8')).trim().split('\n').length;
    const preservedTimes = await stat(pair.database);
    await waitForEarlySecond();
    await utimes(pair.database, preservedTimes.atime, preservedTimes.mtime);
    const before = await stat(pair.database);
    const bytes = await readFile(pair.database);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await writeFile(pair.database, bytes);
    await utimes(pair.database, before.atime, before.mtime);
    const after = await stat(pair.database);
    const legacyKey = (value: typeof before) => [
      value.ino,
      Math.floor(value.mtimeMs / 1000),
      value.size,
      Math.floor(value.ctimeMs / 1000),
    ].join(':');
    assert.equal(legacyKey(after), legacyKey(before), '测试夹具必须复现旧元数据键碰撞');

    await runHealthWatch(work, url);
    const secondCount = (await readFile(countFile, 'utf8')).trim().split('\n').length;
    assert.ok(secondCount > firstCount, '内容变化后必须重新运行 gzip/tar 深检');
    assert.match(await readAlertLog(work), /\[backup_corrupt\]/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('看门狗支持仓库外运维环境、公网探活和安全 webhook 载荷', async () => {
  const source = await readFile(healthScript, 'utf8');
  assert.match(source, /OPS_ENV_FILE/u);
  assert.match(source, /PUBLIC_HEALTH_URL/u);
  assert.match(source, /databaseWritable/u);
  assert.match(source, /json\.dumps/u);
  assert.match(source, /ALERT_WEBHOOK=已配置/u);
  assert.doesNotMatch(source, /ALERT_WEBHOOK=\$\{ALERT_WEBHOOK/u);
  assert.match(source, /tunnel\.err\.log/u);
  assert.match(source, /health-watch\.err\.log/u);
  assert.match(source, /backup\.log/u);
  assert.match(source, /CONTENT_AGENT_OPS_LOG_DIR/u);
  assert.match(source, /CONTENT_AGENT_NODE_BIN/u);
  assert.doesNotMatch(source, /LOG="\$ROOT\/data\/logs/u);
});

test('webhook 测试正确转义文本、钉钉保留告警关键词且不回显秘密 URL', async () => {
  let body = '';
  const server = createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => { response.writeHead(204); response.end(); });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const webhook = `http://127.0.0.1:${address.port}/secret-webhook`;
  const work = await mkdtemp(join(tmpdir(), 'content-agent-watch-contract-'));
  const opsEnv = join(work, 'ops.env');
  const message = '引号\"、反斜杠\\\\与换行\n都必须安全';
  try {
    await writeFile(opsEnv, `ALERT_WEBHOOK=${webhook}\nALERT_WEBHOOK_KIND=dingtalk\n`, 'utf8');
    await chmod(opsEnv, 0o600);
    const result = await execFile('bash', [healthScript, '--test'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTENT_AGENT_ROOT: work,
        OPS_ENV_FILE: opsEnv,
        ALERT_TEST_MESSAGE: message,
      },
    });
    assert.match(result.stdout, /ALERT_WEBHOOK=已配置/u);
    assert.doesNotMatch(result.stdout, /secret-webhook/u);
    assert.deepEqual(JSON.parse(body), {
      msgtype: 'text',
      text: { content: `告警 ${message}` },
    });
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(work, { recursive: true, force: true });
  }
});

test('备份拒绝 HOME、SUPPORT_DIR、仓库根和文件系统根作为 DEST', async (context) => {
  const source = await readFile(backupScript, 'utf8');
  assert.match(source, /\[ "\$DEST" = "\/" \]/u, '必须显式拒绝文件系统根，不能用破坏性红灯探测');
  for (const destinationKind of ['home', 'support', 'repository'] as const) {
    await context.test(destinationKind, async () => {
      const work = await mkdtemp(join(tmpdir(), `content-agent-backup-wide-${destinationKind}-`));
      const repository = join(work, 'repo');
      const home = join(work, 'home');
      const support = join(home, 'support');
      const destination = destinationKind === 'home'
        ? home
        : destinationKind === 'support'
          ? support
          : repository;
      try {
        await mkdir(home, { recursive: true });
        await createMinimalBackupRepository(repository);
        const result = spawnSync('bash', [backupScript], {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home,
            CONTENT_AGENT_ROOT: repository,
            CONTENT_AGENT_SUPPORT_DIR: support,
            CONTENT_AGENT_BACKUP_DIR: destination,
            CONTENT_AGENT_NODE_BIN: process.execPath,
            CONTENT_AGENT_BACKUP_HELPER: backupHelper,
            CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
            OPS_ENV_FILE: join(work, 'missing-ops.env'),
            BACKUP_REMOTE: '',
          },
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /备份目录.*(?:危险|过宽|拒绝)/u);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });
  }
});

test('备份拒绝符号链接 DEST', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-dest-symlink-'));
  const repository = join(work, 'repo');
  const target = join(work, 'target');
  const destination = join(work, 'backup-link');
  try {
    await createMinimalBackupRepository(repository);
    await mkdir(target);
    await symlink(target, destination);
    const result = spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(work, 'home'),
        CONTENT_AGENT_ROOT: repository,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: destination,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /符号链接/u);
    assert.deepEqual(await readdir(target), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份目录首次迁移遇到无关顶层文件时失败关闭', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-dest-unrelated-'));
  const repository = join(work, 'repo');
  const destination = join(work, 'backups');
  try {
    await createMinimalBackupRepository(repository);
    await mkdir(destination);
    await writeFile(join(destination, 'unrelated.txt'), 'must-survive', 'utf8');
    const result = spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(work, 'home'),
        CONTENT_AGENT_ROOT: repository,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: destination,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(destination, 'unrelated.txt'), 'utf8'), 'must-survive');
    assert.equal(existsSync(join(destination, '.content-agent-backup-dir')), false);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份保留策略只删除 DEST 顶层普通文件，不递归删除子目录同名文件', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-retention-depth-'));
  const repository = join(work, 'repo');
  const destination = join(work, 'backups');
  const nested = join(destination, 'nested/app-20000101-000000.db.gz');
  try {
    await createMinimalBackupRepository(repository);
    await mkdir(join(destination, 'nested'), { recursive: true });
    await writeFile(join(destination, '.content-agent-backup-dir'), 'content-agent-backup-dir/v1\n', {
      mode: 0o600,
    });
    await writeFile(nested, 'do-not-delete', 'utf8');
    const old = new Date('2000-01-01T00:00:00.000Z');
    await utimes(nested, old, old);
    await execFile('bash', [backupScript], {
      env: {
        ...process.env,
        HOME: join(work, 'home'),
        CONTENT_AGENT_ROOT: repository,
        CONTENT_AGENT_SUPPORT_DIR: join(work, 'support'),
        CONTENT_AGENT_BACKUP_DIR: destination,
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_KEEP_DAYS: '1',
        BACKUP_REMOTE: '',
      },
    });
    assert.equal(await readFile(nested, 'utf8'), 'do-not-delete');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份脚本声明安全默认且不再对异地目录使用 delete', async () => {
  const source = await readFile(backupScript, 'utf8');
  assert.ok(existsSync(backupHelper), '缺少由 Node 读取桌面数据的备份 helper');
  const helper = await readFile(backupHelper, 'utf8');
  assert.match(source, /umask 077/u);
  assert.match(source, /OPS_ENV_FILE/u);
  assert.match(source, /CONTENT_AGENT_BACKUP_DIR/u);
  assert.match(source, /CONTENT_AGENT_NODE_BIN/u);
  assert.doesNotMatch(source, /sqlite3 "\$DB"/u);
  assert.match(source, /mkdir "\$LOCK_DIR"/u, '并发备份必须用原子目录锁串行化');
  assert.match(source, /LOCK_AGE/u, '没有 pid 的新锁必须经过宽限期才能按陈旧锁回收');
  assert.match(source, /BACKUP_LOCK_STALE_SECONDS/u);
  assert.match(source, /lstart/u, '锁所有者必须记录进程启动标识，避免 PID 复用误判');
  assert.match(source, /LOCK_STARTED/u);
  assert.match(source, /DB_TMP/u);
  assert.match(source, /FILES_TMP/u);
  assert.match(source, /mv "\$DB_TMP" "\$DB_OUT"/u);
  assert.match(source, /gzip -t "\$DB_TMP"/u);
  assert.match(source, /tar -tzf "\$FILES_TMP"/u);
  assert.match(helper, /node:sqlite/u);
  assert.match(helper, /for \(const directory of \['knowledge', 'images'\]\)/u);
  assert.match(source, /chmod 600 "\$DB_OUT" "\$FILES_OUT"/u);
  assert.doesNotMatch(source, /rsync[^\\n]*--delete/u);
});

test('刚创建但尚未写入 pid 的备份锁不会被并发进程抢占', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-lock-'));
  const support = join(work, 'support');
  try {
    await mkdir(join(support, 'backup.lock'), { recursive: true });
    const result = spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: support,
        CONTENT_AGENT_BACKUP_DIR: join(work, 'backups'),
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
      },
    });
    assert.equal(result.status, 75, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /宽限期/u);
    assert.ok(existsSync(join(support, 'backup.lock')));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('备份锁的 ps lstart 跨 TZ 使用固定 UTC 身份', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-lock-timezone-'));
  const support = join(work, 'support');
  const lock = join(support, 'backup.lock');
  try {
    await mkdir(lock, { recursive: true });
    const started = (await execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(process.pid)],
      { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } },
    )).stdout.trim();
    await writeFile(join(lock, 'owner'), `${process.pid}\n${started}\nexisting-token\n`, 'utf8');
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);
    const result = spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TZ: 'Pacific/Honolulu',
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: support,
        CONTENT_AGENT_BACKUP_DIR: join(work, 'backups'),
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        BACKUP_LOCK_STALE_SECONDS: '1',
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
      },
    });
    assert.equal(result.status, 75, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /已有备份任务在运行/u);
    assert.equal(await readFile(join(lock, 'owner'), 'utf8'), `${process.pid}\n${started}\nexisting-token\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('活 PID 启动身份不可读时备份锁 fail closed 不回收', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-lock-unknown-'));
  const support = join(work, 'support');
  const lock = join(support, 'backup.lock');
  try {
    await mkdir(join(work, 'bin'), { recursive: true });
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), `${process.pid}\nunknown-start\nexisting-token\n`, 'utf8');
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);
    await writeFile(join(work, 'bin/ps'), '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(join(work, 'bin/ps'), 0o700);
    const result = spawnSync('bash', [backupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(work, 'bin')}:${process.env.PATH}`,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: support,
        CONTENT_AGENT_BACKUP_DIR: join(work, 'backups'),
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        BACKUP_LOCK_STALE_SECONDS: '1',
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
      },
    });
    assert.equal(result.status, 75, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /(?:无法确认.*启动标识|启动标识.*无法确认|已有备份任务)/u);
    assert.ok(existsSync(lock));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('旧备份进程 cleanup 不删除已被新 token 替换的锁', async () => {
  const work = await mkdtemp(join(tmpdir(), 'content-agent-backup-lock-token-'));
  const support = join(work, 'support');
  const lock = join(support, 'backup.lock');
  const observedOwner = join(work, 'observed-owner');
  try {
    await mkdir(join(work, 'data'), { recursive: true });
    await mkdir(join(work, 'bin'), { recursive: true });
    await writeFile(join(work, '.env'), 'CONTENT_AGENT_DATA_DIR=./data\n', 'utf8');
    const database = new DatabaseSync(join(work, 'data/app.db'));
    database.exec('CREATE TABLE proof(value TEXT)');
    database.close();
    await writeFile(
      join(work, 'bin/rsync'),
      `#!/bin/sh\ncp ${JSON.stringify(join(lock, 'owner'))} ${JSON.stringify(observedOwner)}\nprintf '999\\nnew-start\\nnew-token\\n' > ${JSON.stringify(join(lock, 'owner'))}\n`,
      'utf8',
    );
    await chmod(join(work, 'bin/rsync'), 0o700);
    await execFile('bash', [backupScript], {
      env: {
        ...process.env,
        PATH: `${join(work, 'bin')}:${process.env.PATH}`,
        CONTENT_AGENT_ROOT: work,
        CONTENT_AGENT_SUPPORT_DIR: support,
        CONTENT_AGENT_BACKUP_DIR: join(work, 'backups'),
        CONTENT_AGENT_NODE_BIN: process.execPath,
        CONTENT_AGENT_BACKUP_HELPER: backupHelper,
        CONTENT_AGENT_BACKUP_MANIFEST_HELPER: backupManifestHelper,
        OPS_ENV_FILE: join(work, 'missing-ops.env'),
        BACKUP_REMOTE: 'fake-remote:',
      },
    });
    const originalOwner = (await readFile(observedOwner, 'utf8')).trim().split('\n');
    assert.equal(originalOwner.length, 3);
    assert.ok(originalOwner[2]);
    assert.equal(await readFile(join(lock, 'owner'), 'utf8'), '999\nnew-start\nnew-token\n');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

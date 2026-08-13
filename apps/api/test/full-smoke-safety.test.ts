import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, type TestContext } from 'node:test';
import * as processIdentity from '../../../scripts/process-start-identity.mjs';

const root = resolve(import.meta.dirname, '../../..');
const smokeScript = resolve(root, 'scripts/full-generation-smoke.mts');
const apiTsconfig = resolve(root, 'apps/api/tsconfig.json');
const smokeRoot = resolve(root, '.tmp-test');
const ownedPaths = new Set<string>();
const activeSmokeProcesses = new Set<SpawnedSmoke>();
const smokeEnvironmentKeys = [
  'SMOKE_DISABLE_MODEL',
  'SMOKE_KEEP_CLONE_DATA',
  'SMOKE_PERSIST_DEVELOPMENT_DATA',
  'SMOKE_PROJECT_ID',
  'SMOKE_STALE_CLONE_GRACE_MS',
  'SMOKE_TEST_SOURCE_DATA_DIR',
  'SMOKE_TEST_SOURCE_DATABASE_PATH',
  'SMOKE_TEST_BARRIER_DIR',
  'SMOKE_TEST_PAUSE_AT',
  'SMOKE_TEST_RUN_TOKEN',
] as const;

interface BarrierReady {
  phase: string;
  runDir: string;
  cloneDataDir: string;
  runToken: string;
}

interface SmokeProcess {
  exited: boolean;
  runToken: string;
  child: ChildProcessWithoutNullStreams;
  exit: Promise<[number | null, NodeJS.Signals | null]>;
  barrierDir: string;
  phase: string;
  ready: BarrierReady;
  output: () => string;
}

type SpawnedSmoke = Pick<SmokeProcess, 'child' | 'exit' | 'exited' | 'runToken' | 'output'>;
type IdentityBackend = 'linux-proc-boot-id' | 'linux-proc-btime' | 'ps-lstart';
type StructuredIdentity =
  | { kind: 'known'; backend: IdentityBackend; value: string }
  | { kind: 'unknown'; backend: IdentityBackend };

after(async () => {
  for (const processState of activeSmokeProcesses) await stopSmoke(processState);
  await cleanupOwnedPaths();
});

async function cleanupOwnedPaths(): Promise<void> {
  const paths = [...ownedPaths].sort((left, right) => right.length - left.length);
  ownedPaths.clear();
  for (const path of paths) {
    await chmod(path, 0o700).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }
}

test('开发链 nanoid 已提升到修复零长度死循环的 3.3.17+', () => {
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const version = lock.packages['node_modules/nanoid']?.version;
  assert.ok(version, '缺少 nanoid 锁文件条目');
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(
    major > 3 || (major === 3 && (minor > 3 || (minor === 3 && patch >= 17))),
    `nanoid ${version} 仍受 GHSA-2v37-7h3g-55p8 影响`,
  );
});

async function identityWithCallerEnvironment(pid: number, tz: string, locale: string): Promise<StructuredIdentity> {
  const previousTz = process.env.TZ;
  const previousLocale = process.env.LC_ALL;
  try {
    process.env.TZ = tz;
    process.env.LC_ALL = locale;
    return await processIdentity.processStartIdentity(pid) as unknown as StructuredIdentity;
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
    if (previousLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previousLocale;
  }
}

test('同一 PID 的启动标识不受调用者 TZ 与 locale 影响', async () => {
  const first = await identityWithCallerEnvironment(process.pid, 'Pacific/Honolulu', 'C');
  const second = await identityWithCallerEnvironment(process.pid, 'Asia/Tokyo', 'POSIX');
  assert.equal(first.kind, 'known', '应能读取当前测试进程的结构化启动标识');
  assert.deepEqual(second, first, '同一活 PID 的结构化标识必须跨 TZ/locale 稳定');
});

test('Linux marker 后端不可用时保持 unknown，不得切到 ps 判定 PID 复用', async () => {
  let startTimeTicks = '12345';
  let bootIdentityAvailable = true;
  const fieldsAfterCommand = ['S', ...Array.from({ length: 18 }, () => '0'), startTimeTicks];
  const identityModule = processIdentity as unknown as {
    createProcessStartIdentityReader: (dependencies: {
      readFile: (path: string) => Promise<string>;
      psStart: (pid: number) => Promise<string | undefined>;
    }) => (pid: number, backend?: IdentityBackend) => Promise<StructuredIdentity>;
    classifyProcessOwner: (
      pid: number,
      expected: StructuredIdentity,
      options: {
        readIdentity: (pid: number, backend?: IdentityBackend) => Promise<StructuredIdentity>;
        processExists: (pid: number) => boolean;
      },
    ) => Promise<string>;
  };
  const readIdentity = identityModule.createProcessStartIdentityReader({
    readFile: async (path) => {
      if (path === '/proc/42/stat') {
        fieldsAfterCommand[19] = startTimeTicks;
        return `42 (fake process) ${fieldsAfterCommand.join(' ')}\n`;
      }
      if (path === '/proc/sys/kernel/random/boot_id' && bootIdentityAvailable) return 'boot-a\n';
      if (path === '/proc/stat' && bootIdentityAvailable) return 'btime 100\n';
      throw Object.assign(new Error(`unavailable: ${path}`), { code: 'EACCES' });
    },
    psStart: async (pid) => `ps-start-${pid}`,
  });

  const markerIdentity = await readIdentity(42);
  assert.deepEqual(markerIdentity, { kind: 'known', backend: 'linux-proc-boot-id', value: 'boot-a:12345' });

  bootIdentityAvailable = false;
  assert.deepEqual(
    await readIdentity(42, markerIdentity.backend),
    { kind: 'unknown', backend: 'linux-proc-boot-id' },
    '固定 Linux backend 不可用时不能静默切到 ps',
  );
  assert.deepEqual(
    await readIdentity(42),
    { kind: 'known', backend: 'ps-lstart', value: 'ps-start-42' },
    '只有为新 marker 自动选后端时才可退到 ps',
  );
  assert.equal(
    await identityModule.classifyProcessOwner(42, markerIdentity, {
      readIdentity,
      processExists: () => true,
    }),
    'unknown',
    'backend unknown 必须让陈旧清理 fail-safe 保留',
  );

  bootIdentityAvailable = true;
  startTimeTicks = '67890';
  assert.equal(
    await identityModule.classifyProcessOwner(42, markerIdentity, {
      readIdentity,
      processExists: () => true,
    }),
    'reused',
    '同 backend 明确值不同且 PID 活着时才判定 PID 复用',
  );
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function createSourceData(): Promise<string> {
  const sourceDataDir = await mkdtemp(join(tmpdir(), 'full-smoke-source-'));
  ownedPaths.add(sourceDataDir);
  await mkdir(join(sourceDataDir, 'knowledge'), { recursive: true });
  await mkdir(join(sourceDataDir, 'images'), { recursive: true });
  await writeFile(join(sourceDataDir, 'knowledge', 'fixture.md'), '# 可丢弃知识\n', 'utf8');
  await writeFile(join(sourceDataDir, 'images', 'fixture.txt'), 'not-a-real-image\n', 'utf8');
  const database = new DatabaseSync(join(sourceDataDir, 'app.db'));
  try {
    database.exec('CREATE TABLE smoke_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    database.prepare('INSERT INTO smoke_fixture(value) VALUES (?)').run('source-stays-disposable');
  } finally {
    database.close();
  }
  return sourceDataDir;
}

function cleanSmokeEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of smokeEnvironmentKeys) delete env[key];
  return {
    ...env,
    NODE_ENV: 'test',
    SMOKE_DISABLE_MODEL: 'true',
    SMOKE_KEEP_CLONE_DATA: 'false',
    SMOKE_PERSIST_DEVELOPMENT_DATA: 'false',
    SMOKE_PROJECT_ID: '__full_smoke_lifecycle_test__',
    TSX_TSCONFIG_PATH: apiTsconfig,
    ...overrides,
  };
}

function spawnSmoke(context: TestContext, env: NodeJS.ProcessEnv): SpawnedSmoke {
  const runToken = randomUUID();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', smokeScript],
    {
      cwd: root,
      env: { ...env, SMOKE_TEST_RUN_TOKEN: runToken },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  let processState!: SpawnedSmoke;
  const exit = (once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>)
    .then((result) => {
      processState.exited = true;
      activeSmokeProcesses.delete(processState);
      return result;
    });
  processState = {
    exited: false,
    runToken,
    child,
    exit,
    output: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
  activeSmokeProcesses.add(processState);
  context.after(async () => stopSmoke(processState));
  return processState;
}

async function stopSmoke(processState: SpawnedSmoke): Promise<void> {
  if (!processState.exited && processState.child.exitCode === null && processState.child.signalCode === null) {
    processState.child.kill('SIGKILL');
  }
  await processState.exit.catch(() => undefined);
}

async function readOwnerMarker(runDirectory: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(runDirectory, 'smoke-owner.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function claimChildRunDirectories(processState: SpawnedSmoke): Promise<string[]> {
  const claimed: string[] = [];
  for (const name of await readdir(smokeRoot)) {
    if (!name.startsWith('full-generation-smoke-')) continue;
    const directory = join(smokeRoot, name);
    const owner = await readOwnerMarker(directory);
    if (!owner || owner.pid !== processState.child.pid || owner.runToken !== processState.runToken) continue;
    const identity = owner.processStartIdentity as Record<string, unknown> | undefined;
    assert.equal(identity?.kind, 'known', `子进程 ${processState.child.pid} 的 owner marker 缺少结构化启动标识`);
    assert.equal(typeof identity.backend, 'string');
    assert.equal(typeof identity.value, 'string');
    ownedPaths.add(directory);
    claimed.push(directory);
  }
  return claimed;
}

async function waitForFile(path: string, timeoutMs: number, child?: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`子进程在写入屏障前退出: ${path}`);
    }
    await delay(20);
  }
  throw new Error(`等待文件超时: ${path}`);
}

async function startPausedSmoke(
  context: TestContext,
  sourceDataDir: string,
  phase: string,
  overrides: NodeJS.ProcessEnv = {},
  onSpawn?: (processState: SpawnedSmoke) => Promise<void> | void,
): Promise<SmokeProcess> {
  await mkdir(smokeRoot, { recursive: true });
  const barrierDir = await mkdtemp(join(tmpdir(), 'full-smoke-barrier-'));
  ownedPaths.add(barrierDir);
  const processState = spawnSmoke(context, cleanSmokeEnv({
    SMOKE_TEST_SOURCE_DATA_DIR: sourceDataDir,
    SMOKE_TEST_BARRIER_DIR: barrierDir,
    SMOKE_TEST_PAUSE_AT: phase,
    ...overrides,
  }));
  const readyPath = join(barrierDir, `${phase}.ready.json`);
  try {
    await onSpawn?.(processState);
    await waitForFile(readyPath, 15_000, processState.child);
    const ready = JSON.parse(await readFile(readyPath, 'utf8')) as BarrierReady;
    const owner = await readOwnerMarker(ready.runDir);
    assert.equal(owner?.pid, processState.child.pid, '只能认领 owner.pid 与 spawn 子进程一致的 runDir');
    assert.equal(owner?.runToken, processState.runToken, '只能认领 runToken 与父进程注入值一致的 runDir');
    assert.equal(ready.runToken, processState.runToken, '屏障必须回传当前 runToken');
    ownedPaths.add(ready.runDir);
    return Object.assign(processState, { barrierDir, phase, ready }) as SmokeProcess;
  } catch (error) {
    await stopSmoke(processState);
    await claimChildRunDirectories(processState);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${processState.output()}`);
  }
}

async function releaseSmoke(processState: SmokeProcess, action: 'continue' | 'return' | 'throw'): Promise<void> {
  await writeFile(
    join(processState.barrierDir, `${processState.phase}.release.json`),
    JSON.stringify({ action }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function waitForExit(
  processState: SpawnedSmoke,
  timeoutMs = 15_000,
): Promise<[number | null, NodeJS.Signals | null]> {
  const timedOut = Symbol('timed-out');
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    processState.exit,
    new Promise<typeof timedOut>((resolveTimeout) => {
      timeout = setTimeout(resolveTimeout, timeoutMs, timedOut);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  if (result === timedOut) {
    await stopSmoke(processState);
    throw new Error(`等待 smoke 子进程退出超时\n${processState.output()}`);
  }
  return result;
}

async function readResult(runDir: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(runDir, 'smoke-result.json'), 'utf8')) as Record<string, any>;
}

test('全量冒烟正常完成时默认删除克隆并保留安全权限报告', { timeout: 30_000 }, async (context) => {
  const sourceDataDir = await createSourceData();
  const processState = await startPausedSmoke(context, sourceDataDir, 'clone-complete');
  assert.equal(await exists(processState.ready.cloneDataDir), true, '屏障前应已完成克隆');

  await releaseSmoke(processState, 'return');
  const [code, signal] = await waitForExit(processState);
  assert.equal(signal, null, processState.output());
  assert.equal(code, 0, processState.output());
  assert.equal(await exists(processState.ready.cloneDataDir), false, '正常结束必须删除生产克隆');
  assert.equal(await mode(processState.ready.runDir), 0o700);
  assert.equal(await mode(join(processState.ready.runDir, 'smoke-owner.json')), 0o600);
  assert.equal(await mode(join(processState.ready.runDir, 'smoke-result.json')), 0o600);
  assert.equal(await mode(join(processState.ready.runDir, 'captured-prompts.json')), 0o600);
  const report = await readResult(processState.ready.runDir);
  assert.equal(report.cleanup.cloneDataRemoved, true);
  assert.equal(report.cleanup.keptByRequest, false);
});

test('全量冒烟异常时删除克隆并写最小失败报告', { timeout: 30_000 }, async (context) => {
  const sourceDataDir = await createSourceData();
  const processState = await startPausedSmoke(context, sourceDataDir, 'clone-complete');
  await releaseSmoke(processState, 'throw');

  const [code, signal] = await waitForExit(processState);
  assert.equal(signal, null, processState.output());
  assert.equal(code, 1, processState.output());
  assert.equal(await exists(processState.ready.cloneDataDir), false, '异常结束必须删除生产克隆');
  const report = await readResult(processState.ready.runDir);
  assert.match(report.error.message, /test barrier requested failure/u);
  assert.equal(report.cleanup.cloneDataRemoved, true);
  assert.equal(await mode(join(processState.ready.runDir, 'smoke-result.json')), 0o600);
});

test('独立 DB_PATH 与自定义 dataDir 会克隆真实数据库和文件目录', { timeout: 30_000 }, async (context) => {
  const sourceDataDir = await createSourceData();
  const databaseRoot = await mkdtemp(join(tmpdir(), 'full-smoke-independent-db-'));
  ownedPaths.add(databaseRoot);
  const sourceDatabasePath = join(databaseRoot, 'database', 'live.sqlite');
  await mkdir(join(databaseRoot, 'database'), { recursive: true });
  const sourceDatabase = new DatabaseSync(sourceDatabasePath);
  try {
    sourceDatabase.exec('CREATE TABLE smoke_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    sourceDatabase.prepare('INSERT INTO smoke_fixture(value) VALUES (?)').run('configured-independent-db');
  } finally {
    sourceDatabase.close();
  }

  const processState = await startPausedSmoke(context, sourceDataDir, 'clone-complete', {
    SMOKE_TEST_SOURCE_DATABASE_PATH: sourceDatabasePath,
  });
  const cloneDatabase = new DatabaseSync(join(processState.ready.cloneDataDir, 'app.db'), { readOnly: true });
  try {
    const row = cloneDatabase.prepare('SELECT value FROM smoke_fixture').get() as { value: string };
    assert.equal(row.value, 'configured-independent-db', '不得克隆 dataDir/app.db 遗留库');
  } finally {
    cloneDatabase.close();
  }
  assert.equal(
    await readFile(join(processState.ready.cloneDataDir, 'knowledge', 'fixture.md'), 'utf8'),
    '# 可丢弃知识\n',
  );
  assert.equal(
    await readFile(join(processState.ready.cloneDataDir, 'images', 'fixture.txt'), 'utf8'),
    'not-a-real-image\n',
  );

  await releaseSmoke(processState, 'return');
  const [code, signal] = await waitForExit(processState);
  assert.deepEqual([code, signal], [0, null], processState.output());
});

test('SIGINT、SIGTERM、SIGHUP 等待克隆稳定后清理并保留原信号退出语义', { timeout: 60_000 }, async (context) => {
  const cases: Array<{ signal: NodeJS.Signals; phase: string; repeated?: boolean }> = [
    { signal: 'SIGINT', phase: 'clone-files-pending', repeated: true },
    { signal: 'SIGTERM', phase: 'clone-complete' },
    { signal: 'SIGHUP', phase: 'clone-complete' },
  ];
  for (const item of cases) {
    await context.test(item.signal, { timeout: 20_000 }, async (childContext) => {
      const sourceDataDir = await createSourceData();
      const processState = await startPausedSmoke(childContext, sourceDataDir, item.phase);
      assert.equal(await exists(processState.ready.cloneDataDir), true, '信号前应已创建克隆目录');
      assert.equal(processState.child.kill(item.signal), true);
      if (item.repeated) {
        await delay(20);
        processState.child.kill(item.signal);
      }
      if (item.phase === 'clone-files-pending') {
        await delay(20);
        await releaseSmoke(processState, 'continue');
      }

      const [code, signal] = await waitForExit(processState);
      assert.equal(code, null, processState.output());
      assert.equal(signal, item.signal, processState.output());
      assert.equal(await exists(processState.ready.cloneDataDir), false, `${item.signal} 后不得残留克隆`);
      const report = await readResult(processState.ready.runDir);
      assert.equal(report.interruption.signal, item.signal);
      assert.equal(report.cleanup.cloneDataRemoved, true);
      assert.equal(await mode(join(processState.ready.runDir, 'smoke-result.json')), 0o600);
    });
  }
});

test('应用已启动后 SIGTERM 仍由 smoke 专用 handler 完成清理并按原信号退出', { timeout: 30_000 }, async (context) => {
  const sourceDataDir = await createSourceData();
  const processState = await startPausedSmoke(context, sourceDataDir, 'application-ready', {
    SMOKE_DISABLE_MODEL: 'false',
    OPENAI_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
  });
  assert.equal(processState.child.kill('SIGTERM'), true);

  const [code, signal] = await waitForExit(processState);
  assert.equal(code, null, processState.output());
  assert.equal(signal, 'SIGTERM', processState.output());
  assert.equal(await exists(processState.ready.cloneDataDir), false);
  const report = await readResult(processState.ready.runDir);
  assert.equal(report.interruption.signal, 'SIGTERM');
  assert.equal(report.cleanup.cloneDataRemoved, true);
});

test('显式 keep 保留克隆，显式开发库持久化不删除源数据', { timeout: 40_000 }, async (context) => {
  await context.test('SMOKE_KEEP_CLONE_DATA=true', async (childContext) => {
    const sourceDataDir = await createSourceData();
    const processState = await startPausedSmoke(childContext, sourceDataDir, 'clone-complete', {
      SMOKE_KEEP_CLONE_DATA: 'true',
    });
    await releaseSmoke(processState, 'return');
    const [code, signal] = await waitForExit(processState);
    assert.deepEqual([code, signal], [0, null], processState.output());
    assert.equal(await exists(processState.ready.cloneDataDir), true);
    const report = await readResult(processState.ready.runDir);
    assert.equal(report.cleanup.keptByRequest, true);
    assert.equal(report.cleanup.cloneDataRemoved, false);
  });

  await context.test('SMOKE_PERSIST_DEVELOPMENT_DATA=true', async (childContext) => {
    const sourceDataDir = await createSourceData();
    const processState = await startPausedSmoke(childContext, sourceDataDir, 'clone-complete', {
      SMOKE_PERSIST_DEVELOPMENT_DATA: 'true',
    });
    await releaseSmoke(processState, 'return');
    const [code, signal] = await waitForExit(processState);
    assert.deepEqual([code, signal], [0, null], processState.output());
    assert.equal(await exists(join(sourceDataDir, 'app.db')), true, '开发库不得被 cleanup 删除');
    assert.equal(await exists(processState.ready.cloneDataDir), false, '持久化模式不创建克隆');
    const report = await readResult(processState.ready.runDir);
    assert.equal(report.storage.mode, 'development_database');
    assert.equal(report.cleanup.cloneDataRemoved, false);
  });
});

async function createStaleFixture(
  name: string,
  options: {
    startedAt: string;
    owner?: {
      pid: number;
      runToken: string;
      processStartIdentity: StructuredIdentity;
      keep: boolean;
    };
    keptByRequest?: boolean;
    terminalState?: 'completed' | 'failed' | 'running';
    writeReport?: boolean;
    owned?: boolean;
  },
): Promise<string> {
  const directory = join(smokeRoot, `full-generation-smoke-test-${name}-${randomUUID()}`);
  if (options.owned !== false) ownedPaths.add(directory);
  await mkdir(join(directory, 'data'), { recursive: true });
  await writeFile(join(directory, 'data', 'sentinel.txt'), name, 'utf8');
  if (options.writeReport !== false) {
    const smokeResult: Record<string, unknown> = {
      startedAt: options.startedAt,
      cleanup: { keptByRequest: options.keptByRequest ?? false },
    };
    if (options.terminalState === 'completed') smokeResult.completedAt = options.startedAt;
    if (options.terminalState === 'failed') smokeResult.failedAt = options.startedAt;
    await writeFile(
      join(directory, 'smoke-result.json'),
      JSON.stringify(smokeResult),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  if (options.owner) {
    await writeFile(join(directory, 'smoke-owner.json'), JSON.stringify({
      ...options.owner,
      startedAt: options.startedAt,
    }), { encoding: 'utf8', mode: 0o600 });
  }
  const fixtureTime = new Date(options.startedAt);
  await utimes(directory, fixtureTime, fixtureTime);
  return directory;
}

test('陈旧清理跨 TZ 识别活 owner，并 fail-safe 保留未知 legacy 目录', { timeout: 30_000 }, async (context) => {
  await mkdir(smokeRoot, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const fresh = new Date().toISOString();
  const currentIdentity = await identityWithCallerEnvironment(process.pid, 'Pacific/Honolulu', 'C');
  assert.equal(currentIdentity.kind, 'known', '测试进程应有可比较的启动标识');
  const reusedIdentity: StructuredIdentity = {
    ...currentIdentity,
    value: `${currentIdentity.value}-different`,
  };

  const dead = await createStaleFixture('dead', {
    startedAt: old,
    owner: {
      pid: 2_147_483_647,
      runToken: randomUUID(),
      processStartIdentity: { kind: 'known', backend: 'ps-lstart', value: 'dead-owner' },
      keep: false,
    },
  });
  const reusedPid = await createStaleFixture('pid-reused', {
    startedAt: old,
    owner: {
      pid: process.pid,
      runToken: randomUUID(),
      processStartIdentity: reusedIdentity,
      keep: false,
    },
  });
  const freshDead = await createStaleFixture('fresh', {
    startedAt: fresh,
    owner: {
      pid: 2_147_483_647,
      runToken: randomUUID(),
      processStartIdentity: { kind: 'known', backend: 'ps-lstart', value: 'dead-owner' },
      keep: false,
    },
  });
  const active = await createStaleFixture('active', {
    startedAt: old,
    owner: {
      pid: process.pid,
      runToken: randomUUID(),
      processStartIdentity: currentIdentity,
      keep: false,
    },
  });
  const kept = await createStaleFixture('keep', {
    startedAt: old,
    owner: {
      pid: 2_147_483_647,
      runToken: randomUUID(),
      processStartIdentity: { kind: 'known', backend: 'ps-lstart', value: 'dead-owner' },
      keep: true,
    },
  });
  const legacyCompleted = await createStaleFixture('legacy-completed', {
    startedAt: old,
    keptByRequest: false,
    terminalState: 'completed',
  });
  const legacyFailed = await createStaleFixture('legacy-failed', {
    startedAt: old,
    keptByRequest: false,
    terminalState: 'failed',
  });
  const legacyKept = await createStaleFixture('legacy-keep', {
    startedAt: old,
    keptByRequest: true,
    terminalState: 'completed',
  });
  const legacyUnknown = await createStaleFixture('legacy-unknown', {
    startedAt: old,
    writeReport: false,
  });
  const legacyRunning = await createStaleFixture('legacy-running', {
    startedAt: old,
    keptByRequest: false,
    terminalState: 'running',
  });

  const sourceDataDir = await createSourceData();
  const processState = await startPausedSmoke(context, sourceDataDir, 'stale-cleanup-complete', {
    SMOKE_STALE_CLONE_GRACE_MS: '60000',
    TZ: 'Asia/Tokyo',
    LC_ALL: 'POSIX',
  });
  await releaseSmoke(processState, 'return');
  const [code, signal] = await waitForExit(processState);
  assert.deepEqual([code, signal], [0, null], processState.output());

  for (const cleaned of [dead, reusedPid, legacyCompleted, legacyFailed]) {
    assert.equal(await exists(join(cleaned, 'data')), false, `${cleaned} 的陈旧 data 应清理`);
    assert.equal(await exists(join(cleaned, 'smoke-result.json')), true, '清理 data 时必须保留报告取证');
  }
  for (const retained of [freshDead, active, kept, legacyKept, legacyUnknown, legacyRunning]) {
    assert.equal(await exists(join(retained, 'data')), true, `${retained} 不得误删`);
  }
});

test('失败路径只认领 spawn 子进程目录，不删除并行 live/keep 陷阱', { timeout: 30_000 }, async (context) => {
  const sourceDataDir = await createSourceData();
  let trap: string | undefined;
  const failedStart = assert.rejects(
    startPausedSmoke(context, sourceDataDir, 'never-reached', {}, async (processState) => {
      const childPid = processState.child.pid;
      assert.ok(childPid, 'spawn 子进程必须已有 PID');
      const childIdentity = await processIdentity.processStartIdentity(childPid) as unknown as StructuredIdentity;
      assert.equal(childIdentity.kind, 'known');
      trap = await createStaleFixture('same-pid-different-token-trap', {
        startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        owner: {
          pid: childPid,
          runToken: randomUUID(),
          processStartIdentity: childIdentity,
          keep: true,
        },
        owned: false,
      });
      context.after(async () => rm(trap!, { recursive: true, force: true }));
    }),
    /子进程在写入屏障前退出/u,
  );

  await failedStart;
  assert.ok(trap);
  await cleanupOwnedPaths();
  assert.equal(await exists(join(trap, 'data', 'sentinel.txt')), true, '并行陷阱目录不得被测试清理器认领');
});

test('轮询子进程在测试回调失败时由 finally 终止并等待退出', { timeout: 30_000 }, async (context) => {
  const sourceDataDir = await createSourceData();
  let processState: SmokeProcess | undefined;
  await assert.rejects(
    async () => {
      processState = await startPausedSmoke(context, sourceDataDir, 'clone-files-pending');
      try {
        throw new Error('intentional assertion failure while child is polling');
      } finally {
        await stopSmoke(processState);
      }
    },
    /intentional assertion failure/u,
  );
  assert.ok(processState);
  const [code, signal] = await processState.exit;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  assert.equal(processState.exited, true);
});

test('全量 smoke 在校验测试专用环境变量之前不得读取仓库 .env', () => {
  const source = readFileSync(smokeScript, 'utf8');
  assert.doesNotMatch(
    source,
    /^const repositoryStorage[\s\S]*?await resolveRepositoryStoragePaths/mu,
    '模块顶层读取 .env 会让无仓库 .env 的 CI 在 NODE_ENV 校验前崩溃',
  );
  const mainStart = source.indexOf('async function main()');
  assert.ok(mainStart >= 0, '缺少 main()');
  const validateAt = source.indexOf('validateRuntimeControls();', mainStart);
  const resolveAt = source.indexOf('await resolveRepositoryStoragePaths', mainStart);
  assert.ok(validateAt >= 0, 'main 必须校验测试专用开关');
  assert.ok(resolveAt >= 0, 'main 在校验通过后才解析仓库存储路径');
  assert.ok(validateAt < resolveAt, 'NODE_ENV=test 校验必须发生在读取仓库 .env 之前');
});

test('非 test 环境拒绝测试 sourceDataDir 与暂停屏障配置', { timeout: 30_000 }, async (context) => {
  const sourceDataDir = await createSourceData();
  const barrierDir = await mkdtemp(join(tmpdir(), 'full-smoke-invalid-barrier-'));
  ownedPaths.add(barrierDir);
  await mkdir(smokeRoot, { recursive: true });
  const processState = spawnSmoke(context, cleanSmokeEnv({
    NODE_ENV: 'production',
    SMOKE_TEST_SOURCE_DATA_DIR: sourceDataDir,
    SMOKE_TEST_SOURCE_DATABASE_PATH: join(sourceDataDir, 'app.db'),
    SMOKE_TEST_BARRIER_DIR: barrierDir,
    SMOKE_TEST_PAUSE_AT: 'clone-complete',
  }));
  const [code, signal] = await waitForExit(processState);
  assert.equal(signal, null, processState.output());
  assert.equal(code, 1, processState.output());
  assert.match(processState.output(), /only allowed when NODE_ENV=test/u);
  assert.match(processState.output(), /SMOKE_TEST_SOURCE_DATABASE_PATH/u);
  assert.match(processState.output(), /SMOKE_TEST_RUN_TOKEN/u, '非 test 环境必须显式拒绝测试 runToken');
  assert.equal(await exists(join(sourceDataDir, 'app.db')), true);
  const claimed = await claimChildRunDirectories(processState);
  assert.equal(claimed.length, 1, processState.output());
  const runDir = claimed[0]!;
  assert.equal(await mode(runDir), 0o700);
  assert.equal(await mode(join(runDir, 'smoke-result.json')), 0o600);
});

test('克隆删除失败时进程必须非零退出', { timeout: 30_000 }, async (context) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    context.skip('root 可绕过目录写权限，无法构造真实 rm 失败');
    return;
  }
  const sourceDataDir = await createSourceData();
  const processState = await startPausedSmoke(context, sourceDataDir, 'clone-complete');
  await chmod(processState.ready.runDir, 0o500);
  try {
    await releaseSmoke(processState, 'return');
    const [code, signal] = await waitForExit(processState);
    assert.equal(signal, null, processState.output());
    assert.equal(code, 1, processState.output());
    assert.equal(await exists(processState.ready.cloneDataDir), true, 'rm 失败时克隆仍应存在以便排障');
  } finally {
    await chmod(processState.ready.runDir, 0o700);
  }
});

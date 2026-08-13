import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFormulaVersion, DEFAULT_FORMULA_VERSION } from '@content-agent/agent-core';
import { DatabaseService } from '../src/database.service.js';
import { claimNextJob, heartbeatJob, reclaimStaleJobs } from '../src/job-claim.js';
import { KnowledgeService } from '../src/knowledge.service.js';

/**
 * 两个实例共用同一个 SQLite 文件。
 *
 * 这是实测踩到的场景:两个 API 进程共用 data/app.db,各自启动时的恢复逻辑把对方
 * 正在跑的任务判成「被重启打断」,计数 +1 并抢回队列。三轮之后任务被判 failed,
 * 报「任务被应用重启多次打断(3 次)」——而实际上没有任何一次真正的重启。
 *
 * 用两个独立的 DatabaseService 指向同一个文件来复现:每个实例有自己的连接、自己
 * 的 instanceId,和真实部署一致。WAL + busy_timeout + BEGIN IMMEDIATE 已经保证
 * 引擎层安全,这里验的是**业务不变式**:不重复执行、不误杀、不丢任务。
 */

let dataDir = '';
let databasePath = '';
let instanceA: DatabaseService;
let instanceB: DatabaseService;

const ID_A = 'host:1001:aaaa';
const ID_B = 'host:1002:bbbb';
const CLAIM_TIMEOUT_MS = 90_000;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-multi-instance-'));
  databasePath = join(dataDir, 'app.db');
  // 两个连接,同一个文件——迁移幂等,第二个构造只会读到 user_version 已是最新。
  instanceA = new DatabaseService({ dataDir, databasePath } as never);
  instanceB = new DatabaseService({ dataDir, databasePath } as never);
  seedParents();
});

after(async () => {
  instanceA?.onModuleDestroy?.();
  instanceB?.onModuleDestroy?.();
  await rm(dataDir, { recursive: true, force: true });
});

function seedParents(): void {
  const now = new Date().toISOString();
  instanceA
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, system_role, created_at, updated_at)
       VALUES ('u1','multi-instance-fixture','x','admin',?,?)`,
    )
    .run(now, now);
  instanceA
    .prepare('INSERT OR IGNORE INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('w1', 'ws', 'ws', 'u1', now, now);
  instanceA
    .prepare(
      `INSERT OR IGNORE INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
       VALUES ('p1','w1','proj','项目','u1',?,?)`,
    )
    .run(now, now);
}

function seedProject(id: string): void {
  const now = new Date().toISOString();
  instanceA.prepare(
    `INSERT OR IGNORE INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
     VALUES (?, 'w1', ?, ?, 'u1', ?, ?)`,
  ).run(id, id, id, now, now);
}

function seedFormula(projectId: string, id: string, versionNumber: number, status: 'active' | 'draft'): void {
  const createdAt = new Date().toISOString();
  const version = createFormulaVersion({
    id,
    projectId,
    version: `${versionNumber}.0.0${status === 'draft' ? '-draft' : ''}`,
    status,
    createdAt,
    formulas: DEFAULT_FORMULA_VERSION.formulas,
  });
  instanceA.prepare(
    `INSERT INTO formula_versions
       (id, project_id, version, status, definition_json, created_by, created_at, activated_at)
     VALUES (?, ?, ?, ?, ?, 'u1', ?, ?)`,
  ).run(
    id,
    projectId,
    versionNumber,
    status,
    JSON.stringify({ name: '并发测试公式', description: '并发测试', version, config: {} }),
    createdAt,
    status === 'active' ? createdAt : null,
  );
}

function seedQueued(id: string, createdAt: string): void {
  const now = new Date().toISOString();
  instanceA
    .prepare(
      `INSERT INTO generation_jobs
         (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
          topic, goal, mode, progress, knowledge_context_json, style_profile_version,
          resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
          planning_context_json, image_context_json, research_snapshot_json, quality_status)
       VALUES (?, 'p1', 'queued', '{}', 's', 'u1', ?, ?, ?, 'g', 'simple', 0, '{}', 1,
          '{}', '{}', '{}', '{}', '[]', '{}', 'unknown')`,
    )
    .run(id, createdAt, now, `选题-${id}`);
}

function rowOf(id: string) {
  return instanceA
    .prepare('SELECT status, claimed_by, resolution_snapshot_json FROM generation_jobs WHERE id=?')
    .get(id) as { status: string; claimed_by: string | null; resolution_snapshot_json: string };
}

function interruptionsOf(id: string): number {
  return Number((JSON.parse(rowOf(id).resolution_snapshot_json) as { restartInterruptions?: number }).restartInterruptions ?? 0);
}

interface VersionWorker {
  child: ChildProcessWithoutNullStreams;
  lines: AsyncIterator<string>;
  stderr: () => string;
}

interface WorkerResult {
  id: string;
  ok: boolean;
  version?: number;
  claimedId?: string;
  error?: string;
}

async function startVersionWorker(): Promise<VersionWorker> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./fixtures/version-allocation-worker.ts', import.meta.url))],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTENT_AGENT_DATA_DIR: dataDir,
        CONTENT_AGENT_DB_PATH: databasePath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let errorOutput = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { errorOutput += chunk; });
  const output: Interface = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = output[Symbol.asyncIterator]();
  const ready = await lines.next();
  assert.equal(ready.value, 'READY', errorOutput);
  return { child, lines, stderr: () => errorOutput };
}

async function stopVersionWorker(worker: VersionWorker): Promise<void> {
  worker.child.stdin.end();
  const [code] = await once(worker.child, 'exit') as [number | null];
  assert.equal(code, 0, worker.stderr());
}

async function readWorkerResult(
  worker: VersionWorker,
): Promise<WorkerResult> {
  const line = await worker.lines.next();
  assert.match(line.value ?? '', /^RESULT /u, worker.stderr());
  return JSON.parse(String(line.value).slice('RESULT '.length)) as WorkerResult;
}

async function commandWhileWriteLocked(
  worker: VersionWorker,
  id: string,
  operation: string,
  projectId: string,
  insertUncommittedVersion: () => void,
): Promise<WorkerResult> {
  instanceA.db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    insertUncommittedVersion();
    worker.child.stdin.write(`${JSON.stringify({ id, operation, projectId })}\n`);
    const started = await worker.lines.next();
    assert.equal(started.value, `START ${id}`, worker.stderr());
    // The worker is now blocked on BEGIN IMMEDIATE. The old implementation read
    // MAX(version) before this point and later collided with this pending row.
    await delay(50);
    instanceA.db.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) instanceA.db.exec('ROLLBACK');
  }
  return readWorkerResult(worker);
}

beforeEach(() => {
  instanceA.prepare('DELETE FROM generation_jobs').run();
});

test('24 篇任务被两个实例分完:每篇恰好领一次,没有一篇漏掉', () => {
  // 批量上限就是 24 篇,用真实规模。
  for (let i = 0; i < 24; i += 1) {
    seedQueued(`batch-${String(i).padStart(2, '0')}`, `2026-07-26T00:00:${String(i).padStart(2, '0')}.000Z`);
  }

  const claimedByA: string[] = [];
  const claimedByB: string[] = [];
  // 交替领取,直到两边都领不到——模拟两个实例各自 drainQueue。
  for (;;) {
    const a = claimNextJob(instanceA, ID_A, new Date().toISOString());
    const b = claimNextJob(instanceB, ID_B, new Date().toISOString());
    if (a) claimedByA.push(a);
    if (b) claimedByB.push(b);
    if (!a && !b) break;
  }

  const all = [...claimedByA, ...claimedByB];
  assert.equal(all.length, 24, '24 篇都要被领走,不能有漏');
  assert.equal(new Set(all).size, 24, '不能有任何一篇被领两次');
  assert.ok(claimedByA.length > 0 && claimedByB.length > 0, '两个实例都该分到活');
  // 领完之后队列空,库里全是 running。
  const stillQueued = instanceA
    .prepare("SELECT COUNT(*) AS value FROM generation_jobs WHERE status='queued'")
    .get() as { value: number };
  assert.equal(Number(stillQueued.value), 0);
});

test('跨进程领取等待写锁后基于最新队列继续取下一条', async () => {
  seedQueued('claim-first', '2026-07-26T00:00:01.000Z');
  seedQueued('claim-second', '2026-07-26T00:00:02.000Z');
  const worker = await startVersionWorker();
  const claimedAt = new Date().toISOString();
  let committed = false;
  instanceA.db.exec('BEGIN IMMEDIATE');
  try {
    const claimed = instanceA.prepare(
      `UPDATE generation_jobs
          SET status='running', claimed_by=?, claimed_at=?, heartbeat_at=?, updated_at=?
        WHERE id='claim-first' AND status='queued'`,
    ).run(ID_A, claimedAt, claimedAt, claimedAt);
    assert.equal(claimed.changes, 1);

    worker.child.stdin.write(`${JSON.stringify({ id: 'claim-race', operation: 'claim-job' })}\n`);
    const started = await worker.lines.next();
    assert.equal(started.value, 'START claim-race', worker.stderr());
    // 子进程此时阻塞在原子 UPDATE 的 SQLite 写锁上。提交后它必须重新读取最新
    // 快照并选择第二条,不能拿着锁前的候选覆盖第一条,也不能误报队列为空。
    await delay(50);
    instanceA.db.exec('COMMIT');
    committed = true;

    const result = await readWorkerResult(worker);
    assert.deepEqual(result, { id: 'claim-race', ok: true, claimedId: 'claim-second' });
    const owners = (instanceA.prepare(
      'SELECT id, status, claimed_by FROM generation_jobs ORDER BY created_at, id',
    ).all() as Array<{ id: string; status: string; claimed_by: string | null }>)
      .map((row) => ({ ...row }));
    assert.deepEqual(owners, [
      { id: 'claim-first', status: 'running', claimed_by: ID_A },
      { id: 'claim-second', status: 'running', claimed_by: 'worker:claim-job' },
    ]);
  } finally {
    if (!committed) instanceA.db.exec('ROLLBACK');
    await stopVersionWorker(worker);
  }
});

test('B 实例启动不会抢走 A 正在跑的任务:实测被判 failed 的那条路径', () => {
  seedQueued('a-job', '2026-07-26T00:00:01.000Z');
  const claimed = claimNextJob(instanceA, ID_A, new Date().toISOString());
  assert.equal(claimed, 'a-job');

  // B 启动:回收孤儿 → 领队列。A 的心跳是刚才领取时写的,新鲜。
  const reclaimed = reclaimStaleJobs(instanceB, new Date().toISOString(), CLAIM_TIMEOUT_MS);
  const bClaim = claimNextJob(instanceB, ID_B, new Date().toISOString());

  assert.deepEqual(reclaimed, { requeued: [], failed: [] }, 'A 的任务不该被回收');
  assert.equal(bClaim, undefined, '没有排队任务了,B 不该领到东西');
  assert.equal(rowOf('a-job').claimed_by, ID_A, '归属不能被抢走');
  assert.equal(interruptionsOf('a-job'), 0, '打断计数不能被别的实例启动污染');
});

test('反复启动 B 也不会把 A 的任务累计打断到触顶判死', () => {
  seedQueued('long-job', '2026-07-26T00:00:01.000Z');
  claimNextJob(instanceA, ID_A, new Date().toISOString());

  // 模拟 B 反复重启(实测就是这样把计数推到 3 的),期间 A 持续续心跳。
  for (let i = 0; i < 5; i += 1) {
    assert.equal(heartbeatJob(instanceA, 'long-job', ID_A, new Date().toISOString()), true);
    reclaimStaleJobs(instanceB, new Date().toISOString(), CLAIM_TIMEOUT_MS);
  }

  const row = rowOf('long-job');
  assert.equal(row.status, 'running', '任务必须一直在跑,不能被判 failed');
  assert.equal(row.claimed_by, ID_A);
  assert.equal(interruptionsOf('long-job'), 0);
});

test('A 停止心跳后 B 能接管:实例崩掉的任务不会永久卡住', () => {
  const start = new Date('2026-07-26T12:00:00.000Z');
  seedQueued('handover', '2026-07-26T00:00:01.000Z');
  claimNextJob(instanceA, ID_A, start.toISOString());

  // A 崩了,心跳停在 start;时间前进到超时之后。
  const later = new Date(start.getTime() + CLAIM_TIMEOUT_MS + 30_000);
  const reclaimed = reclaimStaleJobs(instanceB, later.toISOString(), CLAIM_TIMEOUT_MS);
  assert.deepEqual(reclaimed.requeued, ['handover']);

  const bClaim = claimNextJob(instanceB, ID_B, later.toISOString());
  assert.equal(bClaim, 'handover', 'B 应能接着跑');
  assert.equal(rowOf('handover').claimed_by, ID_B);
  assert.equal(interruptionsOf('handover'), 1, '真实中断才计数');

  // A 若「复活」再想续心跳,必须失败——否则两个实例会同时写同一份产出。
  assert.equal(heartbeatJob(instanceA, 'handover', ID_A, later.toISOString()), false);
});

test('两个实例同时回收同一批孤儿:任务只被归还一次,计数不重复累加', () => {
  const start = new Date('2026-07-26T12:00:00.000Z');
  seedQueued('shared-orphan', '2026-07-26T00:00:01.000Z');
  claimNextJob(instanceA, ID_A, start.toISOString());
  const later = new Date(start.getTime() + CLAIM_TIMEOUT_MS + 30_000);

  const first = reclaimStaleJobs(instanceA, later.toISOString(), CLAIM_TIMEOUT_MS);
  const second = reclaimStaleJobs(instanceB, later.toISOString(), CLAIM_TIMEOUT_MS);

  assert.deepEqual(first.requeued, ['shared-orphan']);
  // 第一次已把它标回 queued,第二次扫描只看 running,所以看不到它。
  assert.deepEqual(second.requeued, [], '同一个孤儿不该被回收两次');
  assert.equal(interruptionsOf('shared-orphan'), 1, '计数不能被多个实例各加一次');
});

test('配额扣减在两个连接间不超发:上限就是上限', () => {
  const now = new Date().toISOString();
  instanceA
    .prepare(
      `INSERT OR REPLACE INTO workspace_settings
         (workspace_id, provider_mode, provider, model, base_url, transport,
          monthly_quota, quota_used, default_temperature, updated_by, updated_at)
       VALUES ('w1','platform','openai','m','http://x/v1','chat_completions',5,0,0.8,'u1',?)`,
    )
    .run(now);

  // 两个连接交替扣,共尝试 12 次,上限 5。
  const consume = (db: DatabaseService) => db
    .prepare(
      `UPDATE workspace_settings SET quota_used = quota_used + 1, updated_at=?
        WHERE workspace_id='w1' AND quota_used < monthly_quota`,
    )
    .run(new Date().toISOString()).changes;

  let granted = 0;
  for (let i = 0; i < 12; i += 1) granted += consume(i % 2 === 0 ? instanceA : instanceB) ? 1 : 0;

  assert.equal(granted, 5, '只应放行到上限');
  const row = instanceA.prepare("SELECT quota_used FROM workspace_settings WHERE workspace_id='w1'").get() as { quota_used: number };
  assert.equal(Number(row.quota_used), 5, 'quota_used 不得越过 monthly_quota');
});

test('两个连接导入同名知识文件时分配不同版本', async () => {
  const resources = { projectRow: () => ({ workspace_id: 'w1' }) } as never;
  const audit = { record: () => undefined } as never;
  const intelligence = { markProjectStale: () => undefined } as never;
  const serviceA = new KnowledgeService(instanceA, resources, audit, intelligence);
  const serviceB = new KnowledgeService(instanceB, resources, audit, intelligence);
  const principal = { userId: 'u1' } as never;

  const [first, second] = await Promise.all([
    serviceA.import({ projectId: 'p1', filename: 'parallel.md', content: '版本 A', principal }),
    serviceB.import({ projectId: 'p1', filename: 'parallel.md', content: '版本 B', principal }),
  ]);

  assert.deepEqual(
    [Number(first.version), Number(second.version)].sort((a, b) => a - b),
    [1, 2],
  );
  const rows = instanceA.prepare(
    "SELECT version FROM knowledge_files WHERE project_id='p1' AND filename='parallel.md' ORDER BY version",
  ).all() as Array<{ version: number }>;
  assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2]);
});

test('版本取号在跨进程写锁后执行:公式、研究资源与项目智能都连续且不冲突', async () => {
  const worker = await startVersionWorker();
  const now = new Date().toISOString();
  try {
    const formulaProject = 'p-version-formula';
    seedProject(formulaProject);
    seedFormula(formulaProject, `${formulaProject}-v1`, 1, 'active');
    const formula = await commandWhileWriteLocked(
      worker,
      'formula',
      'formula',
      formulaProject,
      () => seedFormula(formulaProject, `${formulaProject}-v2`, 2, 'draft'),
    );
    assert.deepEqual(formula, { id: 'formula', ok: true, version: 3 });

    const defaultProject = 'p-version-default';
    seedProject(defaultProject);
    const defaultFormula = await commandWhileWriteLocked(
      worker,
      'ensure-default',
      'ensure-default',
      defaultProject,
      () => seedFormula(defaultProject, `${defaultProject}-v1`, 1, 'active'),
    );
    assert.deepEqual(defaultFormula, { id: 'ensure-default', ok: true, version: 1 });
    assert.equal(
      Number((instanceA.prepare('SELECT COUNT(*) AS value FROM formula_versions WHERE project_id=?').get(defaultProject) as { value: number }).value),
      1,
    );

    const claimProject = 'p-version-claim';
    seedProject(claimProject);
    const claim = await commandWhileWriteLocked(worker, 'claim', 'claim', claimProject, () => {
      instanceA.prepare(
        `INSERT INTO research_claims
           (id,project_id,logical_key,version,parent_id,title,statement,claim_type,status,scope_json,metadata_json,created_by,created_at)
         VALUES (?,?, 'parallel-claim',1,NULL,'并发主张 1','内容 1','hypothesis','draft','[]','{}','u1',?)`,
      ).run(`${claimProject}-v1`, claimProject, now);
    });
    assert.deepEqual(claim, { id: 'claim', ok: true, version: 2 });

    const sourceProject = 'p-version-source';
    seedProject(sourceProject);
    const source = await commandWhileWriteLocked(worker, 'source', 'source', sourceProject, () => {
      instanceA.prepare(
        `INSERT INTO evidence_sources
           (id,project_id,source_key,version,parent_id,kind,citation,url,supports_text,limitations_text,status,metadata_json,created_by,created_at)
         VALUES (?,?, 'parallel-source',1,NULL,'test','并发来源 1',NULL,'','','draft','{}','u1',?)`,
      ).run(`${sourceProject}-v1`, sourceProject, now);
    });
    assert.deepEqual(source, { id: 'source', ok: true, version: 2 });

    const datasetProject = 'p-version-dataset';
    seedProject(datasetProject);
    const dataset = await commandWhileWriteLocked(worker, 'dataset', 'dataset', datasetProject, () => {
      instanceA.prepare(
        `INSERT INTO dataset_snapshots
           (id,project_id,dataset_key,version,label,kind,sha256,row_count,storage_ref,provenance,limitations,schema_json,status,created_by,created_at)
         VALUES (?,?, 'parallel-dataset',1,'并发数据集 1','internal_sample',?,NULL,'','','','{}','draft','u1',?)`,
      ).run(`${datasetProject}-v1`, datasetProject, 'b'.repeat(64), now);
    });
    assert.deepEqual(dataset, { id: 'dataset', ok: true, version: 2 });

    const experimentProject = 'p-version-experiment';
    seedProject(experimentProject);
    const experiment = await commandWhileWriteLocked(worker, 'experiment', 'experiment', experimentProject, () => {
      instanceA.prepare(
        `INSERT INTO experiment_versions
           (id,project_id,experiment_key,version,parent_id,title,hypothesis,design_json,metrics_json,analysis_plan_json,status,created_by,created_at)
         VALUES (?,?, 'parallel-experiment',1,NULL,'并发实验 1','假设 1','{}','[]','{}','draft','u1',?)`,
      ).run(`${experimentProject}-v1`, experimentProject, now);
    });
    assert.deepEqual(experiment, { id: 'experiment', ok: true, version: 2 });

    const resultProject = 'p-version-result';
    seedProject(resultProject);
    instanceA.prepare(
      `INSERT INTO experiment_versions
         (id,project_id,experiment_key,version,parent_id,title,hypothesis,design_json,metrics_json,analysis_plan_json,status,created_by,created_at)
       VALUES (?,?,'result-parent',1,NULL,'结果父实验','假设','{}','[]','{}','running','u1',?)`,
    ).run(`${resultProject}-experiment-parent`, resultProject, now);
    const result = await commandWhileWriteLocked(worker, 'experiment-result', 'experiment-result', resultProject, () => {
      instanceA.prepare(
        `INSERT INTO experiment_results
           (id,experiment_version_id,version,dataset_snapshot_id,result_json,conclusion,status,created_by,created_at)
         VALUES (?, ?,1,NULL,'{}','inconclusive','draft','u1',?)`,
      ).run(`${resultProject}-result-v1`, `${resultProject}-experiment-parent`, now);
    });
    assert.deepEqual(result, { id: 'experiment-result', ok: true, version: 2 });

    const intelligenceProject = 'p-version-intelligence';
    seedProject(intelligenceProject);
    const intelligence = await commandWhileWriteLocked(worker, 'intelligence', 'intelligence', intelligenceProject, () => {
      instanceA.prepare(
        `INSERT INTO project_intelligence
           (id,project_id,version,status,source_fingerprint,map_json,created_by,created_at,updated_at)
         VALUES (?,?,1,'draft','fixture','{}','u1',?,?)`,
      ).run(`${intelligenceProject}-v1`, intelligenceProject, now, now);
    });
    assert.deepEqual(intelligence, { id: 'intelligence', ok: true, version: 2 });
  } finally {
    await stopVersionWorker(worker);
  }
});

test('两个进程初始化研究目录并回填缺失快照时都只写入一份', async () => {
  const projectId = 'p-parallel-bootstrap';
  seedProject(projectId);
  seedFormula(projectId, `${projectId}-formula`, 1, 'active');
  const workerA = await startVersionWorker();
  const workerB = await startVersionWorker();
  let catalogCountsBeforeRepair = { claims: 0, sources: 0 };
  let committed = false;
  instanceA.db.exec('BEGIN IMMEDIATE');
  try {
    workerA.child.stdin.write(`${JSON.stringify({ id: 'bootstrap-a', operation: 'bootstrap', projectId })}\n`);
    workerB.child.stdin.write(`${JSON.stringify({ id: 'bootstrap-b', operation: 'bootstrap', projectId })}\n`);
    const [startedA, startedB] = await Promise.all([workerA.lines.next(), workerB.lines.next()]);
    assert.equal(startedA.value, 'START bootstrap-a', workerA.stderr());
    assert.equal(startedB.value, 'START bootstrap-b', workerB.stderr());
    await delay(50);
    instanceA.db.exec('COMMIT');
    committed = true;
    const [resultA, resultB] = await Promise.all([readWorkerResult(workerA), readWorkerResult(workerB)]);
    assert.deepEqual(resultA, { id: 'bootstrap-a', ok: true });
    assert.deepEqual(resultB, { id: 'bootstrap-b', ok: true });

    catalogCountsBeforeRepair = {
      claims: Number((instanceA.prepare(
        'SELECT COUNT(*) AS value FROM research_claims WHERE project_id=?',
      ).get(projectId) as { value: number }).value),
      sources: Number((instanceA.prepare(
        'SELECT COUNT(*) AS value FROM evidence_sources WHERE project_id=?',
      ).get(projectId) as { value: number }).value),
    };
    const deleted = instanceA.prepare(
      "DELETE FROM dataset_snapshots WHERE project_id=? AND dataset_key='reference-copy-70'",
    ).run(projectId);
    assert.equal(Number(deleted.changes), 1, '并发回填前必须确实删除首次 bootstrap 的固化快照');

    let repairCommitted = false;
    instanceA.db.exec('BEGIN IMMEDIATE');
    try {
      workerA.child.stdin.write(`${JSON.stringify({ id: 'repair-a', operation: 'bootstrap', projectId })}\n`);
      workerB.child.stdin.write(`${JSON.stringify({ id: 'repair-b', operation: 'bootstrap', projectId })}\n`);
      const [repairStartedA, repairStartedB] = await Promise.all([workerA.lines.next(), workerB.lines.next()]);
      assert.equal(repairStartedA.value, 'START repair-a', workerA.stderr());
      assert.equal(repairStartedB.value, 'START repair-b', workerB.stderr());
      await delay(50);
      instanceA.db.exec('COMMIT');
      repairCommitted = true;
      const [repairA, repairB] = await Promise.all([readWorkerResult(workerA), readWorkerResult(workerB)]);
      assert.deepEqual(repairA, { id: 'repair-a', ok: true });
      assert.deepEqual(repairB, { id: 'repair-b', ok: true });
    } finally {
      if (!repairCommitted) instanceA.db.exec('ROLLBACK');
    }
  } finally {
    if (!committed) instanceA.db.exec('ROLLBACK');
    await Promise.all([stopVersionWorker(workerA), stopVersionWorker(workerB)]);
  }

  const claimGroups = instanceA.prepare(
    `SELECT logical_key, COUNT(*) AS count, MAX(version) AS max_version
       FROM research_claims WHERE project_id=? AND logical_key LIKE 'formula:%' GROUP BY logical_key`,
  ).all(projectId) as Array<{ logical_key: string; count: number; max_version: number }>;
  assert.ok(claimGroups.length > 0);
  assert.ok(claimGroups.every((row) => Number(row.count) === 1 && Number(row.max_version) === 1));

  const sourceGroups = instanceA.prepare(
    `SELECT source_key, COUNT(*) AS count, MAX(version) AS max_version
       FROM evidence_sources WHERE project_id=? GROUP BY source_key`,
  ).all(projectId) as Array<{ source_key: string; count: number; max_version: number }>;
  assert.ok(sourceGroups.length > 0);
  assert.ok(sourceGroups.every((row) => Number(row.count) === 1 && Number(row.max_version) === 1));

  const snapshots = (instanceA.prepare(
    `SELECT version, status, sha256, row_count
       FROM dataset_snapshots
      WHERE project_id=? AND dataset_key='reference-copy-70'`,
  ).all(projectId) as Array<{ version: number; status: string; sha256: string; row_count: number }>)
    .map((row) => ({ ...row }));
  assert.deepEqual(snapshots, [{
    version: 1,
    status: 'approved',
    sha256: 'a65514d622ea6c7085b9bf96c4241f9857d53e71fa254ad591f20496c94035ad',
    row_count: 70,
  }]);
  assert.deepEqual({
    claims: Number((instanceA.prepare(
      'SELECT COUNT(*) AS value FROM research_claims WHERE project_id=?',
    ).get(projectId) as { value: number }).value),
    sources: Number((instanceA.prepare(
      'SELECT COUNT(*) AS value FROM evidence_sources WHERE project_id=?',
    ).get(projectId) as { value: number }).value),
  }, catalogCountsBeforeRepair, '并发回填不得重复导入 formula claim 或 evidence source');

  const releases = instanceA.prepare(
    'SELECT status, COUNT(*) AS count FROM release_manifests WHERE project_id=? GROUP BY status',
  ).all(projectId) as Array<{ status: string; count: number }>;
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.status, 'active');
  assert.equal(Number(releases[0]?.count), 1);
});

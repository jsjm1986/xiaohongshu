import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ContentPackage } from '@content-agent/agent-core';
import { DatabaseService } from './database.service.js';
import type { SessionPrincipal } from './models.js';
import { nowIso, parseJson } from './utils.js';

/** 前端可见的修改任务投影。字段名用 camelCase,与其它投影一致。 */
export interface RevisionTaskView {
  id: string;
  jobId: string;
  candidateId: string;
  instruction: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  attemptCount: number;
  error: string | null;
  rerunChannels: string[];
  resultPackageId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/**
 * 任务行的原样映射。导出是因为 row() 是公有方法,而 tsconfig 开了 declaration:
 * 不导出会让 .d.ts 生成报 TS4053。
 */
export interface RevisionRow {
  id: string;
  job_id: string;
  package_id: string;
  candidate_id: string;
  instruction: string;
  status: string;
  progress: number;
  attempt_count: number;
  error: string | null;
  rerun_channels_json: string;
  result_package_id: string | null;
  /** 提交修改的人。执行阶段按他解析供应商设置与写审计,所以行映射要带上。 */
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** 已扣未退的额度次数。见 v15 建表块的列注释与 generation.service 的退还逻辑。 */
  quota_consumed_count: number;
}

const TERMINAL = new Set(['completed', 'failed']);

/**
 * 应用层检查与索引兜底给的是同一件事,文案也该是同一句。
 *
 * 措辞是「这篇稿子」而不是「这个候选」:互斥收到 job 级之后,拦住的可能是同一 job 的
 * 另一个候选,说「这个候选」会让用户对着没在改的候选找不着北。
 */
const REVISION_IN_PROGRESS = '这篇稿子还有一次修改正在进行，请等它完成后再提交';

/** SQLITE_CONSTRAINT_UNIQUE。node:sqlite 把它放在 error.errcode 上。 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * 撞上 revision_tasks_active_job_idx 了吗?
 *
 * 只认唯一约束,不认全部约束错误:外键失败(job_id 指向不存在的 job)也是 constraint
 * 错误,但那是 500 该有的样子,不能被当成「有人在改」而变成 409。
 */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === SQLITE_CONSTRAINT_UNIQUE || /UNIQUE constraint failed/i.test(error.message);
}

/**
 * 修改任务(revise)的队列。
 *
 * 原实现是同步请求-响应:前端只有一个转圈可显示,而耗时是分钟级,公网下会撞上
 * Cloudflare 约 100 秒超时。掐断后前端把指令追加进正文并提示「演示模式:已记录」,
 * 用户以为改好了、拿到的是被污染的正文。
 *
 * 本服务只管队列与投影;执行在 processRevision。
 */
@Injectable()
export class RevisionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /**
   * 受理一次修改请求并立即返回。
   *
   * candidateId 的解析只在这里发生一次:现有实现按
   * `content.candidateId === x || content.id === x` 双条件查找(原
   * generation.service.ts:639),也就是前端传来的标识可能是两者之一。入队时把它
   * 解析成确定的 content_packages.id 存进 package_id,执行路径就没有二义性。
   */
  enqueue(jobId: string, candidateId: string, instruction: string, principal: SessionPrincipal): RevisionTaskView {
    const trimmed = instruction.trim();
    if (!trimmed) throw new BadRequestException('修改要求不能为空');

    const job = this.database
      .prepare('SELECT id, status FROM generation_jobs WHERE id=? AND deleted_at IS NULL')
      .get(jobId) as { id: string; status: string } | undefined;
    if (!job) throw new NotFoundException('任务不存在');
    if (job.status !== 'completed') throw new BadRequestException('只有已完成任务可以修改');

    const packageId = this.resolvePackageId(jobId, candidateId);
    if (!packageId) throw new NotFoundException('候选内容不存在');

    /*
     * 一个 job 同时只允许一条未终态的修改。这里挡住而不是排队:用户看到的是
     * 「上一次还在改」,比默默排队更符合他按下按钮时的预期。
     *
     * 互斥的粒度是 job 而不是 package:投影 activeFor(jobId) 只回一条活跃任务,包级
     * 互斥允许同一 job 的两个候选并发改稿,于是先提交的那个候选在轮询里看不到自己的
     * 任务、立刻判「已完成」,把未更新的旧候选当成改稿结果报给用户(假成功)。同一
     * 根因还会让 revisionBoxState 判 idle、按钮解锁、再点得 409。
     *
     * 这层检查只负责给出可读的错误。真正的互斥由 revision_tasks_active_job_idx
     * 保证——「先查后写」在多实例下不成立,两个进程能在彼此的查与写之间穿插。
     */
    const pending = this.database
      .prepare("SELECT id FROM revision_tasks WHERE job_id=? AND status IN ('queued','running')")
      .get(jobId) as { id: string } | undefined;
    if (pending) throw new ConflictException(REVISION_IN_PROGRESS);

    const id = randomUUID();
    const now = nowIso();
    try {
      this.database
        .prepare(
          `INSERT INTO revision_tasks
             (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
              rerun_channels_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, '[]', ?, ?, ?)`,
        )
        .run(id, jobId, packageId, candidateId, trimmed.slice(0, 2_000), principal.userId, now, now);
    } catch (error) {
      // 索引被踩到说明另一个实例刚插进去了。对用户而言这与上面那次 pending 命中
      // 是同一件事,给同样的 409;让 SQLite 的约束错误冒成 500 只会让人以为服务坏了。
      if (isUniqueViolation(error)) throw new ConflictException(REVISION_IN_PROGRESS);
      throw error;
    }
    return this.taskView(id);
  }

  /**
   * 未终态的修改任务;没有则 undefined。
   *
   * 一个 job 最多只有一条(revision_tasks_active_job_idx 保证),所以「最近一条」与
   * 「那一条」是同一件事。ORDER BY + LIMIT 1 保留着:它让这个方法在索引被误改回包级时
   * 仍然返回单条而不是抛错,但那时投影会漏掉并发的另一条——所以真正的防线是那个索引,
   * 迁移测试锁着它建在 job_id 上。
   */
  activeFor(jobId: string): RevisionTaskView | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM revision_tasks
          WHERE job_id=? AND status IN ('queued','running')
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(jobId) as RevisionRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * 最近一条修改任务,不论状态。
   *
   * 与 activeFor 并存是因为前端要能显示「上一次修改失败了」——只给活跃任务的话,
   * 失败后前端立刻失去线索,用户不知道刚才那次到底怎么了。
   */
  latestFor(jobId: string): RevisionTaskView | undefined {
    const row = this.database
      .prepare('SELECT * FROM revision_tasks WHERE job_id=? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(jobId) as RevisionRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  taskView(id: string): RevisionTaskView {
    const row = this.database.prepare('SELECT * FROM revision_tasks WHERE id=?').get(id) as RevisionRow | undefined;
    if (!row) throw new NotFoundException('修改任务不存在');
    return this.mapRow(row);
  }

  /** 供执行阶段读取任务行(含 package_id,它不进对外投影)。 */
  row(id: string): RevisionRow | undefined {
    return this.database.prepare('SELECT * FROM revision_tasks WHERE id=?').get(id) as RevisionRow | undefined;
  }

  private resolvePackageId(jobId: string, candidateId: string): string | undefined {
    const rows = this.database
      .prepare('SELECT id, content_json FROM content_packages WHERE job_id=? ORDER BY candidate_index')
      .all(jobId) as { id: string; content_json: string }[];
    for (const row of rows) {
      const content = parseJson<ContentPackage | null>(row.content_json, null);
      if (content?.candidateId === candidateId || content?.id === candidateId || row.id === candidateId) {
        return row.id;
      }
    }
    return undefined;
  }

  private mapRow(row: RevisionRow): RevisionTaskView {
    return {
      id: row.id,
      jobId: row.job_id,
      candidateId: row.candidate_id,
      instruction: row.instruction,
      status: row.status as RevisionTaskView['status'],
      progress: row.progress,
      attemptCount: row.attempt_count,
      error: row.error,
      rerunChannels: parseJson<string[]>(row.rerun_channels_json, []),
      resultPackageId: row.result_package_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}

/** 终态判定,给调用方复用,避免各处重写字符串集合。 */
export function isRevisionSettled(status: string): boolean {
  return TERMINAL.has(status);
}

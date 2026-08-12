import { statfsSync } from 'node:fs';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import {
  DEFAULT_FORMULA_VERSION,
  FORMULA_EXECUTION_POLICY_VERSION,
} from '@content-agent/agent-core';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { DatabaseService } from './database.service.js';
import { nowIso } from './utils.js';

/** 磁盘余量低于此值时 status 降级为 degraded（仍可服务,但监控该叫人了）。 */
const DISK_FREE_DEGRADED_BYTES = 1_073_741_824; // 1 GiB

@Controller()
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
  ) {}

  /**
   * 真探活,不是版本名片。
   *
   * 此前只返回静态常量:磁盘满(SQLITE_FULL)、库文件损坏时照样报 ok,故障
   * 发现全靠用户报障。现在:
   * - 数据库**写**探测(单行 upsert):不可写返回 503,外部 uptime 监控按
   *   非 200 直接告警;
   * - 队列深度与磁盘余量随响应带出,余量 <1GiB 时 status 降级 degraded
   *   (仍 200——服务还能跑,但值班的人该处理了);
   * - 版本仍取运行时常量,UI 侧栏与监控共用这一份自报。
   */
  @Get('health')
  health() {
    let databaseWritable = true;
    let databaseError: string | undefined;
    try {
      this.database
        .prepare(
          `INSERT INTO health_probe (id, checked_at) VALUES (1, ?)
             ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at`,
        )
        .run(nowIso());
    } catch (error) {
      databaseWritable = false;
      databaseError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }

    let queuedJobs = -1;
    let runningJobs = -1;
    if (databaseWritable) {
      queuedJobs = Number((this.database
        .prepare("SELECT COUNT(*) AS value FROM generation_jobs WHERE status='queued' AND deleted_at IS NULL")
        .get() as { value: number }).value);
      runningJobs = Number((this.database
        .prepare("SELECT COUNT(*) AS value FROM generation_jobs WHERE status='running' AND deleted_at IS NULL")
        .get() as { value: number }).value);
    }

    let diskFreeBytes = -1;
    try {
      const stats = statfsSync(this.options.dataDir);
      diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // 数据目录都读不到属于数据库探测的失败域,这里不重复报。
    }

    const degraded = diskFreeBytes >= 0 && diskFreeBytes < DISK_FREE_DEGRADED_BYTES;
    const payload = {
      status: databaseWritable ? (degraded ? 'degraded' : 'ok') : 'unavailable',
      service: 'content-agent-api',
      coreVersion: DEFAULT_FORMULA_VERSION.version,
      executionPolicyVersion: FORMULA_EXECUTION_POLICY_VERSION,
      databaseWritable,
      ...(databaseError ? { databaseError } : {}),
      queuedJobs,
      runningJobs,
      diskFreeBytes,
    };
    if (!databaseWritable) throw new ServiceUnavailableException(payload);
    return payload;
  }
}

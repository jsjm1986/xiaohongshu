import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { SettingsService } from '../src/settings.service.js';

/**
 * 分析失败后的额度与报错。
 *
 * 起因是端到端实测:真 saas 账号点「分析知识库」,中继返回 HTTP 500,三次重试全败,
 * 界面上只有一句「Internal server error」——而额度已经从 0 扣到 2。用户什么都没拿到
 * 却少了两次,而且完全不知道发生了什么、要不要重试。
 *
 * 这里锁两件事:
 *  1. 额度退还是真的会把计数减回去,且有 0 下限保护(并发重复退不能打成负数)
 *  2. BYOK 工作区不参与平台配额,退还对它是空操作
 *
 * 报错话术的分类在 analysis-failure-message.test.ts 里单独锁(纯函数,不需要起服务)。
 */

let app: NestExpressApplication;
let dataDir = '';

const PASSWORD = 'Refund-bootstrap-123!';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-refund-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key', logger: false,
  });
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

// workspace_settings 是懒建的(SettingsService.ensure 首次读时插入),所以直接从
// workspaces 表取 id 再 ensure 一次,而不是假设设置行已存在。
function workspaceId(): string {
  const db = app.get(DatabaseService);
  const ws = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  app.get(SettingsService).ensure(ws.id);
  return ws.id;
}

function setQuota(mode: string, monthly: number, used: number): string {
  const db = app.get(DatabaseService);
  const ws = workspaceId();
  db.prepare('UPDATE workspace_settings SET provider_mode=?, monthly_quota=?, quota_used=? WHERE workspace_id=?')
    .run(mode, monthly, used, ws);
  return ws;
}

function usedCount(ws: string): number {
  const db = app.get(DatabaseService);
  return Number((db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(ws) as { quota_used: number }).quota_used);
}

test('平台模式:扣一次再退一次,计数回到原点', () => {
  const settings = app.get(SettingsService);
  const ws = setQuota('platform', 100, 5);
  settings.consumePlatformQuota(ws);
  assert.equal(usedCount(ws), 6, '扣费后 +1');
  settings.refundPlatformQuota(ws);
  assert.equal(usedCount(ws), 5, '退还后回到原点');
});

// 并发下可能重复退还;计数被打成负数会让「剩余」算出比配额更大的值
test('退还有 0 下限,不会把计数打成负数', () => {
  const settings = app.get(SettingsService);
  const ws = setQuota('platform', 100, 0);
  settings.refundPlatformQuota(ws);
  settings.refundPlatformQuota(ws);
  assert.equal(usedCount(ws), 0);
});

test('BYOK 工作区不参与平台配额,退还是空操作', () => {
  const settings = app.get(SettingsService);
  const ws = setQuota('byok', 100, 7);
  settings.refundPlatformQuota(ws);
  assert.equal(usedCount(ws), 7, 'BYOK 不该被改动');
});

// 额度用尽时 consume 会抛 403,此时**没有扣成功**,不该再退——否则用户会白得一次
test('额度用尽时扣费抛错且计数不变(没扣就没有可退的)', () => {
  const settings = app.get(SettingsService);
  const ws = setQuota('platform', 10, 10);
  assert.throws(() => settings.consumePlatformQuota(ws), /额度已用完/);
  assert.equal(usedCount(ws), 10);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ApiOptions } from '../src/config.js';
import { DatabaseService } from '../src/database.service.js';
import { SettingsService } from '../src/settings.service.js';

/**
 * master key 轮换。此前换钥等于所有 BYOK 密文永久报废(GCM 认证失败),
 * 唯一出路是逐个通知客户重新录入。现在:解密带旧钥回退链,加密永远用当前钥,
 * reencryptWorkspaceKey 完成存量迁移,迁移后可移除旧钥。
 */

const KEY_A = 'rotation-test-old-master-key-aaaa';
const KEY_B = 'rotation-test-new-master-key-bbbb';

function makeDb(): DatabaseService {
  const dir = mkdtempSync(join(tmpdir(), 'rotate-test-'));
  return new DatabaseService({
    dataDir: dir,
    databasePath: join(dir, 'test.db'),
    adminUsername: 'admin',
    adminPassword: 'Admin-change-me-2026!',
    sessionTtlMs: 3_600_000,
  } as unknown as ApiOptions);
}

function makeSettings(db: DatabaseService, masterKey: string, previous: string[] = []): SettingsService {
  const audit = { record: () => undefined } as never;
  return new SettingsService(db, {
    masterEncryptionKey: masterKey,
    previousMasterEncryptionKeys: previous,
    platformApiKey: '',
    platformBaseUrl: 'https://api.openai.com/v1',
    platformModel: 'test-model',
    platformTransport: 'responses',
  } as unknown as ApiOptions, audit);
}

function seedWorkspace(db: DatabaseService): { workspaceId: string; adminId: string } {
  // 直接构造的库没有引导管理员(那是 AuthService 的职责),插最小用户行。
  const now = new Date().toISOString();
  const adminId = randomUUID();
  db.prepare("INSERT INTO users (id, username, password_hash, system_role, created_at, updated_at) VALUES (?, ?, 'x', 'admin', ?, ?)")
    .run(adminId, `admin-${adminId.slice(0, 8)}`, now, now);
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workspaceId, `ws-${workspaceId.slice(0, 8)}`, '轮换测试', adminId, now, now);
  return { workspaceId, adminId };
}

test('旧钥密文在轮换期可解密，重加密后不再依赖旧钥', () => {
  const db = makeDb();
  const { workspaceId, adminId } = seedWorkspace(db);

  // 用钥 A 保存 BYOK(走真实 update 路径,确保密文形状与生产一致)
  const oldService = makeSettings(db, KEY_A);
  const admin = { userId: adminId, systemRole: 'admin' } as never;
  oldService.update(workspaceId, { providerMode: 'byok', provider: 'openai', apiKey: 'sk-rotation-secret', baseUrl: 'https://gateway.example.test/v1' }, admin);

  // 轮换:新钥 B 上任,A 进回退链 → 解密仍然成功
  const rotated = makeSettings(db, KEY_B, [KEY_A]);
  assert.equal(rotated.provider(workspaceId).apiKey, 'sk-rotation-secret', '轮换期旧钥密文必须可解');
  assert.equal(rotated.encryptedWithCurrentKey(
    String((db.prepare('SELECT encrypted_api_key FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as { encrypted_api_key: string }).encrypted_api_key),
  ), false);

  // 重加密收尾:迁移到钥 B,此后没有 A 也能解
  assert.equal(rotated.reencryptWorkspaceKey(workspaceId), true);
  assert.equal(rotated.reencryptWorkspaceKey(workspaceId), false, '幂等:已是当前钥时跳过');
  const afterRotation = makeSettings(db, KEY_B);
  assert.equal(afterRotation.provider(workspaceId).apiKey, 'sk-rotation-secret', '迁移后旧钥退役不影响解密');

  // 没有回退链时,旧钥密文必须失败(GCM 保证不会解出垃圾)——这正是轮换脚本
  // failed 分支要抓的状态
  const freshDb = makeDb();
  const fresh = seedWorkspace(freshDb);
  const freshAdmin = { userId: fresh.adminId, systemRole: 'admin' } as never;
  makeSettings(freshDb, KEY_A).update(fresh.workspaceId, { providerMode: 'byok', provider: 'openai', apiKey: 'sk-x', baseUrl: 'https://gateway.example.test/v1' }, freshAdmin);
  assert.throws(() => makeSettings(freshDb, KEY_B).provider(fresh.workspaceId));
});

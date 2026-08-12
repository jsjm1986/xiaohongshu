/**
 * BYOK 密钥重加密（master key 轮换收尾）。
 *
 * 使用时机:已把新钥写入 MASTER_ENCRYPTION_KEY、旧钥挪入
 * MASTER_ENCRYPTION_KEY_PREVIOUS(逗号分隔)并重启服务之后。本脚本把所有
 * 仍用旧钥加密的 BYOK 密文解开(解密走回退链)、用当前钥重新加密写回。
 * 跑完输出迁移计数;全部迁移后应从环境里移除 PREVIOUS,让旧钥彻底退役。
 *
 * 运行(在 content-agent 目录):
 *   npx tsx --tsconfig apps/api/tsconfig.json scripts/rotate-byok-keys.mts
 * 幂等:已是当前钥的行跳过,重复执行无害。生产在跑时也可执行(单条 UPDATE,
 * 与服务共享 SQLite 写锁,秒级)。
 */
import { createApplication } from '../apps/api/src/app.js';
import { DatabaseService } from '../apps/api/src/database.service.js';
import { SettingsService } from '../apps/api/src/settings.service.js';

const app = await createApplication({ logger: false });
try {
  const database = app.get(DatabaseService);
  const settings = app.get(SettingsService);
  const rows = database
    .prepare('SELECT workspace_id FROM workspace_settings WHERE encrypted_api_key IS NOT NULL')
    .all() as Array<{ workspace_id: string }>;
  let migrated = 0;
  let current = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try {
      if (settings.reencryptWorkspaceKey(row.workspace_id)) migrated += 1;
      else current += 1;
    } catch {
      // 新旧钥都解不开:密文在更早的轮换中失联,只能请该工作区重新录入。
      failed.push(row.workspace_id);
    }
  }
  console.log(`BYOK 重加密完成: 迁移 ${migrated} 个工作区, ${current} 个已是当前钥`);
  if (failed.length) {
    console.error(`以下工作区的密文用现有钥集无法解开,需要用户重新录入 BYOK: ${failed.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('可以从环境变量移除 MASTER_ENCRYPTION_KEY_PREVIOUS 了。');
  }
} finally {
  await app.close();
}

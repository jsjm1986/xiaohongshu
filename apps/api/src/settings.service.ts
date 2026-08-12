import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DEEPSEEK_MAX_OUTPUT_TOKENS, GENERATION_OUTPUT_TOKENS } from '@content-agent/agent-core';
import { APP_OPTIONS, isUsableMasterEncryptionKey, type ApiOptions } from './config.js';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import type { SessionPrincipal } from './models.js';
import { validateByokBaseUrl } from './safe-model-fetch.js';
import { QUOTA_EXHAUSTED_MESSAGE } from './support.js';
import { assertJsonComplexity, nowIso, parseJson, requireString } from './utils.js';

const MAX_API_KEY_LENGTH = 8_192;

/** 额度流水的归属上下文:每一笔扣退都要能回答「因为什么、落在哪个实体上」。 */
export interface QuotaLedgerContext {
  reason: string;
  entityType?: string;
  entityId?: string;
}
const MAX_MONTHLY_QUOTA = 1_000_000;

interface SettingsRow {
  workspace_id: string;
  provider_mode: 'platform' | 'byok';
  provider: string;
  model: string;
  base_url: string;
  transport: 'responses' | 'chat_completions';
  encrypted_api_key: string | null;
  monthly_quota: number;
  quota_used: number;
  default_temperature: number;
  config_json: string;
  updated_at: string;
}

export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = GENERATION_OUTPUT_TOKENS;
export { DEEPSEEK_MAX_OUTPUT_TOKENS };

/**
 * Output capability is separate from the normal per-stage budget. It is used
 * only for the client's single controlled retry after an explicit length stop.
 */
export function modelOutputTokenLimit(
  settings: Pick<ResolvedProviderSettings, 'provider' | 'model' | 'baseUrl'>,
): number {
  const identity = `${settings.provider} ${settings.model} ${settings.baseUrl}`.toLowerCase();
  return identity.includes('deepseek')
    ? DEEPSEEK_MAX_OUTPUT_TOKENS
    : DEFAULT_MODEL_MAX_OUTPUT_TOKENS;
}

export interface ResolvedProviderSettings {
  mode: 'platform' | 'byok';
  provider: string;
  model: string;
  baseUrl: string;
  transport: 'responses' | 'chat_completions';
  apiKey: string;
  temperature: number;
  /** Immutable settings row version used to detect queue-time configuration drift. */
  configVersion: string;
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  ensure(workspaceId: string, userId?: string): SettingsRow {
    const found = this.row(workspaceId);
    if (found) return found;
    const now = nowIso();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO workspace_settings
          (workspace_id, provider_mode, provider, model, base_url, transport,
           monthly_quota, quota_used, default_temperature, updated_by, updated_at)
         VALUES (?, 'platform', 'openai', ?, ?, ?, 100, 0, 0.8, ?, ?)`,
      )
      .run(workspaceId, this.options.platformModel, this.options.platformBaseUrl, this.options.platformTransport, userId ?? null, now);
    const created = this.row(workspaceId);
    if (!created) throw new Error('工作区设置初始化失败');
    return created;
  }

  publicSettings(workspaceId: string, userId?: string): Record<string, unknown> {
    const row = this.ensure(workspaceId, userId);
    const byok = row.provider_mode === 'byok';
    return {
      workspaceId,
      providerMode: row.provider_mode,
      provider: row.provider,
      model: row.model || this.options.platformModel,
      apiBaseUrl: byok ? row.base_url : this.options.platformBaseUrl,
      transport: byok ? row.transport : this.options.platformTransport,
      hasApiKey: byok ? Boolean(row.encrypted_api_key) : Boolean(this.options.platformApiKey),
      monthlyQuota: row.monthly_quota,
      quotaUsed: row.quota_used,
      defaultTemperature: row.default_temperature,
      generationDefaults: parseJson(row.config_json, {}),
    };
  }

  /**
   * 额度快照(只读)。供极简创作(SaaS)在界面上显示余量用。
   *
   * 刻意不复用 publicSettings:那个方法会连带返回 apiBaseUrl、model、transport、
   * generationDefaults 等基础设施细节,租户没有理由看到。这里只给额度三件套,
   * 字段集由 settings-quota.test.ts 逐键锁死。
   */
  quotaSnapshot(workspaceId: string, userId?: string): Record<string, unknown> {
    const row = this.ensure(workspaceId, userId);
    return {
      workspaceId,
      providerMode: row.provider_mode,
      monthlyQuota: row.monthly_quota,
      quotaUsed: row.quota_used,
      // 不为负:配额被下调到低于既有用量时,余量是 0 而不是负数
      remaining: Math.max(0, row.monthly_quota - row.quota_used),
    };
  }

  update(workspaceId: string, body: Record<string, unknown>, principal: SessionPrincipal): Record<string, unknown> {
    return this.database.transaction(() => {
    const current = this.ensure(workspaceId, principal.userId);
    let providerMode = current.provider_mode;
    if (Object.hasOwn(body, 'providerMode')) {
      if (body.providerMode !== 'platform' && body.providerMode !== 'byok') {
        throw new BadRequestException('providerMode 必须是 platform 或 byok');
      }
      providerMode = body.providerMode;
    }
    const provider = Object.hasOwn(body, 'provider')
      ? requireString(body.provider, 'provider', { max: 64 })
      : current.provider;
    const model = Object.hasOwn(body, 'model')
      ? requireString(body.model, 'model', { max: 128 })
      : current.model;
    const baseUrl = Object.hasOwn(body, 'apiBaseUrl')
      ? this.validateBaseUrl(requireString(body.apiBaseUrl, 'apiBaseUrl', { max: 2_000 }))
      : current.base_url;
    let transport = current.transport;
    if (Object.hasOwn(body, 'transport')) {
      if (body.transport !== 'responses' && body.transport !== 'chat_completions') {
        throw new BadRequestException('transport 必须是 responses 或 chat_completions');
      }
      transport = body.transport;
    }
    let temperature = current.default_temperature;
    if (Object.hasOwn(body, 'defaultTemperature')) {
      if (typeof body.defaultTemperature !== 'number' || !Number.isFinite(body.defaultTemperature)
        || body.defaultTemperature < 0 || body.defaultTemperature > 2) {
        throw new BadRequestException('defaultTemperature 必须是 0-2 之间的有限数值');
      }
      temperature = body.defaultTemperature;
    }
    let monthlyQuota = current.monthly_quota;
    if (Object.hasOwn(body, 'monthlyQuota')) {
      if (typeof body.monthlyQuota !== 'number' || !Number.isSafeInteger(body.monthlyQuota)
        || body.monthlyQuota < 0 || body.monthlyQuota > MAX_MONTHLY_QUOTA) {
        throw new BadRequestException(`monthlyQuota 必须是 0-${MAX_MONTHLY_QUOTA} 之间的安全整数`);
      }
      monthlyQuota = body.monthlyQuota;
    }
    let generationDefaults: Record<string, unknown> = parseJson(current.config_json, {});
    if (Object.hasOwn(body, 'generationDefaults')) {
      if (!body.generationDefaults || typeof body.generationDefaults !== 'object' || Array.isArray(body.generationDefaults)) {
        throw new BadRequestException('generationDefaults 必须是 JSON 对象');
      }
      assertJsonComplexity(body.generationDefaults, 'generationDefaults');
      generationDefaults = body.generationDefaults as Record<string, unknown>;
    }
    if (Object.hasOwn(body, 'clearApiKey') && typeof body.clearApiKey !== 'boolean') {
      throw new BadRequestException('clearApiKey 必须是布尔值');
    }
    if (body.clearApiKey === true && typeof body.apiKey === 'string' && body.apiKey.trim()) {
      throw new BadRequestException('apiKey 与 clearApiKey 不能同时提交');
    }
    let encryptedKey = current.encrypted_api_key;
    if (Object.hasOwn(body, 'apiKey')) {
      const apiKey = requireString(body.apiKey, 'apiKey', { max: MAX_API_KEY_LENGTH });
      encryptedKey = this.encrypt(apiKey);
    }
    if (body.clearApiKey === true) {
      encryptedKey = null;
      providerMode = 'platform';
    }
    if (providerMode === 'byok' && !encryptedKey) throw new BadRequestException('BYOK 模式必须先保存 API Key');
    if (providerMode === 'byok') this.validateBaseUrl(baseUrl);

    const updated = this.database
      .prepare(
        `UPDATE workspace_settings SET provider_mode = ?, provider = ?, model = ?, base_url = ?,
          transport = ?, encrypted_api_key = ?, monthly_quota = ?, default_temperature = ?,
          config_json = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ?`,
      )
      .run(providerMode, provider, model, baseUrl, transport, encryptedKey, monthlyQuota, temperature, JSON.stringify(generationDefaults), principal.userId, nowIso(), workspaceId);
    if (Number(updated.changes) !== 1) throw new BadRequestException('工作区设置不存在');
    this.audit.record({ workspaceId, userId: principal.userId, action: 'settings.update', entityType: 'workspace', entityId: workspaceId, details: { providerMode, provider, model, transport, monthlyQuota, apiKeyChanged: typeof body.apiKey === 'string' || body.clearApiKey === true } });
    return this.publicSettings(workspaceId, principal.userId);
    });
  }

  provider(workspaceId: string, userId?: string): ResolvedProviderSettings {
    const row = this.ensure(workspaceId, userId);
    const byok = row.provider_mode === 'byok';
    return {
      mode: row.provider_mode,
      provider: row.provider,
      model: row.model || this.options.platformModel,
      baseUrl: byok ? this.validateBaseUrl(row.base_url) : this.options.platformBaseUrl,
      transport: byok ? row.transport : this.options.platformTransport,
      apiKey: byok ? (row.encrypted_api_key ? this.decrypt(row.encrypted_api_key) : '') : this.options.platformApiKey,
      temperature: row.default_temperature,
      // quota_used updates also touch updated_at, so timestamps cannot identify the
      // provider contract. Hash only execution-affecting values (including a hash of
      // the effective secret) so quota accounting never creates false config drift.
      configVersion: createHash('sha256').update(JSON.stringify({
        mode: row.provider_mode, provider: row.provider, model: row.model || this.options.platformModel,
        baseUrl: byok ? row.base_url : this.options.platformBaseUrl,
        transport: byok ? row.transport : this.options.platformTransport,
        temperature: row.default_temperature,
        keyDigest: createHash('sha256').update(byok ? (row.encrypted_api_key ?? '') : this.options.platformApiKey).digest('hex'),
      })).digest('hex'),
    };
  }

  /**
   * 扣一次额度。
   *
   * 检查与自增必须在同一条语句里。原来是 check-then-write:SELECT 读 quota_used →
   * JS 比较 → UPDATE +1,而调用点在事务外。多实例下两个请求可以都读到 99(上限
   * 100)、都通过检查、都 +1 变成 101 —— 按次计费的产品这是实质性超发。
   * (单实例不会:这条路径全程同步,Node 事件循环内不被抢占。)
   *
   * 下推进 SQL 之后,「不超额」由 DB 保证:UPDATE 的 WHERE 与自增原子生效,
   * changes===0 就是「已到上限」。
   */
  consumePlatformQuota(workspaceId: string, context?: QuotaLedgerContext): void {
    const row = this.ensure(workspaceId);
    if (row.provider_mode !== 'platform') return;
    const result = this.database
      .prepare(
        `UPDATE workspace_settings SET quota_used = quota_used + 1, updated_at = ?
          WHERE workspace_id = ? AND quota_used < monthly_quota`,
      )
      .run(nowIso(), workspaceId);
    // 话术见 support.ts:「联系管理员 / 配置 BYOK」对付费 SaaS 用户是两条走不通的路
    if (!result.changes) throw new ForbiddenException(QUOTA_EXHAUSTED_MESSAGE);
    this.recordQuotaLedger(workspaceId, 1, context ?? { reason: 'consume' });
  }

  /**
   * 原子退还额度。
   *
   * 额度是在调用模型**之前**扣的(必须如此:先扣才防得住并发超额)。但实测知识库
   * 分析在中继返回 HTTP 500 时,三次重试全败、任务标 failed,而额度已经扣掉——
   * 用户什么都没拿到却少了一次。对按次计费的产品这是实质性的错账。
   *
   * 只在「确认没有产出任何结果」的失败路径上退。一次 SQL 支持退还多次并把下限
   * 保护到 0:调用方可以把它嵌在任务终态事务里,不会留下「任务账已归零、工作区
   * 额度还没退」的崩溃窗口。这里也不按当前 provider_mode 过滤:任务可能在 platform
   * 模式扣款后才切到 BYOK,历史扣款仍然必须退。
   */
  refundPlatformQuota(workspaceId: string, count = 1, context?: QuotaLedgerContext): void {
    const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (!normalizedCount) return;
    // 先读变动前的用量:MAX(0,…) 下限保护意味着实际退还可能小于请求数,
    // 账本必须记真实发生额而不是请求额。读与写在调用方的同一事务里,无竞态。
    const before = this.database
      .prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id = ?')
      .get(workspaceId) as { quota_used: number } | undefined;
    const result = this.database
      .prepare('UPDATE workspace_settings SET quota_used = MAX(0, quota_used - ?), updated_at = ? WHERE workspace_id = ?')
      .run(normalizedCount, nowIso(), workspaceId);
    // 有扣款账却没有 settings 行属于数据损坏。抛错让调用方的外层事务整体回滚,
    // 不能把任务账先清掉、把用户应退额度静默丢掉。
    if (!result.changes || !before) throw new Error('工作区额度设置不存在，无法退还额度');
    const actualRefund = Math.min(normalizedCount, Number(before.quota_used));
    if (actualRefund > 0) {
      this.recordQuotaLedger(workspaceId, -actualRefund, context ?? { reason: 'refund' });
    }
  }

  /**
   * 平台额度逐笔流水,与扣退款同事务写入。
   *
   * quota_used 单计数器保证「账不会错」,流水保证「账能自证」:客户质疑
   * 「这个月为什么扣了 87 次」时,每一笔都能归属到具体任务/事件与时间点。
   * delta 为 quota_used 的实际变化(+消耗/−退还),balance_after 是变动后
   * 快照——两者联立可机器校验流水与计数器不漂移。
   */
  private recordQuotaLedger(workspaceId: string, delta: number, context: QuotaLedgerContext): void {
    const row = this.database
      .prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id = ?')
      .get(workspaceId) as { quota_used: number };
    this.database
      .prepare(
        `INSERT INTO quota_ledger (workspace_id, delta, balance_after, reason, entity_type, entity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId, delta, Number(row.quota_used), context.reason,
        context.entityType ?? null, context.entityId ?? null, nowIso(),
      );
  }

  /**
   * 月度对账:流水明细 + 汇总。month 形如 YYYY-MM,缺省为全部。
   * 只读,不做任何清零——「月度」是记账分桶语义,不是额度重置语义。
   */
  quotaLedger(workspaceId: string, month?: string, limit = 500): Record<string, unknown> {
    const monthFilter = month && /^\d{4}-\d{2}$/u.test(month) ? month : undefined;
    const items = this.database
      .prepare(
        `SELECT id, delta, balance_after AS balanceAfter, reason, entity_type AS entityType,
                entity_id AS entityId, created_at AS createdAt
           FROM quota_ledger
          WHERE workspace_id = ? AND (? IS NULL OR substr(created_at, 1, 7) = ?)
          ORDER BY id DESC LIMIT ?`,
      )
      .all(workspaceId, monthFilter ?? null, monthFilter ?? null, Math.min(Math.max(1, limit), 1000));
    const summary = this.database
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS consumed,
                COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS refunded
           FROM quota_ledger
          WHERE workspace_id = ? AND (? IS NULL OR substr(created_at, 1, 7) = ?)`,
      )
      .get(workspaceId, monthFilter ?? null, monthFilter ?? null) as { consumed: number; refunded: number };
    return {
      month: monthFilter ?? null,
      consumed: Number(summary.consumed),
      refunded: Number(summary.refunded),
      net: Number(summary.consumed) - Number(summary.refunded),
      items,
    };
  }

  workspaceConfig(workspaceId: string): Record<string, unknown> {
    return parseJson(this.ensure(workspaceId).config_json, {});
  }

  projectConfig(projectId: string): Record<string, unknown> {
    const row = this.database.prepare('SELECT config_json FROM project_settings WHERE project_id = ?').get(projectId) as { config_json: string } | undefined;
    return parseJson(row?.config_json, {});
  }

  saveProjectConfig(projectId: string, config: Record<string, unknown>, userId: string): void {
    this.database
      .prepare(
        `INSERT INTO project_settings (project_id, config_json, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET config_json=excluded.config_json,
           updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(projectId, JSON.stringify(config), userId, nowIso());
  }

  private row(workspaceId: string): SettingsRow | undefined {
    return this.database.prepare('SELECT * FROM workspace_settings WHERE workspace_id = ?').get(workspaceId) as unknown as SettingsRow | undefined;
  }

  private validateBaseUrl(value: string): string {
    try {
      return validateByokBaseUrl(value, {
        allowHttp: this.options.byokAllowHttp,
        allowPrivateNetwork: this.options.byokAllowPrivateNetwork,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'API Base URL 无效');
    }
  }

  private key(): Buffer {
    if (!isUsableMasterEncryptionKey(this.options.masterEncryptionKey)) {
      throw new BadRequestException('保存 BYOK 前必须配置至少 16 字符且非示例值的 MASTER_ENCRYPTION_KEY');
    }
    return createHash('sha256').update(this.options.masterEncryptionKey).digest();
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') });
  }

  /**
   * 解密带轮换回退:先试当前 master key,再逐个尝试 MASTER_ENCRYPTION_KEY_PREVIOUS
   * 里的旧钥(GCM 认证标签保证错钥必然抛错,不会解出垃圾)。
   *
   * 此前换 master key 等于所有 BYOK 密钥永久报废——唯一出路是逐个通知客户
   * 重新录入,等于对外承认安全事故。轮换流程:新钥写 MASTER_ENCRYPTION_KEY、
   * 旧钥挪进 PREVIOUS → 重启 → 跑 scripts/rotate-byok-keys.mts 重加密存量 →
   * 移除 PREVIOUS。加密永远只用当前钥。
   */
  private decrypt(value: string): string {
    const payload = JSON.parse(value) as { iv: string; tag: string; data: string };
    const candidates = [this.key(), ...this.options.previousMasterEncryptionKeys.map((key) => createHash('sha256').update(key).digest())];
    let lastError: unknown;
    for (const key of candidates) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64url')), decipher.final()]).toString('utf8');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** 是否需要用当前钥重加密(被旧钥解开的密文)。轮换脚本用它挑出待迁移行。 */
  encryptedWithCurrentKey(value: string): boolean {
    const payload = JSON.parse(value) as { iv: string; tag: string; data: string };
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(payload.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
      decipher.update(Buffer.from(payload.data, 'base64url'));
      decipher.final();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 用当前 master key 重加密一行 BYOK 密文(轮换收尾)。
   * 解密走回退链,加密只用当前钥;调用方(轮换脚本)负责遍历与审计输出。
   */
  reencryptWorkspaceKey(workspaceId: string): boolean {
    const row = this.database
      .prepare('SELECT encrypted_api_key FROM workspace_settings WHERE workspace_id = ?')
      .get(workspaceId) as { encrypted_api_key: string | null } | undefined;
    if (!row?.encrypted_api_key) return false;
    if (this.encryptedWithCurrentKey(row.encrypted_api_key)) return false;
    const plain = this.decrypt(row.encrypted_api_key);
    this.database
      .prepare('UPDATE workspace_settings SET encrypted_api_key = ?, updated_at = ? WHERE workspace_id = ?')
      .run(this.encrypt(plain), nowIso(), workspaceId);
    return true;
  }
}

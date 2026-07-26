import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import type { SessionPrincipal } from './models.js';
import { QUOTA_EXHAUSTED_MESSAGE } from './support.js';
import { nowIso, parseJson } from './utils.js';

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

export interface ResolvedProviderSettings {
  mode: 'platform' | 'byok';
  provider: string;
  model: string;
  baseUrl: string;
  transport: 'responses' | 'chat_completions';
  apiKey: string;
  temperature: number;
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
        `INSERT INTO workspace_settings
          (workspace_id, provider_mode, provider, model, base_url, transport,
           monthly_quota, quota_used, default_temperature, updated_by, updated_at)
         VALUES (?, 'platform', 'openai', ?, ?, ?, 100, 0, 0.8, ?, ?)`,
      )
      .run(workspaceId, this.options.platformModel, this.options.platformBaseUrl, this.options.platformTransport, userId ?? null, now);
    return this.row(workspaceId)!;
  }

  publicSettings(workspaceId: string, userId?: string): Record<string, unknown> {
    const row = this.ensure(workspaceId, userId);
    return {
      workspaceId,
      providerMode: row.provider_mode,
      provider: row.provider,
      model: row.model || this.options.platformModel,
      apiBaseUrl: row.base_url || this.options.platformBaseUrl,
      transport: row.transport,
      hasApiKey: row.provider_mode === 'platform' ? Boolean(this.options.platformApiKey) : Boolean(row.encrypted_api_key),
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
    const current = this.ensure(workspaceId, principal.userId);
    const providerMode = body.providerMode === 'byok' ? 'byok' : body.providerMode === 'platform' ? 'platform' : current.provider_mode;
    const provider = typeof body.provider === 'string' ? body.provider.slice(0, 64) : current.provider;
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 128) : current.model;
    const baseUrl = typeof body.apiBaseUrl === 'string' && body.apiBaseUrl.trim() ? this.validateBaseUrl(body.apiBaseUrl) : current.base_url;
    const transport = body.transport === 'chat_completions' ? 'chat_completions' : body.transport === 'responses' ? 'responses' : current.transport;
    const temperature = typeof body.defaultTemperature === 'number'
      ? Math.max(0, Math.min(2, body.defaultTemperature))
      : current.default_temperature;
    const monthlyQuota = typeof body.monthlyQuota === 'number'
      ? Math.max(0, Math.floor(body.monthlyQuota))
      : current.monthly_quota;
    const generationDefaults = body.generationDefaults && typeof body.generationDefaults === 'object'
      ? body.generationDefaults
      : parseJson(current.config_json, {});
    let encryptedKey = current.encrypted_api_key;
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) encryptedKey = this.encrypt(body.apiKey.trim());
    if (body.clearApiKey === true) encryptedKey = null;
    if (providerMode === 'byok' && !encryptedKey) throw new BadRequestException('BYOK 模式必须先保存 API Key');

    this.database
      .prepare(
        `UPDATE workspace_settings SET provider_mode = ?, provider = ?, model = ?, base_url = ?,
          transport = ?, encrypted_api_key = ?, monthly_quota = ?, default_temperature = ?,
          config_json = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ?`,
      )
      .run(providerMode, provider, model, baseUrl, transport, encryptedKey, monthlyQuota, temperature, JSON.stringify(generationDefaults), principal.userId, nowIso(), workspaceId);
    this.audit.record({ workspaceId, userId: principal.userId, action: 'settings.update', entityType: 'workspace', entityId: workspaceId, details: { providerMode, provider, model, transport, monthlyQuota, apiKeyChanged: typeof body.apiKey === 'string' || body.clearApiKey === true } });
    return this.publicSettings(workspaceId, principal.userId);
  }

  provider(workspaceId: string, userId?: string): ResolvedProviderSettings {
    const row = this.ensure(workspaceId, userId);
    const byok = row.provider_mode === 'byok';
    return {
      mode: row.provider_mode,
      provider: row.provider,
      model: row.model || this.options.platformModel,
      baseUrl: row.base_url || this.options.platformBaseUrl,
      transport: row.transport,
      apiKey: byok ? (row.encrypted_api_key ? this.decrypt(row.encrypted_api_key) : '') : this.options.platformApiKey,
      temperature: row.default_temperature,
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
  consumePlatformQuota(workspaceId: string): void {
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
  }

  /**
   * 退还一次额度。
   *
   * 额度是在调用模型**之前**扣的(必须如此:先扣才防得住并发超额)。但实测知识库
   * 分析在中继返回 HTTP 500 时,三次重试全败、任务标 failed,而额度已经扣掉——
   * 用户什么都没拿到却少了一次。对按次计费的产品这是实质性的错账。
   *
   * 只在「确认没有产出任何结果」的失败路径上退。下限保护到 0:并发下重复退还
   * 不该把计数打成负数。
   */
  refundPlatformQuota(workspaceId: string): void {
    const row = this.ensure(workspaceId);
    if (row.provider_mode !== 'platform') return;
    if (row.quota_used <= 0) return;
    this.database
      .prepare('UPDATE workspace_settings SET quota_used = MAX(0, quota_used - 1), updated_at = ? WHERE workspace_id = ?')
      .run(nowIso(), workspaceId);
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
    let url: URL;
    try { url = new URL(value); } catch { throw new BadRequestException('API Base URL 无效'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('API Base URL 只支持 HTTP/HTTPS');
    return url.toString().replace(/\/$/u, '');
  }

  private key(): Buffer {
    if (this.options.masterEncryptionKey.length < 16) {
      throw new BadRequestException('保存 BYOK 前必须配置至少 16 字符的 MASTER_ENCRYPTION_KEY');
    }
    return createHash('sha256').update(this.options.masterEncryptionKey).digest();
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') });
  }

  private decrypt(value: string): string {
    const payload = JSON.parse(value) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(payload.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64url')), decipher.final()]).toString('utf8');
  }
}

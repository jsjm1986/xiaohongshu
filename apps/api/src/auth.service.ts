import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { DatabaseService } from './database.service.js';
import type { ApiKeyPrincipal, Permission, SessionPrincipal } from './models.js';
import { RateLimitService } from './rate-limit.service.js';
import { nowIso, parseJson, requireString, slugify } from './utils.js';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  system_role: 'admin' | 'user';
  user_kind: string;
  must_change_password: number;
  disabled_at: string | null;
}

const INSECURE_BOOTSTRAP_PASSWORDS = new Set([
  'change-me-now-123!',
  'replace-with-a-strong-password',
]);
const MAX_ACTIVE_SESSIONS_PER_USER = 10;
const USAGE_TOUCH_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
    @Inject(RateLimitService) private readonly rateLimits: RateLimitService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBootstrapAdmin();
    this.pruneExpiredSessions();
  }

  async hashPassword(password: string): Promise<string> {
    this.validatePassword(password);
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
  }

  async ensureBootstrapAdmin(): Promise<void> {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    if (Number(row.count) > 0) return;
    if (this.options.production && INSECURE_BOOTSTRAP_PASSWORDS.has(this.options.adminPassword)) {
      throw new Error('生产环境首次启动必须显式配置强 BOOTSTRAP_ADMIN_PASSWORD');
    }

    const username = requireString(this.options.adminUsername, '管理员用户名', { min: 3, max: 64 });
    const passwordHash = await this.hashPassword(this.options.adminPassword);
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const now = nowIso();
    this.database.transaction(() => {
      // 两个实例可同时完成上面的 Argon2 计算。拿到写锁后必须再检查一次，
      // 否则第二个实例会用同一默认用户名撞 UNIQUE 并启动失败。
      const current = this.database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
      if (Number(current.count) > 0) return;
      this.database
        .prepare(
          `INSERT INTO users
             (id, username, password_hash, system_role, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
        )
        .run(userId, username, passwordHash, now, now);
      this.database
        .prepare(
          `INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(workspaceId, 'default', '默认工作区', userId, now, now);
      this.database
        .prepare(
          `INSERT INTO workspace_members
             (workspace_id, user_id, role, created_at, updated_at)
           VALUES (?, ?, 'Owner', ?, ?)`,
        )
        .run(workspaceId, userId, now, now);
    });
  }

  provisionUserWithWorkspace(input: {
    username: string;
    passwordHash: string;
    systemRole: 'admin' | 'user';
    /**
     * 用户类型。刻意**必填、不给默认值**:这里原来根本不写 user_kind,于是落到列
     * 默认值 'research' —— 从 /register「申请开通」审批进来的付费客户全部被建成
     * 专家类用户,前端不拦(白名单只对 saas 生效)、后端 guard 也不拦(同理)。
     * 必填是为了让每个调用方明确表态,不会再有第二次"忘了写就默认成专家"。
     */
    userKind: 'research' | 'saas';
    mustChangePassword: boolean;
    workspaceName: string;
  }): { userId: string; workspaceId: string } {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const now = nowIso();
    const slug = this.uniqueWorkspaceSlug(input.workspaceName);
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO users
             (id, username, password_hash, system_role, user_kind, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, input.username, input.passwordHash, input.systemRole, input.userKind, input.mustChangePassword ? 1 : 0, now, now);
      this.database
        .prepare(
          `INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(workspaceId, slug, input.workspaceName, userId, now, now);
      this.database
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
           VALUES (?, ?, 'Owner', ?, ?)`,
        )
        .run(workspaceId, userId, now, now);
    });
    return { userId, workspaceId };
  }

  private uniqueWorkspaceSlug(base: string): string {
    let candidate = slugify(base) || 'workspace';
    let suffix = 2;
    while (this.database.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(candidate)) {
      candidate = `${(slugify(base) || 'workspace').slice(0, 56)}-${suffix++}`;
    }
    return candidate;
  }

  async login(usernameInput: unknown, passwordInput: unknown): Promise<{
    principal: SessionPrincipal;
    token: string;
    csrfToken: string;
    expiresAt: string;
  }> {
    const username = requireString(usernameInput, '用户名', { min: 3, max: 64 });
    if (typeof passwordInput !== 'string' || passwordInput.length === 0 || passwordInput.length > 256) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const user = this.database
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as unknown as UserRow | undefined;
    if (!user || user.disabled_at || !(await verify(user.password_hash, passwordInput))) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    const token = `cas_${randomBytes(32).toString('base64url')}`;
    const csrfToken = randomBytes(24).toString('base64url');
    const tokenHash = this.digest(token);
    const csrfHash = this.digest(csrfToken);
    const now = nowIso();
    const expiresAt = new Date(Date.now() + this.options.sessionTtlMs).toISOString();
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      // Keep nine existing sessions before inserting this one. BEGIN IMMEDIATE
      // serializes concurrent logins across API instances, so the cap is exact.
      this.database.prepare(
        `DELETE FROM sessions
          WHERE user_id=? AND token_hash IN (
            SELECT token_hash FROM sessions WHERE user_id=?
            ORDER BY created_at DESC, token_hash DESC LIMIT -1 OFFSET ?
          )`,
      ).run(user.id, user.id, MAX_ACTIVE_SESSIONS_PER_USER - 1);
      this.database
        .prepare(
          `INSERT INTO sessions
             (token_hash, user_id, csrf_hash, expires_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(tokenHash, user.id, csrfHash, expiresAt, now, now);
    });

    return {
      token,
      csrfToken,
      expiresAt,
      principal: {
        kind: 'session',
        userId: user.id,
        username: user.username,
        systemRole: user.system_role,
        userKind: user.user_kind === 'saas' ? 'saas' : 'research',
        mustChangePassword: Boolean(user.must_change_password),
        tokenHash,
        csrfHash,
      },
    };
  }

  /** 重置令牌尝试限速:64 字节随机数扛得住在线爆破,限速是纵深防御。 */
  consumeResetAttempt(sourceKey: string): void {
    this.rateLimits.consume('reset-token', sourceKey, {
      maxAttempts: 10,
      windowMs: 15 * 60_000,
      message: '尝试过多，请稍后重试',
    });
  }

  consumeLoginAttempt(sourceKey: string, usernameKey: string): void {
    // Bound credential stuffing across many usernames without creating a
    // username-global bucket that an attacker could use to lock out a victim.
    this.rateLimits.consume('login-source', sourceKey, {
      maxAttempts: 60,
      windowMs: 15 * 60_000,
      message: '登录尝试过多，请稍后重试',
    });
    this.rateLimits.consume('login-source-account', `${sourceKey}:${usernameKey}`, {
      maxAttempts: 5,
      windowMs: 15 * 60_000,
      message: '登录尝试过多，请稍后重试',
    });
  }

  clearLoginFailures(sourceKey: string, usernameKey: string): void {
    // Keep the source-wide budget: successful logins must not let a credential
    // stuffing client reset its allowance after every known-good account.
    this.rateLimits.clear('login-source-account', `${sourceKey}:${usernameKey}`);
  }

  primaryWorkspaceRole(userId: string): string | null {
    const row = this.database
      .prepare(
        `SELECT wm.role FROM workspace_members wm
         JOIN workspaces w ON w.id = wm.workspace_id
         WHERE wm.user_id = ? AND w.deleted_at IS NULL
         ORDER BY CASE wm.role WHEN 'Owner' THEN 1 WHEN 'Admin' THEN 2 WHEN 'KnowledgeEditor' THEN 3 WHEN 'ContentEditor' THEN 4 ELSE 5 END
         LIMIT 1`,
      )
      .get(userId) as { role: string } | undefined;
    return row?.role ?? null;
  }

  authenticateSession(token: string | undefined): SessionPrincipal {
    if (!token) throw new UnauthorizedException('请先登录');
    const row = this.database
      .prepare(
        `SELECT s.token_hash, s.csrf_hash, s.expires_at, s.last_seen_at,
                u.id AS user_id, u.username, u.system_role, u.user_kind, u.must_change_password, u.disabled_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(this.digest(token)) as
      | {
          token_hash: string;
          csrf_hash: string;
          expires_at: string;
          last_seen_at: string;
          user_id: string;
          username: string;
          system_role: 'admin' | 'user';
          user_kind: string;
          must_change_password: number;
          disabled_at: string | null;
        }
      | undefined;
    if (!row || row.disabled_at || Date.parse(row.expires_at) <= Date.now()) {
      if (row) this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      throw new UnauthorizedException('会话已失效，请重新登录');
    }
    if (Date.parse(row.last_seen_at) <= Date.now() - USAGE_TOUCH_INTERVAL_MS) {
      this.database
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at = ?')
        .run(nowIso(), row.token_hash, row.last_seen_at);
    }
    return {
      kind: 'session',
      userId: row.user_id,
      username: row.username,
      systemRole: row.system_role,
      userKind: row.user_kind === 'saas' ? 'saas' : 'research',
      mustChangePassword: Boolean(row.must_change_password),
      tokenHash: row.token_hash,
      csrfHash: row.csrf_hash,
    };
  }

  authenticateApiKey(secret: string | undefined): ApiKeyPrincipal {
    if (!secret?.startsWith('cak_')) throw new UnauthorizedException('API Key 无效');
    const row = this.database
      .prepare(
        `SELECT k.id, k.workspace_id, k.permissions_json, k.last_used_at FROM api_keys k
         JOIN workspaces w ON w.id = k.workspace_id
         WHERE k.secret_hash = ? AND k.revoked_at IS NULL AND w.deleted_at IS NULL`,
      )
      .get(this.digest(secret)) as
      | { id: string; workspace_id: string; permissions_json: string; last_used_at: string | null }
      | undefined;
    if (!row) throw new UnauthorizedException('API Key 无效');
    if (!row.last_used_at || Date.parse(row.last_used_at) <= Date.now() - USAGE_TOUCH_INTERVAL_MS) {
      this.database.prepare(
        'UPDATE api_keys SET last_used_at = ? WHERE id = ? AND last_used_at IS ?',
      ).run(nowIso(), row.id, row.last_used_at);
    }
    return {
      kind: 'apiKey',
      apiKeyId: row.id,
      workspaceId: row.workspace_id,
      permissions: parseJson<Permission[]>(row.permissions_json, []),
    };
  }

  validateCsrf(principal: SessionPrincipal, supplied: string | undefined): void {
    if (!supplied || !this.safeDigestEqual(principal.csrfHash, this.digest(supplied))) {
      throw new UnauthorizedException('CSRF 校验失败');
    }
  }

  logout(tokenHash: string): void {
    this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async changePassword(principal: SessionPrincipal, current: unknown, next: unknown): Promise<void> {
    if (typeof current !== 'string' || current.length === 0 || current.length > 256 || typeof next !== 'string') {
      throw new BadRequestException('当前密码和新密码不能为空');
    }
    const user = this.database.prepare('SELECT * FROM users WHERE id = ?').get(principal.userId) as unknown as UserRow;
    if (!(await verify(user.password_hash, current))) throw new UnauthorizedException('当前密码错误');
    const passwordHash = await this.hashPassword(next);
    this.database.transaction(() => {
      this.database
        .prepare(
          'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
        )
        .run(passwordHash, nowIso(), principal.userId);
      this.database
        .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
        .run(principal.userId, principal.tokenHash);
    });
  }

  /**
   * 生成一次性密码重置令牌(admin 代发,无邮件通道的最小自助重置)。
   * 明文只在本响应出现一次,库里只存 sha256;同用户旧的未用令牌一并作废,
   * 保证任意时刻最多一个有效链接。有效期 24 小时。
   */
  createPasswordResetToken(userId: string, createdBy: string): { token: string; expiresAt: string } {
    const user = this.database.prepare('SELECT id, disabled_at FROM users WHERE id = ?').get(userId) as { id: string; disabled_at: string | null } | undefined;
    if (!user) throw new NotFoundException('用户不存在');
    if (user.disabled_at) throw new BadRequestException('用户已停用，请先恢复账号');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = nowIso();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL').run(userId);
      this.database
        .prepare('INSERT INTO password_reset_tokens (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(tokenHash, userId, createdBy, now, expiresAt);
    });
    return { token, expiresAt };
  }

  /**
   * 凭一次性令牌自设新密码。成功即:令牌标记已用 + 该用户全部会话撤销
   * (改密语义与 changePassword 一致,但持链接者不需要旧密码)。
   * 失败一律同一句话,不区分「不存在/已用/过期」——错误差异会泄露令牌状态。
   */
  async resetPasswordWithToken(rawToken: unknown, rawPassword: unknown): Promise<void> {
    if (typeof rawToken !== 'string' || !rawToken || typeof rawPassword !== 'string') {
      throw new BadRequestException('重置链接无效或已过期');
    }
    if (rawPassword.length < 12 || rawPassword.length > 256) {
      throw new BadRequestException('新密码长度需在 12-256 字符之间');
    }
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const row = this.database
      .prepare('SELECT token_hash, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?')
      .get(tokenHash) as { token_hash: string; user_id: string; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || row.expires_at <= nowIso()) {
      throw new BadRequestException('重置链接无效或已过期');
    }
    const passwordHash = await this.hashPassword(rawPassword);
    const now = nowIso();
    this.database.transaction(() => {
      this.database
        .prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
        .run(passwordHash, now, row.user_id);
      this.database.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?').run(now, row.token_hash);
      this.database.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    });
  }

  async createUser(input: {
    username: unknown;
    password: unknown;
    systemRole?: unknown;
    userKind?: unknown;
  }, onCreated?: (user: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    const username = requireString(input.username, '用户名', {
      min: 3,
      max: 64,
      pattern: /^[^\s/\\]+$/u,
    });
    if (typeof input.password !== 'string') throw new BadRequestException('密码不能为空');
    const role = input.systemRole === 'admin' ? 'admin' : 'user';
    const userKind = input.userKind === 'saas' ? 'saas' : 'research';
    const id = randomUUID();
    const now = nowIso();
    const passwordHash = await this.hashPassword(input.password);
    const result = { id, username, systemRole: role, userKind, mustChangePassword: true, createdAt: now };
    try {
      return this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO users
               (id, username, password_hash, system_role, user_kind, must_change_password, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(id, username, passwordHash, role, userKind, now, now);
        onCreated?.(result);
        return result;
      });
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new ConflictException('用户名已存在');
      throw error;
    }
  }

  createApiKey(workspaceId: string, name: string, createdBy: string): Record<string, unknown> {
    const secret = `cak_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const now = nowIso();
    this.database
      .prepare(
        `INSERT INTO api_keys
           (id, workspace_id, name, key_prefix, secret_hash, permissions_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, '["api.read"]', ?, ?)`,
      )
      .run(id, workspaceId, name, secret.slice(0, 12), this.digest(secret), createdBy, now);
    return { id, name, key: secret, prefix: secret.slice(0, 12), createdAt: now };
  }

  private validatePassword(password: string): void {
    if (password.length < 12 || password.length > 256) {
      throw new BadRequestException('密码长度必须在 12-256 个字符之间');
    }
  }

  private pruneExpiredSessions(): void {
    this.database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  }

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private safeDigestEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

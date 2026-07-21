import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { DatabaseService } from './database.service.js';
import type { ApiKeyPrincipal, Permission, SessionPrincipal } from './models.js';
import { nowIso, parseJson, requireString, slugify } from './utils.js';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  system_role: 'admin' | 'user';
  must_change_password: number;
  disabled_at: string | null;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly loginFailures = new Map<string, { count: number; resetAt: number }>();
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
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

    const username = requireString(this.options.adminUsername, '管理员用户名', { min: 3, max: 64 });
    const passwordHash = await this.hashPassword(this.options.adminPassword);
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const now = nowIso();
    this.database.transaction(() => {
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

  async login(usernameInput: unknown, passwordInput: unknown): Promise<{
    principal: SessionPrincipal;
    token: string;
    csrfToken: string;
    expiresAt: string;
  }> {
    const username = requireString(usernameInput, '用户名', { min: 3, max: 64 });
    if (typeof passwordInput !== 'string') throw new UnauthorizedException('用户名或密码错误');
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
    this.database
      .prepare(
        `INSERT INTO sessions
           (token_hash, user_id, csrf_hash, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, user.id, csrfHash, expiresAt, now, now);

    return {
      token,
      csrfToken,
      expiresAt,
      principal: {
        kind: 'session',
        userId: user.id,
        username: user.username,
        systemRole: user.system_role,
        mustChangePassword: Boolean(user.must_change_password),
        tokenHash,
        csrfHash,
      },
    };
  }

  assertLoginAllowed(key: string): void {
    const current = this.loginFailures.get(key);
    if (!current) return;
    if (current.resetAt <= Date.now()) {
      this.loginFailures.delete(key);
      return;
    }
    if (current.count >= 5) {
      throw new HttpException('登录尝试过多，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  recordLoginFailure(key: string): void {
    const current = this.loginFailures.get(key);
    const now = Date.now();
    if (this.loginFailures.size > 10_000) {
      for (const [candidate, value] of this.loginFailures) {
        if (value.resetAt <= now) this.loginFailures.delete(candidate);
      }
      if (this.loginFailures.size > 10_000) this.loginFailures.delete(this.loginFailures.keys().next().value as string);
    }
    this.loginFailures.set(key, current && current.resetAt > now
      ? { count: current.count + 1, resetAt: current.resetAt }
      : { count: 1, resetAt: now + 15 * 60_000 });
  }

  clearLoginFailures(key: string): void {
    this.loginFailures.delete(key);
  }

  primaryWorkspaceRole(userId: string): string | null {
    const row = this.database
      .prepare(
        `SELECT role FROM workspace_members WHERE user_id = ?
         ORDER BY CASE role WHEN 'Owner' THEN 1 WHEN 'Admin' THEN 2 WHEN 'KnowledgeEditor' THEN 3 WHEN 'ContentEditor' THEN 4 ELSE 5 END
         LIMIT 1`,
      )
      .get(userId) as { role: string } | undefined;
    return row?.role ?? null;
  }

  authenticateSession(token: string | undefined): SessionPrincipal {
    if (!token) throw new UnauthorizedException('请先登录');
    const row = this.database
      .prepare(
        `SELECT s.token_hash, s.csrf_hash, s.expires_at,
                u.id AS user_id, u.username, u.system_role, u.must_change_password, u.disabled_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(this.digest(token)) as
      | {
          token_hash: string;
          csrf_hash: string;
          expires_at: string;
          user_id: string;
          username: string;
          system_role: 'admin' | 'user';
          must_change_password: number;
          disabled_at: string | null;
        }
      | undefined;
    if (!row || row.disabled_at || Date.parse(row.expires_at) <= Date.now()) {
      if (row) this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      throw new UnauthorizedException('会话已失效，请重新登录');
    }
    this.database
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(nowIso(), row.token_hash);
    return {
      kind: 'session',
      userId: row.user_id,
      username: row.username,
      systemRole: row.system_role,
      mustChangePassword: Boolean(row.must_change_password),
      tokenHash: row.token_hash,
      csrfHash: row.csrf_hash,
    };
  }

  authenticateApiKey(secret: string | undefined): ApiKeyPrincipal {
    if (!secret?.startsWith('cak_')) throw new UnauthorizedException('API Key 无效');
    const row = this.database
      .prepare(
        `SELECT id, workspace_id, permissions_json FROM api_keys
         WHERE secret_hash = ? AND revoked_at IS NULL`,
      )
      .get(this.digest(secret)) as
      | { id: string; workspace_id: string; permissions_json: string }
      | undefined;
    if (!row) throw new UnauthorizedException('API Key 无效');
    this.database.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
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
    if (typeof current !== 'string' || typeof next !== 'string') {
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

  async createUser(input: {
    username: unknown;
    password: unknown;
    systemRole?: unknown;
  }): Promise<Record<string, unknown>> {
    const username = requireString(input.username, '用户名', {
      min: 3,
      max: 64,
      pattern: /^[^\s/\\]+$/u,
    });
    if (typeof input.password !== 'string') throw new BadRequestException('密码不能为空');
    const role = input.systemRole === 'admin' ? 'admin' : 'user';
    const id = randomUUID();
    const now = nowIso();
    try {
      this.database
        .prepare(
          `INSERT INTO users
             (id, username, password_hash, system_role, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, username, await this.hashPassword(input.password), role, now, now);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new ConflictException('用户名已存在');
      throw error;
    }
    return { id, username, systemRole: role, mustChangePassword: true, createdAt: now };
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

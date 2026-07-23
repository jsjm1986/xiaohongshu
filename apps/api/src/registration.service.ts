import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { AuthService } from './auth.service.js';
import { DatabaseService } from './database.service.js';
import { nowIso, requireString } from './utils.js';

const PHONE_RE = /^1[3-9]\d{9}$/;

interface RequestRow {
  id: string;
  username: string;
  password_hash: string;
  organization_name: string;
  phone: string;
  status: 'pending' | 'approved' | 'rejected';
  review_note: string | null;
  created_at: string;
}

@Injectable()
export class RegistrationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async submit(input: { username: unknown; password: unknown; organizationName: unknown; phone: unknown }): Promise<{ ok: true }> {
    const username = requireString(input.username, '用户名', { min: 3, max: 64, pattern: /^[^\s/\\]+$/u });
    if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256) {
      throw new BadRequestException('密码长度必须在 12-256 个字符之间');
    }
    const organizationName = requireString(input.organizationName, '机构名称', { max: 120 });
    const phone = requireString(input.phone, '手机号', { min: 11, max: 11 });
    if (!PHONE_RE.test(phone)) throw new BadRequestException('请输入有效的手机号');

    const userTaken = this.database.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (userTaken) throw new ConflictException('该用户名已被使用或已提交申请');
    const pendingSameName = this.database
      .prepare("SELECT 1 FROM registration_requests WHERE username = ? COLLATE NOCASE AND status = 'pending'")
      .get(username);
    if (pendingSameName) throw new ConflictException('该用户名已被使用或已提交申请');
    const pendingSamePhone = this.database
      .prepare("SELECT 1 FROM registration_requests WHERE phone = ? AND status = 'pending'")
      .get(phone);
    if (pendingSamePhone) throw new ConflictException('该手机号已提交申请，请勿重复提交');

    const passwordHash = await this.auth.hashPassword(input.password);
    const now = nowIso();
    this.database
      .prepare(
        `INSERT INTO registration_requests
           (id, username, password_hash, organization_name, phone, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(randomUUID(), username, passwordHash, organizationName, phone, now, now);
    return { ok: true };
  }

  list(status = 'pending'): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        `SELECT id, username, organization_name AS organizationName, phone, status, created_at AS createdAt
         FROM registration_requests WHERE status = ? ORDER BY created_at DESC`,
      )
      .all(status);
  }

  approve(id: string, reviewerId: string): { userId: string; workspaceId: string } {
    return this.database.transaction(() => {
      const req = this.database.prepare('SELECT * FROM registration_requests WHERE id = ?').get(id) as RequestRow | undefined;
      if (!req) throw new NotFoundException('申请不存在');
      if (req.status !== 'pending') throw new ConflictException('该申请已处理');
      if (this.database.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(req.username)) {
        throw new ConflictException('用户名已被占用，无法通过');
      }
      const { userId, workspaceId } = this.auth.provisionUserWithWorkspace({
        username: req.username,
        passwordHash: req.password_hash,
        systemRole: 'user',
        mustChangePassword: false,
        workspaceName: req.organization_name,
      });
      const now = nowIso();
      const reviewedBy = this.resolveReviewer(reviewerId);
      this.database
        .prepare("UPDATE registration_requests SET status = 'approved', created_user_id = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
        .run(userId, reviewedBy, now, now, id);
      this.audit.record({ workspaceId, userId: reviewerId, action: 'registration.approve', entityType: 'registration', entityId: id, details: { username: req.username } });
      return { userId, workspaceId };
    });
  }

  reject(id: string, reviewerId: string, reason: string): void {
    const note = requireString(reason, '拒绝原因', { max: 500 });
    const req = this.database.prepare('SELECT status FROM registration_requests WHERE id = ?').get(id) as { status: string } | undefined;
    if (!req) throw new NotFoundException('申请不存在');
    if (req.status !== 'pending') throw new ConflictException('该申请已处理');
    const now = nowIso();
    const reviewedBy = this.resolveReviewer(reviewerId);
    this.database
      .prepare("UPDATE registration_requests SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
      .run(note, reviewedBy, now, now, id);
    this.audit.record({ userId: reviewerId, action: 'registration.reject', entityType: 'registration', entityId: id, details: { reason: note } });
  }

  loginHintFor(username: string): { status: 'pending' } | { status: 'rejected'; note: string } | null {
    const row = this.database
      .prepare("SELECT status, review_note FROM registration_requests WHERE username = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1")
      .get(username) as { status: string; review_note: string | null } | undefined;
    if (!row) return null;
    if (row.status === 'pending') return { status: 'pending' };
    if (row.status === 'rejected') return { status: 'rejected', note: row.review_note ?? '' };
    return null;
  }

  // reviewed_by has a FK to users(id); only persist when the reviewer is a real user.
  private resolveReviewer(reviewerId: string): string | null {
    const exists = this.database.prepare('SELECT 1 FROM users WHERE id = ?').get(reviewerId);
    return exists ? reviewerId : null;
  }
}

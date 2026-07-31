import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { nowIso } from './utils.js';

interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
  message: string;
}

interface RateLimitRow {
  attempt_count: number;
  reset_at: string;
}

@Injectable()
export class RateLimitService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  consume(scope: string, key: string, options: RateLimitOptions): void {
    const now = nowIso();
    const resetAt = new Date(Date.now() + options.windowMs).toISOString();
    const keyHash = createHash('sha256').update(key).digest('hex');
    const allowed = this.database.transaction(() => {
      const current = this.database.prepare(
        'SELECT attempt_count, reset_at FROM rate_limit_buckets WHERE scope=? AND key_hash=?',
      ).get(scope, keyHash) as unknown as RateLimitRow | undefined;

      if (current && current.reset_at > now) {
        if (Number(current.attempt_count) >= options.maxAttempts) return false;
        this.database.prepare(
          'UPDATE rate_limit_buckets SET attempt_count=attempt_count + 1, updated_at=? ' +
          'WHERE scope=? AND key_hash=? AND reset_at>?',
        ).run(now, scope, keyHash, now);
        return true;
      }

      this.database.prepare(
        'INSERT INTO rate_limit_buckets ' +
        '(scope, key_hash, attempt_count, reset_at, updated_at) VALUES (?, ?, 1, ?, ?) ' +
        'ON CONFLICT(scope, key_hash) DO UPDATE SET ' +
        'attempt_count=1, reset_at=excluded.reset_at, updated_at=excluded.updated_at',
      ).run(scope, keyHash, resetAt, now);
      // Cleanup keeps abandoned attacker-controlled keys bounded without
      // retaining raw IP addresses or usernames.
      this.database.prepare(
        'DELETE FROM rate_limit_buckets WHERE reset_at<=? AND NOT (scope=? AND key_hash=?)',
      ).run(now, scope, keyHash);
      return true;
    });
    if (!allowed) throw new HttpException(options.message, HttpStatus.TOO_MANY_REQUESTS);
  }

  clear(scope: string, key: string): void {
    const keyHash = createHash('sha256').update(key).digest('hex');
    this.database.prepare(
      'DELETE FROM rate_limit_buckets WHERE scope=? AND key_hash=?',
    ).run(scope, keyHash);
  }
}

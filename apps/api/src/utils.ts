import { BadRequestException, NotFoundException } from '@nestjs/common';

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_ARRAY_ITEMS = 5_000;
const MAX_JSON_OBJECT_KEYS = 2_000;
const UNSAFE_JSON_KEYS = new Set(['__proto__']);

export function nowIso(): string {
  return new Date().toISOString();
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('请求体必须是 JSON 对象');
  }
  assertJsonComplexity(value, '请求体');
  return value as Record<string, unknown>;
}

/**
 * Bound parsed JSON before services spread, clone, hash or stringify it. The
 * HTTP byte limit alone does not prevent deeply nested or extremely wide
 * values from exhausting the call stack or creating disproportionate work.
 */
export function assertJsonComplexity(value: unknown, field = 'JSON'): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;

  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new BadRequestException(`${field} 结构过大`);
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) throw new BadRequestException(`${field} 不能包含循环引用`);
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_ARRAY_ITEMS) {
        throw new BadRequestException(`${field} 数组项过多`);
      }
      if (current.value.length && current.depth >= MAX_JSON_DEPTH) {
        throw new BadRequestException(`${field} 嵌套层级过深`);
      }
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }

    const entries = Object.entries(current.value as Record<string, unknown>);
    if (entries.length > MAX_JSON_OBJECT_KEYS) {
      throw new BadRequestException(`${field} 对象字段过多`);
    }
    if (entries.length && current.depth >= MAX_JSON_DEPTH) {
      throw new BadRequestException(`${field} 嵌套层级过深`);
    }
    for (const [key, item] of entries) {
      if (UNSAFE_JSON_KEYS.has(key)) {
        throw new BadRequestException(`${field} 包含不安全字段`);
      }
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
}

export function requireString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} 必须是字符串`);
  const text = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 255;
  if (text.length < min || text.length > max) {
    throw new BadRequestException(`${field} 长度必须在 ${min}-${max} 之间`);
  }
  if (options.pattern && !options.pattern.test(text)) {
    throw new BadRequestException(`${field} 格式不正确`);
  }
  return text;
}

export function optionalString(value: unknown, field: string, max = 2_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} 必须是字符串`);
  if (value.length > max) throw new BadRequestException(`${field} 最长 ${max} 个字符`);
  return value.trim();
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || `item-${Date.now().toString(36)}`;
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export interface Pagination {
  limit: number;
  offset: number;
}

/** Parse bounded offset pagination without silently coercing malformed input. */
export function parsePagination(
  rawLimit: unknown,
  rawOffset: unknown,
  options: { defaultLimit?: number; maxLimit?: number; maxOffset?: number } = {},
): Pagination {
  const defaultLimit = options.defaultLimit ?? 50;
  const maxLimit = options.maxLimit ?? 100;
  const maxOffset = options.maxOffset ?? 1_000_000;
  const integer = (value: unknown, field: string, fallback: number, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/u.test(value)) {
      throw new BadRequestException(`${field} 必须是整数`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(`${field} 必须在 ${min}-${max} 之间`);
    }
    return parsed;
  };
  return {
    limit: integer(rawLimit, 'limit', defaultLimit, 1, maxLimit),
    offset: integer(rawOffset, 'offset', 0, 0, maxOffset),
  };
}

export function asRow<T>(value: unknown, message = '资源不存在'): T {
  if (!value) throw new NotFoundException(message);
  return value as T;
}

import { BadRequestException, NotFoundException } from '@nestjs/common';

export function nowIso(): string {
  return new Date().toISOString();
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
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

export function asRow<T>(value: unknown, message = '资源不存在'): T {
  if (!value) throw new NotFoundException(message);
  return value as T;
}

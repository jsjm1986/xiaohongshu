import { PayloadTooLargeException } from '@nestjs/common';

export const MAX_KNOWLEDGE_CONTEXT_FILES = 64;
export const MAX_KNOWLEDGE_CONTEXT_BYTES = 16 * 1024 * 1024;

export interface KnowledgeBudgetRow {
  bytes?: unknown;
}

export function knowledgeContextUsage(rows: readonly KnowledgeBudgetRow[]): {
  fileCount: number;
  totalBytes: number;
} {
  let totalBytes = 0;
  for (const row of rows) {
    const bytes = Number(row.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || totalBytes > Number.MAX_SAFE_INTEGER - bytes) {
      return { fileCount: rows.length, totalBytes: Number.MAX_SAFE_INTEGER };
    }
    totalBytes += bytes;
  }
  return { fileCount: rows.length, totalBytes };
}

export function assertKnowledgeContextBudget(input: {
  operation: string;
  fileCount: number;
  totalBytes: number;
}): void {
  const fileCount = Number.isSafeInteger(input.fileCount) && input.fileCount >= 0
    ? input.fileCount
    : MAX_KNOWLEDGE_CONTEXT_FILES + 1;
  const totalBytes = Number.isSafeInteger(input.totalBytes) && input.totalBytes >= 0
    ? input.totalBytes
    : MAX_KNOWLEDGE_CONTEXT_BYTES + 1;
  if (fileCount <= MAX_KNOWLEDGE_CONTEXT_FILES && totalBytes <= MAX_KNOWLEDGE_CONTEXT_BYTES) return;
  throw new PayloadTooLargeException({
    message: `${input.operation}使用的知识内容超过上下文预加载上限，请缩小知识选择范围后重试`,
    code: 'KNOWLEDGE_CONTEXT_LIMIT',
    usage: { fileCount, totalBytes },
    limits: {
      maxFiles: MAX_KNOWLEDGE_CONTEXT_FILES,
      maxBytes: MAX_KNOWLEDGE_CONTEXT_BYTES,
    },
  });
}

export function assertKnowledgeRowsBudget(
  operation: string,
  rows: readonly KnowledgeBudgetRow[],
): void {
  assertKnowledgeContextBudget({ operation, ...knowledgeContextUsage(rows) });
}

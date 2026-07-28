import { BadRequestException } from '@nestjs/common';
import { optionalString, requireObject, requireString } from './utils.js';

/** AI 对推断把握程度的自评。用于前端标注,低把握的要重点审查。 */
export type EnrichConfidence = 'low' | 'medium' | 'high';

/** 用户对单条草稿的处置。 */
export type MergeItemStatus = 'confirmed' | 'edited' | 'deleted';

export interface DraftItem {
  gapId: string;
  title: string;
  question: string;
  priority: number;
  aiDraft: string;
  confidence: EnrichConfidence;
}

export interface EnrichDraftResult {
  gaps: DraftItem[];
}

export interface MergeItem {
  gapId: string;
  status: MergeItemStatus;
  content?: string;
}

export interface MergePreview {
  preview: string;
  targetFile: string;
  isNewFile: boolean;
}

/*
 * 为什么没有 tokensUsed:
 * callAnalysisModel 只把模型输出的 JSON 对象往上传,usage 字段在那一层就被丢掉了,
 * 拿不到真实 token 数。设计稿里写了这个字段,但填 0 或估算值等于在 UI 上摆一个
 * 看着像事实的假数字。要显示消耗就得先改 callAnalysisModel 的返回值,那是另一件事。
 */

export const MAX_MERGE_ITEMS = 50;
export const MAX_ITEM_CONTENT_CHARS = 20_000;
export const MAX_TOTAL_CONTENT_CHARS = 500_000;
export const MAX_SAVE_CONTENT_BYTES = 2 * 1024 * 1024;

const CONFIDENCES = new Set<string>(['low', 'medium', 'high']);
const MERGE_STATUSES = new Set<string>(['confirmed', 'edited', 'deleted']);

/**
 * 目标文件名必须是裸文件名 + .md/.txt。
 *
 * 这不只是格式校验:文件名最终会进 knowledge.import(),那里再走 path.join。
 * 放过 `../` 就是路径穿越,所以这里显式拒绝任何分隔符。knowledge.service.ts
 * 的 validateFilename 也做同样的事,两道都要有——本函数是入口拒绝,那里是存储层兜底。
 */
function parseTargetFile(value: unknown, field: string): string {
  const text = requireString(value, field, { max: 180 });
  if (text.includes('/') || text.includes('\\') || text.startsWith('.')) {
    throw new BadRequestException(`${field} 不能包含路径或以点开头`);
  }
  if (!/\.(md|txt)$/i.test(text)) {
    throw new BadRequestException(`${field} 仅支持 .md 和 .txt`);
  }
  return text;
}

export function isEnrichConfidence(value: unknown): value is EnrichConfidence {
  return typeof value === 'string' && CONFIDENCES.has(value);
}

/** 解析 merge 请求。items 至少一条、至多 MAX_MERGE_ITEMS 条。 */
export function parseMergeRequest(body: unknown): { items: MergeItem[]; targetFile?: string } {
  const raw = requireObject(body);
  if (!Array.isArray(raw.items)) throw new BadRequestException('items 必须是数组');
  if (raw.items.length === 0) throw new BadRequestException('items 不能为空');
  if (raw.items.length > MAX_MERGE_ITEMS) {
    throw new BadRequestException(`items 最多 ${MAX_MERGE_ITEMS} 条`);
  }

  const items: MergeItem[] = raw.items.map((entry, index) => {
    const item = requireObject(entry);
    const gapId = requireString(item.gapId, `items[${index}].gapId`, { max: 200 });
    const status = requireString(item.status, `items[${index}].status`, { max: 20 });
    if (!MERGE_STATUSES.has(status)) {
      throw new BadRequestException(`items[${index}].status 必须是 confirmed / edited / deleted`);
    }
    const content = optionalString(item.content, `items[${index}].content`, MAX_ITEM_CONTENT_CHARS);
    return { gapId, status: status as MergeItemStatus, content };
  });

  // 总长度在入口就挡住:合并提示词会把所有 content 拼进去,过长会撞模型上下文上限。
  const totalChars = items.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
    throw new BadRequestException(`补充内容总长度超过 ${MAX_TOTAL_CONTENT_CHARS} 字符`);
  }

  const targetFile = raw.targetFile === undefined || raw.targetFile === null
    ? undefined
    : parseTargetFile(raw.targetFile, 'targetFile');
  return { items, targetFile };
}

/** 解析 save 请求。content 按字节校验——2 MiB 是 knowledge.import 的硬上限。 */
export function parseSaveRequest(body: unknown): { content: string; targetFile: string } {
  const raw = requireObject(body);
  const content = requireString(raw.content, 'content', { max: MAX_SAVE_CONTENT_BYTES });
  if (Buffer.byteLength(content, 'utf8') > MAX_SAVE_CONTENT_BYTES) {
    throw new BadRequestException('content 不能超过 2 MiB');
  }
  return { content, targetFile: parseTargetFile(raw.targetFile, 'targetFile') };
}

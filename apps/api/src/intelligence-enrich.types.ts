import { BadRequestException } from '@nestjs/common';
import { optionalString, requireObject, requireString } from './utils.js';

/** AI 整理现有资料时对证据明确程度的自评。 */
export type EnrichConfidence = 'low' | 'medium' | 'high';

/** 这条规划缺口是否需要转成 Markdown 知识。 */
export type KnowledgeAction = 'organize_existing' | 'ask_user' | 'none';

export interface DraftSourceExcerpt {
  evidenceId: string;
  filename: string;
  heading: string;
  excerpt: string;
}

/** 用户对单条草稿的处置。 */
export type MergeItemStatus = 'confirmed' | 'edited' | 'deleted';

export interface DraftItem {
  gapId: string;
  title: string;
  question: string;
  priority: number;
  aiDraft: string;
  confidence: EnrichConfidence;
  knowledgeAction: Exclude<KnowledgeAction, 'none'>;
  knowledgeReason: string;
  sources: DraftSourceExcerpt[];
}

export interface EnrichDraftResult {
  gaps: DraftItem[];
  /**
   * 本项目当前待补充的缺口总数(未截断)。
   *
   * 一次起草有上限(MAX_DRAFT_GAPS),超出的部分不会进提示词。入口按钮上写的是
   * 真实待补数,如果不把总数回传,用户看到「补充 17 项」点进去只有 15 条,
   * 少了哪两条无从得知。前端据此显示「这次只起草了前 N 条」。
   */
  totalPending: number;
  /** 单次起草上限。与 totalPending 一起用于判断有没有被截断。 */
  limit: number;
  /**
   * 正文读不出来的知识文件名。
   *
   * 存储层丢文件、权限变更都会让某个文件读不到。整批起草不该因为一个文件挂掉,
   * 但也不能装作无事发生——模型少看了一份资料,整理结果会受影响,用户有权知道。
   */
  unreadableFiles: string[];
}

export interface MergeItem {
  gapId: string;
  status: MergeItemStatus;
  content?: string;
}

export interface MergePreview {
  preview: string;
  targetFile: string;
  /** 合并时读取的目标版本。null 表示当时目标文件不存在。 */
  baseFileId: string | null;
  isNewFile: boolean;
  /** 兼容旧客户端的保留字段；确定性合并不改写内容，因此恒为 0。 */
  hedgeLossCount: number;
  /** 确定性追加的条目数。 */
  appendedCount: number;
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

  // 总长度在入口就挡住，避免确定性追加生成超大文档并超过知识文件上限。
  const totalChars = items.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
    throw new BadRequestException(`补充内容总长度超过 ${MAX_TOTAL_CONTENT_CHARS} 字符`);
  }

  const targetFile = raw.targetFile === undefined || raw.targetFile === null
    ? undefined
    : parseTargetFile(raw.targetFile, 'targetFile');
  return { items, targetFile };
}

/**
 * 解析 draft 请求。
 *
 * body 可以整个缺省(整批模式)。给了 gapIds 就是单条/多条精补,
 * 上限沿用 MAX_MERGE_ITEMS——再多提示词也放不下。
 */
export function parseDraftRequest(body: unknown): { gapIds?: string[] } {
  if (body === undefined || body === null) return {};
  const raw = requireObject(body);
  if (raw.gapIds === undefined || raw.gapIds === null) return {};
  if (!Array.isArray(raw.gapIds)) throw new BadRequestException('gapIds 必须是数组');
  if (raw.gapIds.length === 0) throw new BadRequestException('gapIds 不能是空数组;不指定就整批起草');
  if (raw.gapIds.length > MAX_MERGE_ITEMS) {
    throw new BadRequestException(`gapIds 最多 ${MAX_MERGE_ITEMS} 条`);
  }
  const gapIds = raw.gapIds.map((id, index) => requireString(id, `gapIds[${index}]`, { max: 200 }));
  return { gapIds: [...new Set(gapIds)] };
}

/** 解析 save 请求。content 按字节校验——2 MiB 是 knowledge.import 的硬上限。 */
export function parseSaveRequest(body: unknown): { content: string; targetFile: string; baseFileId: string | null } {
  const raw = requireObject(body);
  const content = requireString(raw.content, 'content', { max: MAX_SAVE_CONTENT_BYTES });
  if (Buffer.byteLength(content, 'utf8') > MAX_SAVE_CONTENT_BYTES) {
    throw new BadRequestException('content 不能超过 2 MiB');
  }
  if (raw.baseFileId !== null && typeof raw.baseFileId !== 'string') {
    throw new BadRequestException('baseFileId 必须是字符串或 null');
  }
  const baseFileId = raw.baseFileId === null
    ? null
    : requireString(raw.baseFileId, 'baseFileId', { max: 200 });
  return { content, targetFile: parseTargetFile(raw.targetFile, 'targetFile'), baseFileId };
}

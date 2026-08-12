import type { GenerationJob } from '../types';

export type ExportFormat = 'markdown' | 'json' | 'docx' | 'pdf';

export interface BatchExportItem {
  jobId: string;
  candidateId: string;
  filename: string;
}

export interface BatchExportPlan {
  items: BatchExportItem[];
  total: number;
  /** 未通过可发布校验、后端会拒的候选数 */
  skippedUnpublishable: number;
  /** 未完成(失败/进行中/无候选)的任务数 */
  skippedUnfinished: number;
  /**
   * markdown 格式里包含的「未过校验」候选数:它们仍会导出(供人核对),
   * 但文档顶部带「仅供核对，不得直接发布」水印(quickCandidateToMarkdown 负责),
   * 调用方要在结果提示里如实说明。
   */
  draftWatermarked: number;
}

/** 去掉文件名里的路径非法字符,避免下载失败或落到别的目录 */
function safeName(input: string): string {
  return input.replace(/[\\/:*?"<>|\r\n]/gu, '_').slice(0, 60) || '文案';
}

const EXT: Record<ExportFormat, string> = { markdown: 'md', json: 'json', docx: 'docx', pdf: 'pdf' };

/**
 * 规划批量导出。
 *
 * 关键约束:后端导出对未通过校验的候选一律 400(export.service.ts:155),
 * 实测 165 个候选里 129 个都过不了。所以后端三种格式必须先筛掉不可发布的,
 * 否则大半请求是 400、用户看到一堆失败下载。
 *
 * markdown 例外:它在前端本地拼装,不经后端、没有校验门槛——待核对的稿子
 * 也该能拿出来给人看,所以不筛,但计入 draftWatermarked:文档本身会带
 * 「仅供核对，不得直接发布」水印,提示文案也要如实说明。
 *
 * 只做规划不发请求:下载动作交给调用方(便于用 node:test 直接测)。
 */
export function planBatchExport(jobs: GenerationJob[], format: ExportFormat): BatchExportPlan {
  const items: BatchExportItem[] = [];
  let skippedUnpublishable = 0;
  let skippedUnfinished = 0;
  let draftWatermarked = 0;

  for (const job of jobs) {
    const candidates = job.candidates ?? [];
    if (job.status !== 'completed' || candidates.length === 0) {
      skippedUnfinished += 1;
      continue;
    }
    // 同一任务多个候选:文件名带序号,否则浏览器会把同名文件叠成 (1)(2)
    const multi = candidates.length > 1;
    candidates.forEach((candidate, index) => {
      const publishable = (candidate as { publishable?: boolean }).publishable
        ?? (candidate as { validation?: { valid?: boolean } }).validation?.valid === true;
      if (!publishable) {
        if (format !== 'markdown') {
          skippedUnpublishable += 1;
          return;
        }
        draftWatermarked += 1;
      }
      const base = safeName(job.topic || '文案');
      const suffix = multi ? `-${index + 1}` : '';
      items.push({
        jobId: job.id,
        candidateId: candidate.id,
        filename: `${base}${suffix}.${EXT[format]}`,
      });
    });
  }

  return { items, total: items.length, skippedUnpublishable, skippedUnfinished, draftWatermarked };
}

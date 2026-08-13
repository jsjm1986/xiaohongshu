import {
  candidateQualityStatusLabel,
  resolveCandidateQualityStatus,
  type CandidateQualityStatus,
} from '@content-agent/agent-core/delivery-policy';
import type { GenerationJob } from '../types';
import { candidateDeliverable } from './delivery-readiness';

export type ExportFormat = 'markdown' | 'json' | 'docx' | 'pdf';

export interface BatchExportItem {
  jobId: string;
  candidateId: string;
  filename: string;
  qualityStatus: CandidateQualityStatus;
  qualityStatusLabel: string;
}

export interface BatchExportPlan {
  items: BatchExportItem[];
  total: number;
  /** 命中不可覆盖交付硬门禁、任何格式都不得导出的候选数 */
  skippedBlocked: number;
  /** 未完成(失败/进行中/无候选)的任务数 */
  skippedUnfinished: number;
}

/** 去掉文件名里的路径非法字符,避免下载失败或落到别的目录 */
function safeName(input: string): string {
  return input.replace(/[\\/:*?"<>|\r\n]/gu, '_').slice(0, 60) || '文案';
}

const EXT: Record<ExportFormat, string> = { markdown: 'md', json: 'json', docx: 'docx', pdf: 'pdf' };

/**
 * 规划批量导出。
 *
 * 所有格式（包括前端本地拼装的 Markdown）共用统一交付硬门禁，避免本地下载
 * 绕过服务端约束。needs_review 不是硬阻断，仍保留批量导出能力。
 *
 * 只做规划不发请求:下载动作交给调用方(便于用 node:test 直接测)。
 */
export function planBatchExport(jobs: GenerationJob[], format: ExportFormat): BatchExportPlan {
  const items: BatchExportItem[] = [];
  let skippedBlocked = 0;
  let skippedUnfinished = 0;

  for (const job of jobs) {
    const candidates = job.candidates ?? [];
    if (job.status !== 'completed' || candidates.length === 0) {
      skippedUnfinished += 1;
      continue;
    }
    // 同一任务多个候选:文件名带序号,否则浏览器会把同名文件叠成 (1)(2)
    const multi = candidates.length > 1;
    candidates.forEach((candidate, index) => {
      const deliverable = candidateDeliverable(candidate.validation, false, {
        generationMode: candidate.generationMode,
        deliverability: candidate.artifactRealization?.deliverability,
      });
      if (!deliverable) {
        skippedBlocked += 1;
        return;
      }
      const base = safeName(job.topic || '文案');
      const suffix = multi ? `-${index + 1}` : '';
      const qualityStatus = resolveCandidateQualityStatus(candidate.validation);
      items.push({
        jobId: job.id,
        candidateId: candidate.id,
        filename: `${base}${suffix}.${EXT[format]}`,
        qualityStatus,
        qualityStatusLabel: candidateQualityStatusLabel(qualityStatus),
      });
    });
  }

  return { items, total: items.length, skippedBlocked, skippedUnfinished };
}

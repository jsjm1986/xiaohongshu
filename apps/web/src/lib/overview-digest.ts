import type { GenerationJob } from '../types';

/**
 * 总览的产出摘要。
 *
 * 口径说明(重要):
 * - 「可直接发布」= qualityStatus === 'passed'。后端在 generation.service.ts 里按
 *   validCandidateCount > 0 置这个值,即至少有一个候选通过了可发布校验。
 * - completed 但没有 qualityStatus 的老任务算「需人工核对」,不算可发布——
 *   缺字段不等于合格。
 * - 比例只按已落地的三类(可发布 / 待核对 / 失败)归一,不把进行中计入分母,
 *   否则一排队条形就会缩水,看起来像质量下降。
 *
 * 刻意没做「本周产出趋势」:真实数据只跨 4 天且 101/123 集中在同一天,
 * 七格柱状图会是一根孤柱加六个空格,那是噪声不是信息。
 */
export interface OverviewDigest {
  total: number;
  /** 已落地(非进行中)的任务数,比例的分母 */
  settled: number;
  publishable: number;
  needsReview: number;
  failed: number;
  inFlight: number;
  publishableRatio: number;
  needsReviewRatio: number;
  failedRatio: number;
  recent: GenerationJob[];
}

const isInFlight = (status: string) => status === 'queued' || status === 'running';

export function overviewDigest(jobs: GenerationJob[], recentLimit = 5): OverviewDigest {
  let publishable = 0;
  let needsReview = 0;
  let failed = 0;
  let inFlight = 0;

  for (const j of jobs) {
    if (isInFlight(j.status)) { inFlight += 1; continue; }
    if (j.status === 'failed') { failed += 1; continue; }
    if (j.qualityStatus === 'passed') { publishable += 1; continue; }
    // completed 且非 passed(含 needs_review 与缺省)
    needsReview += 1;
  }

  const settled = publishable + needsReview + failed;
  const ratio = (n: number) => (settled > 0 ? n / settled : 0);

  // 倒序取最近:缺 createdAt 的排在最后(空字符串比任何 ISO 串都小)
  const recent = [...jobs]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, recentLimit);

  return {
    total: jobs.length,
    settled,
    publishable,
    needsReview,
    failed,
    inFlight,
    publishableRatio: ratio(publishable),
    needsReviewRatio: ratio(needsReview),
    failedRatio: ratio(failed),
    recent,
  };
}

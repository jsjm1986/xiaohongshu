import type { TopicOpportunity } from '../types';

/**
 * 选题卡展示层:把接口已经返回的字段整理成卡片要渲染的形状。
 *
 * 只做整理,不做计算。分数、序位、七项指标一律用服务端给的值原样带出——
 * 前端自己重新加权或归一化出来的数字没有审计链,也对不上后端的排序结果。
 */

/** 读者阶段 → 中文。枚举来自 intelligence.service.ts 的 audienceStages()。 */
export const AUDIENCE_STAGE_LABEL: Record<string, string> = {
  discovering: '刚发现',
  collecting: '收藏中',
  comparing: '对比中',
  hesitating: '犹豫中',
  ready: '准备下单',
};

/** 流入口 → 中文。枚举来自 intelligence.service.ts 的 entryRoute()。 */
export const ENTRY_LABEL: Record<string, string> = {
  search: '搜索进来',
  recommendation: '推荐流',
  profile: '主页进来',
  return_visit: '回访',
};

/**
 * 七项人工复核启发式的展示顺序与中文名。
 *
 * 顺序按 types.ts 里 TopicOpportunity 的声明顺序固定,不按数值排序:
 * 这些分是「未校准的排序辅助」,同一项在不同选题间的位置必须一致,
 * 否则用户会以为顺序本身有含义。
 */
const METRIC_LABELS: Array<{ key: MetricKey; label: string; inverse?: true }> = [
  { key: 'relevance', label: '相关' },
  { key: 'importance', label: '重要' },
  { key: 'proofability', label: '可证' },
  { key: 'decisionLeverage', label: '决策' },
  { key: 'novelty', label: '新颖' },
  { key: 'cognitiveCost', label: '认知成本', inverse: true },
  { key: 'risk', label: '风险', inverse: true },
];

type MetricKey =
  | 'relevance' | 'importance' | 'proofability'
  | 'decisionLeverage' | 'novelty' | 'cognitiveCost' | 'risk';

export interface TopicCardMetric {
  key: MetricKey;
  label: string;
  /** 0..1,已确保非 null */
  value: number;
  /**
   * true 表示「越低越好」(认知成本、风险),方向与其余五项相反。
   * 放在数据层而不是组件里:方向是指标语义的一部分,不是样式选择。
   */
  inverse: boolean;
}

export interface TopicCardView {
  /** 推荐理由:rationale 优先,回落 angle,都没有则 null */
  rationale: string | null;
  stageLabel: string | null;
  entryLabel: string | null;
  /** finalScore 的三位小数文本;无分则 null */
  scoreText: string | null;
  /** 「推荐 N」序位文本;无 rank 则 null */
  rankText: string | null;
  metrics: TopicCardMetric[];
  evidenceCount: number;
  boundaryCount: number;
  /**
   * 恒为 true。后端把这些分标为 ordinal_noncausal_heuristic(未校准、非因果、
   * 仅供人工排序参考),所以只要卡片显示了数字,就必须同屏标注「未校准」。
   * 做成字段而不是散落在组件里的一句话,是为了能被测试锁住。
   */
  uncalibrated: true;
}

/** 未知枚举值回落原文:宁可显示英文,也不要显示 undefined 或崩掉。 */
function label(map: Record<string, string>, value?: string): string | null {
  if (!value) return null;
  return map[value] ?? value;
}

export function topicCardFields(o: TopicOpportunity): TopicCardView {
  const metrics: TopicCardMetric[] = [];
  for (const { key, label: metricLabel, inverse } of METRIC_LABELS) {
    const value = o[key];
    if (typeof value === 'number') metrics.push({ key, label: metricLabel, value, inverse: inverse === true });
  }

  return {
    rationale: o.rationale?.trim() || o.angle?.trim() || null,
    stageLabel: label(AUDIENCE_STAGE_LABEL, o.audienceStage),
    entryLabel: label(ENTRY_LABEL, o.entry),
    scoreText: typeof o.finalScore === 'number' ? o.finalScore.toFixed(3) : null,
    rankText: typeof o.rank === 'number' ? `推荐 ${o.rank}` : null,
    metrics,
    evidenceCount: (o.evidenceIds ?? []).length,
    boundaryCount: (o.boundaries ?? []).length,
    uncalibrated: true,
  };
}

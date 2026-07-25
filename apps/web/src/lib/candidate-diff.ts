import type { ReaderCandidate, ReaderStrategy } from '../types';

/**
 * 候选差异:把三个都叫「随机候选」的版本变成可区分的标签。
 *
 * 后端确实为每个候选生成了不同的表达轴(实测同一任务的三个候选在 bodyRole /
 * narrativeMode / commentMode / voice / openingMode 上互不相同),但接口不返回,
 * 界面只好都写「随机候选」——用户看三个一样的名字,无法判断该选哪个。
 *
 * 重要约束:只有 prototype 是封闭枚举(8 个值),可以做中文映射。其余五个轴实测是
 * 开放词表——bodyRole 出现过 70+ 种取值,含模型产出的中文自由文本(如「列出可能加项
 * (拆结、药浴)及收费标准。」)。这些一律原样显示,不映射、不猜译、不截断语义。
 */

/** 封闭枚举:参考语料的表层原型。 */
const PROTOTYPE_LABEL: Record<string, string> = {
  live_moment: '现场片刻',
  narrow_request: '一个窄问题',
  process_log: '过程记录',
  outcome_observation: '结果观察',
  option_comparison: '方案比较',
  retrospective_update: '回头补记',
  relationship_moment: '关系瞬间',
  expectation_reversal: '预期反转',
};

export function prototypeLabel(value?: string): string | undefined {
  if (!value) return undefined;
  return PROTOTYPE_LABEL[value] ?? value;
}

/** 轴的显示名。轴本身是固定的 6 个,值才是开放的。 */
const AXIS_LABEL: Array<{ key: keyof ReaderStrategy; label: string; mapped?: boolean }> = [
  { key: 'prototype', label: '表层原型', mapped: true },
  { key: 'bodyRole', label: '正文角色' },
  { key: 'narrativeMode', label: '叙述方式' },
  { key: 'openingMode', label: '开头方式' },
  { key: 'commentMode', label: '评论取向' },
  { key: 'voice', label: '语气' },
];

export interface CandidateDiffAxis {
  label: string;
  /** 每个候选在这个轴上的取值(与 candidates 顺序一致);缺失为 undefined */
  values: Array<string | undefined>;
}

export interface CandidateDiffTab {
  id: string;
  /** 短标签,用于版本切换按钮:优先「正文角色 · 评论取向」,退到策略名,再退到「版本N」 */
  label: string;
  publishable: boolean;
  seed?: number;
}

export interface CandidateDiffView {
  tabs: CandidateDiffTab[];
  /** 只包含候选之间真正不同的轴;全同的轴不占版面 */
  differingAxes: CandidateDiffAxis[];
  /** 全部候选的表达轴都一样(或只有一个候选) */
  identical: boolean;
}

type DiffSource = Pick<ReaderCandidate, 'id' | 'seed' | 'strategy' | 'validation'>;

function axisValue(strategy: ReaderStrategy | undefined, key: keyof ReaderStrategy, mapped?: boolean): string | undefined {
  const raw = strategy?.[key];
  if (!raw) return undefined;
  return mapped ? prototypeLabel(raw) : raw;
}

/**
 * 短标签。
 *
 * 优先用 prototype:它是唯一的封闭枚举,映射出来是「回头补记」「现场片刻」这种
 * 4 字词,放在 tab 上刚好。bodyRole 之类的开放词表实测能长到 30 字
 * (「用一个项目适配的普通生活动作或熟人一句话承载变化,不写项目说明书」),
 * 截断后只剩「用一个项目适配的普通…」,反而看不出区别。
 */
function shortLabel(candidate: DiffSource, index: number): string {
  const s = candidate.strategy;
  const proto = prototypeLabel(s?.prototype);
  if (proto) return proto;
  // 没有 prototype 的历史包:退到策略名,再退到序号。策略名过长时截断。
  const label = s?.label;
  if (label) return label.length > 12 ? `${label.slice(0, 12)}…` : label;
  return `版本${index + 1}`;
}

export function candidateDiffView(candidates: DiffSource[]): CandidateDiffView {
  const tabs: CandidateDiffTab[] = candidates.map((c, i) => ({
    id: c.id,
    label: shortLabel(c, i),
    publishable: c.validation?.valid === true,
    seed: c.seed,
  }));

  const differingAxes: CandidateDiffAxis[] = [];
  for (const axis of AXIS_LABEL) {
    const values = candidates.map((c) => axisValue(c.strategy, axis.key, axis.mapped));
    const distinct = new Set(values.map((v) => v ?? ''));
    // 只有一个候选时没有"差异"可言;全同的轴也不列。
    if (candidates.length > 1 && distinct.size > 1) {
      differingAxes.push({ label: axis.label, values });
    }
  }

  return { tabs, differingAxes, identical: differingAxes.length === 0 };
}

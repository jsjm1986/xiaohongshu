/** 人能合法声明的答案来源。supplied_fact 不在内——只有分析器能判定资料支撑。 */
export type HumanGapSource = 'user_supplied' | 'inference' | 'hypothesis' | 'unknown';

export const GAP_SOURCE_OPTIONS: ReadonlyArray<{ value: HumanGapSource; label: string; hint: string }> = [
  { value: 'user_supplied', label: '我确认过', hint: '你为这条答案背书,生成会采用它' },
  { value: 'inference', label: '我的推断', hint: '还算待补充,生成不会当事实用' },
  { value: 'hypothesis', label: '假设', hint: '还算待补充,生成不会当事实用' },
  { value: 'unknown', label: '还不确定', hint: '还算待补充' },
];

/**
 * 答案变化时该落哪个来源。
 *
 * 填了答案默认「我确认过」——这是人工填写最常见的意图,也是唯一能让答案在生成端
 * 被采用的人工路径。但已经明确选过别的来源就不覆盖,分析器判定的 supplied_fact
 * 同样保留:不能因为用户碰了一下答案框就把资料支撑降级成人工背书。
 *
 * 清空答案回落 unknown:没有答案的「我确认过」是矛盾状态。
 */
export function sourceForAnswer(answer: string, current?: string): HumanGapSource | 'supplied_fact' {
  if (!answer.trim()) return 'unknown';
  if (current === 'supplied_fact') return 'supplied_fact';
  if (current === 'inference' || current === 'hypothesis') return current;
  return 'user_supplied';
}

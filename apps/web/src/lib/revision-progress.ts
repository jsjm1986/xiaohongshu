import type { RevisionTask } from '../types';

/**
 * 修改任务的阶段文案。
 *
 * 刻意不复用 quick-progress.progressStageText:那套说的是「解析选题」「生成初稿」,
 * 属于首次生成;revise 不解析选题、不生成初稿,它只重跑受影响的通道。套用会说谎。
 *
 * 里程碑对应 engine.ts 里 agent.revise 的真实阶段。70/85 两档是**条件触发**的
 * (仅当机械锚定未命中时才调模型,见 engine.ts:2679、:2687),所以实际进度可能从
 * 40 直接跳到 95——这是真实情况,不为「平滑」而假装经过。
 */
export function revisionStageText(progress?: number): string {
  if (progress === undefined || progress < 10) return '排队等待中';
  if (progress < 25) return '分析修改影响范围';
  if (progress < 40) return '载入知识与证据';
  if (progress < 70) return '重写受影响的环节';
  if (progress < 85) return '证据锚定复核';
  if (progress < 95) return '声明合规判定';
  if (progress < 100) return '质检与落库';
  return '完成';
}

/** 只有 queued/running 算在跑。缺任务视为不在跑,而不是"可能在跑"。 */
export function isRevisionInFlight(task?: RevisionTask): boolean {
  return task?.status === 'queued' || task?.status === 'running';
}

/** 内部通道名 → 人话。未知通道原样透出,不猜。 */
const CHANNEL_LABEL: Record<string, string> = {
  H: '标签',
  'N.title': '标题',
  'N.body': '正文',
  'N.imageBrief': '图片简报',
  Cref: '评论区',
};

/**
 * 完成提示。列出实际重跑的通道,让用户知道改了哪儿——「只会重新生成受影响的环节」
 * 这句承诺需要有可核对的结果,否则用户无法判断是否真的只动了该动的部分。
 *
 * 拿不到通道信息时只说完成,不声称更新了什么:编一个范围比不说更糟。
 */
export function revisionDoneSummary(task: RevisionTask): string {
  const labels = task.rerunChannels
    .map((channel) => CHANNEL_LABEL[channel] ?? channel)
    .filter((label, index, all) => all.indexOf(label) === index);
  if (!labels.length) return '修改完成';
  return `修改完成，已更新${labels.join('、')}`;
}

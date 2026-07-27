import type { GenerationJob, RevisionTask } from '../types';

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

export interface RevisionBoxState {
  phase: 'idle' | 'in_flight' | 'done' | 'failed';
  task?: RevisionTask;
  buttonLabel: string;
  buttonDisabled: boolean;
  /** 失败时要保留输入框里的指令:原实现在 finally 里无条件清空,用户得重打一遍。 */
  keepInstruction: boolean;
}

/**
 * 侧边栏「继续调整当前候选」的状态。
 *
 * 抽成纯函数是因为这是本改动里唯一有真假之分的逻辑——什么时候禁用按钮、失败要不要
 * 保留指令。JSX 里内联三元式没法测。
 *
 * candidateId 传入时只认这个候选的任务:侧边栏改的是当前选中的候选,别的候选在改
 * 不该锁住这个按钮。
 *
 * 分流顺序按 status 而不是 progress:后端失败时也会写 progress = 100,只看进度会把
 * 失败显示成「完成」。
 */
export function revisionBoxState(job: GenerationJob | null, candidateId?: string): RevisionBoxState {
  const task = job?.activeRevision;
  const mine = task && (!candidateId || task.candidateId === candidateId) ? task : undefined;
  if (!mine) {
    return { phase: 'idle', buttonLabel: '发送修改要求', buttonDisabled: false, keepInstruction: false };
  }
  if (isRevisionInFlight(mine)) {
    return { phase: 'in_flight', task: mine, buttonLabel: '修改中…', buttonDisabled: true, keepInstruction: true };
  }
  if (mine.status === 'failed') {
    return { phase: 'failed', task: mine, buttonLabel: '重新发送', buttonDisabled: false, keepInstruction: true };
  }
  return { phase: 'done', task: mine, buttonLabel: '发送修改要求', buttonDisabled: false, keepInstruction: false };
}

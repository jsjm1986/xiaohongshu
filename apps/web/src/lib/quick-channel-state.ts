export type QuickTab = 'project' | 'topic' | 'config' | 'result' | 'history';

export interface QuickReachabilityInput {
  hasProject: boolean;
  opportunityCount: number;
  hasOpportunity: boolean;
  resultCount: number;
}

export function tabReachable(input: QuickReachabilityInput): Record<QuickTab, boolean> {
  return {
    project: true,
    topic: input.opportunityCount > 0,
    config: input.hasOpportunity,
    result: input.resultCount > 0,
    history: input.hasProject,
  };
}

export function clearDownstreamOfProject() {
  return { opportunities: [] as never[], opportunityId: '' as const, results: [] as never[] };
}

export function clearResults() {
  return { results: [] as never[] };
}

export type QuickStepState = 'done' | 'current' | 'active' | 'locked';

export interface StepStatusInput {
  activeTab: QuickTab;
  hasProject: boolean;
  opportunityCount: number;
  hasOpportunity: boolean;
  resultCount: number;
}

export function stepStatus(input: StepStatusInput): Record<QuickTab, QuickStepState> {
  const reachable = tabReachable(input);
  // 每个标签「是否已完成其产出」:完成度沿链条判定
  const completed: Record<QuickTab, boolean> = {
    project: input.hasProject,
    topic: input.opportunityCount > 0,
    config: input.hasOpportunity,
    result: input.resultCount > 0,
    history: false,
  };
  const order: QuickTab[] = ['project', 'topic', 'config', 'result', 'history'];
  const out = {} as Record<QuickTab, QuickStepState>;
  for (const tab of order) {
    if (tab === input.activeTab) out[tab] = 'current';
    else if (!reachable[tab]) out[tab] = 'locked';
    else if (completed[tab]) out[tab] = 'done';
    else out[tab] = 'active';
  }
  return out;
}

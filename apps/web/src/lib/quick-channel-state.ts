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

export type QuickZone = 'prepare' | 'create' | 'history';
export type CreateStep = 'topic' | 'config' | 'result';
export type CreateStepState = 'done' | 'current' | 'active' | 'locked';

export function initialZone(input: { opportunityCount: number }): QuickZone {
  return input.opportunityCount > 0 ? 'create' : 'prepare';
}

export function zoneReachable(input: { hasProject: boolean; opportunityCount: number }): Record<QuickZone, boolean> {
  return {
    prepare: true,
    create: input.opportunityCount > 0,
    history: input.hasProject,
  };
}

export interface CreateStepInput {
  opportunityCount: number;
  hasOpportunity: boolean;
  resultCount: number;
}

export function createStepReachable(input: CreateStepInput): Record<CreateStep, boolean> {
  return {
    topic: input.opportunityCount > 0,
    config: input.hasOpportunity,
    result: input.resultCount > 0,
  };
}

export interface CreateStepStatusInput extends CreateStepInput {
  activeStep: CreateStep;
}

export function createStepStatus(input: CreateStepStatusInput): Record<CreateStep, CreateStepState> {
  const reachable = createStepReachable(input);
  const completed: Record<CreateStep, boolean> = {
    topic: input.hasOpportunity,
    config: input.resultCount > 0,
    result: false,
  };
  const order: CreateStep[] = ['topic', 'config', 'result'];
  const out = {} as Record<CreateStep, CreateStepState>;
  for (const step of order) {
    if (step === input.activeStep) out[step] = 'current';
    else if (!reachable[step]) out[step] = 'locked';
    else if (completed[step]) out[step] = 'done';
    else out[step] = 'active';
  }
  return out;
}

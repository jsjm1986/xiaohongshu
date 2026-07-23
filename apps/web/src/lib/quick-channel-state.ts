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

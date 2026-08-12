import {
  isNonOverridableContentIssueCode,
  NON_OVERRIDABLE_CONTENT_ISSUE_CODES,
} from '@content-agent/agent-core/delivery-policy';
import type { CandidateValidation, CandidateValidationIssue } from '../types';

export type DeliveryReadiness = 'publishable' | 'human_reviewable' | 'blocked';

/**
 * 浏览器端的交付门禁直接消费 agent-core 的权威白名单(零 node 依赖子路径)。
 * 这里曾是 29 个 code 的手抄副本,靠一行注释与领域层对齐——agent-core 每新增
 * 一个硬门禁 code,web 不知道它就会照常解锁复制,被阻断内容从前端出口漏走。
 * re-export 仅为兼容既有引用;新代码直接从 agent-core 导入。
 */
export const NON_OVERRIDABLE_DELIVERY_ISSUE_CODES: ReadonlySet<string> = NON_OVERRIDABLE_CONTENT_ISSUE_CODES;

export function issueOverridePolicy(issue: CandidateValidationIssue): 'not_required' | 'human_reviewable' | 'non_overridable' {
  if (issue.code && isNonOverridableContentIssueCode(issue.code)) return 'non_overridable';
  if (issue.disposition === 'advisory' && issue.severity !== 'error') return 'not_required';
  return 'human_reviewable';
}

export function deliveryReadiness(
  validation?: CandidateValidation,
  realization?: { generationMode?: string; deliverability?: string },
): DeliveryReadiness {
  if (realization?.generationMode === 'deterministic_preview' || realization?.deliverability === 'non_deliverable') return 'blocked';
  // Missing validation is a damaged/unfinished payload, not a historical review finding.
  if (!validation) return 'blocked';
  const issues = validation.issues ?? [];
  if (issues.some((issue) => issueOverridePolicy(issue) === 'non_overridable')) return 'blocked';
  // A formal model artifact is immediately deliverable. Review findings remain
  // visible but no longer require an acknowledgement click to unlock output.
  return 'publishable';
}

export function candidateDeliverable(
  validation: CandidateValidation | undefined,
  _manuallyConfirmed: boolean,
  realization?: { generationMode?: string; deliverability?: string },
): boolean {
  return deliveryReadiness(validation, realization) === 'publishable';
}

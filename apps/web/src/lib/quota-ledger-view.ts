/**
 * 额度流水的展示口径(纯函数,组件只做渲染)。
 *
 * 两个诚实性约束:
 * 1. reason 未登记时降级显示原始标识符,不消失也不猜译;
 * 2. 流水表自 2026-08-13(schema v29)起记账,更早的用量真实发生过但
 *    没有逐笔凭证——余额与流水对不上时必须把差额讲明,而不是让客户
 *    以为账本有鬼。
 */

export interface QuotaLedgerItem {
  id: number;
  delta: number;
  balanceAfter: number;
  reason: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}

export interface QuotaLedgerResponse {
  month: string | null;
  consumed: number;
  refunded: number;
  net: number;
  items: QuotaLedgerItem[];
}

const REASON_COPY: Record<string, string> = {
  generation_enqueue: '内容生成',
  generation_settle_refund: '生成结算退回',
  revision_charge: '按意见修改',
  revision_settle_refund: '修改结算退回',
  job_delete_revision_refund: '删除任务退回',
  provider_outage_refund: '服务中断退回',
  analysis_charge: '知识库分析',
  analysis_refund: '分析退回',
  analysis_failure_refund: '分析失败退回',
  analysis_reclaim_refund: '分析中断退回',
  harness_enqueue: '素人创作',
  harness_failure_refund: '素人创作失败退回',
  harness_reclaim_refund: '素人创作中断退回',
  harness_delete_refund: '素人创作删除退回',
  harness_review_retry_charge: '素人复核重试',
  harness_review_retry_rollback: '素人复核重试回滚',
  project_delete_refund: '删除项目退回',
  workspace_delete_refund: '删除工作区退回',
};

/** reason → 中文;未登记降级显示原始标识符(新扣款类型出现时不消失)。 */
export function ledgerReasonLabel(reason: string): string {
  return REASON_COPY[reason] ?? reason;
}

/** 一条流水的展示行。delta>0 是扣款,<0 是退回(与数据库口径一致)。 */
export function ledgerItemView(item: QuotaLedgerItem): {
  label: string;
  amount: string;
  isRefund: boolean;
  date: string;
  balance: number;
} {
  const isRefund = item.delta < 0;
  return {
    label: ledgerReasonLabel(item.reason),
    amount: isRefund ? `+${-item.delta}` : `-${item.delta}`,
    isRefund,
    date: item.createdAt.slice(0, 16).replace('T', ' '),
    balance: item.balanceAfter,
  };
}

/**
 * 余额与流水的差额说明。quotaUsed 是权威余额(扣退都改它),流水净额是
 * 逐笔凭证之和;流水上线前的历史用量导致 quotaUsed > net 时,差额必须
 * 明说来源。反向(net > quotaUsed)按数据异常提示,不粉饰。
 */
export function preLedgerNote(quotaUsed: number, ledgerNet: number): string | null {
  const gap = quotaUsed - ledgerNet;
  if (gap === 0) return null;
  if (gap > 0) return `其中 ${gap} 次发生在用量流水上线（2026-08-13）之前，无逐笔明细。`;
  return `流水净额比当前用量多 ${-gap} 次，请联系管理员核对。`;
}

import { validationIssueLabel } from './validation-labels';

/**
 * 校验结论分级。
 *
 * 起因是实测:129 个未通过候选里,110 个(85%)`firstValidationIssueLabel` 取到的
 * 首条是 warning。截图里就是这样——8 个 error 中挑出一条 warning「正文长度偏离样本
 * 形态目标」当结论,真正的「敏感宣称缺证据」被折叠进「另有 9 项」。用户按显示的那条
 * 去改,改完还是不能导出。
 *
 * 原因是旧实现按数组顺序取首个可识别 code,而 issues 数组本身不按严重度排序。
 * 这里把 error 与 warning 分开:error 永远在前,同级按出现次数降序。
 */

export interface VerdictItem {
  code?: string;
  /** 中文说明;code 不可识别时是原始 code(不猜译、不丢) */
  label: string;
  count: number;
}

export interface IssueVerdict {
  publishable: boolean;
  /** 必须处理才能导出的项(severity=error) */
  blocking: VerdictItem[];
  /** 可人工核对后使用的项(severity=warning) */
  advisory: VerdictItem[];
  /** 一句话结论:有 error 时必然是 error 那条 */
  headline: string;
}

export interface VerdictInput {
  valid?: boolean;
  issues?: Array<{ code?: string; severity?: string; message?: string }>;
}

function group(items: Array<{ code?: string; message?: string }>): VerdictItem[] {
  const byKey = new Map<string, VerdictItem>();
  for (const item of items) {
    // 同一 code 出现多次要合并计数(实测单个候选里 sensitive_claim_without_evidence
    // 能出现 4 次),否则清单里同一句话重复四遍。
    const key = item.code ?? `msg:${item.message ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    // 不可识别的 code 保留原文,连 code 都没有时退到系统原文 message。
    const label = validationIssueLabel(item.code) ?? item.code ?? item.message ?? '未说明的校验项';
    byKey.set(key, { code: item.code, label, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

export function issueVerdict(validation?: VerdictInput): IssueVerdict {
  const issues = validation?.issues ?? [];
  const blocking = group(issues.filter((i) => i.severity === 'error'));
  const advisory = group(issues.filter((i) => i.severity !== 'error'));
  // publishable 认后端的 valid,不自己按 error 数推断:后端可能因为别的原因判不通过。
  const publishable = validation?.valid === true;

  let headline: string;
  if (blocking.length > 0) {
    headline = blocking[0]!.label;
  } else if (publishable) {
    headline = advisory.length > 0
      ? `已通过可发布校验，另有 ${advisory.length} 项建议人工核对`
      : '已通过可发布校验';
  } else if (advisory.length > 0) {
    // 没有 error 却仍未通过:如实说明,不假装是某条 warning 导致的。
    headline = `未通过可发布校验，${advisory.length} 项待人工核对`;
  } else {
    headline = '未通过可发布校验，系统未给出具体项';
  }

  return { publishable, blocking, advisory, headline };
}

/** 导出/发布门槛的一句话理由;可发布时返回 null。 */
export function exportBlockReason(verdict: IssueVerdict): string | null {
  if (verdict.publishable) return null;
  if (verdict.blocking.length > 0) {
    return `有 ${verdict.blocking.length} 项必须处理的问题，未通过校验的稿子不能导出为 DOCX/PDF/JSON，可先导出 Markdown 人工核对`;
  }
  return '未通过可发布校验，不能导出为 DOCX/PDF/JSON，可先导出 Markdown 人工核对';
}

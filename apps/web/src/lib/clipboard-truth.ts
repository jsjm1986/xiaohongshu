import {
  candidateQualityStatusLabel,
  resolveCandidateQualityStatus,
} from '@content-agent/agent-core/delivery-policy';

export interface ClipboardValidation {
  valid?: boolean;
  qualityStatus?: unknown;
  issues?: readonly { code?: string }[];
}

const NEEDS_REVIEW_STATUS_TEXT =
  `validation.qualityStatus：${candidateQualityStatusLabel('needs_review')}`;
export const NEEDS_REVIEW_CLIPBOARD_HEADER = `【${NEEDS_REVIEW_STATUS_TEXT}】`;

/**
 * 所有剪贴板出口的统一包装。passed 保持原文可直接使用；needs_review 必须把
 * 状态带出界面；blocked 即使调用方门禁失效也拒绝生成剪贴板载荷。
 */
export function candidateClipboardText(
  validation: ClipboardValidation | undefined,
  content: string,
): string {
  const qualityStatus = resolveCandidateQualityStatus(validation);
  if (qualityStatus === 'blocked') {
    throw new Error(candidateQualityStatusLabel('blocked'));
  }
  if (
    qualityStatus === 'needs_review'
    && content.trimStart().slice(0, NEEDS_REVIEW_STATUS_TEXT.length + 4).includes(NEEDS_REVIEW_STATUS_TEXT)
  ) {
    return content;
  }
  return qualityStatus === 'needs_review'
    ? `${NEEDS_REVIEW_CLIPBOARD_HEADER}\n\n${content}`
    : content;
}

export function clipboardPostSectionLabel(
  validation: ClipboardValidation | undefined,
): string {
  return resolveCandidateQualityStatus(validation) === 'passed'
    ? '正文区（可直接使用）'
    : '正文区（建议复核后使用）';
}

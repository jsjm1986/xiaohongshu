/**
 * 生成结果的交付状态只认服务端 validation.valid。
 * 全部候选失败时仍保留候选与诊断，但不得把任何草稿当成成品正文展示。
 */
export interface DeliveryCandidate {
  validation?: { valid?: boolean; issues?: Array<{ severity?: string }> };
}

export interface GenerationDeliveryState {
  deliverableCount: number;
  rejectedCount: number;
  hasCandidates: boolean;
  allRejected: boolean;
}

export function generationDeliveryState(candidates: DeliveryCandidate[] | undefined): GenerationDeliveryState {
  const list = candidates ?? [];
  const deliverableCount = list.filter((candidate) => candidate.validation?.valid === true).length;
  return {
    deliverableCount,
    rejectedCount: list.length - deliverableCount,
    hasCandidates: list.length > 0,
    allRejected: list.length > 0 && deliverableCount === 0,
  };
}

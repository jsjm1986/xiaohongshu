import { deliveryReadiness } from './delivery-readiness';

/** Delivery is permissive for formal model artifacts; only the shared
 * mechanical hard-gate allowlist remains non-deliverable. */
export interface DeliveryCandidate {
  generationMode?: string;
  artifactRealization?: { deliverability?: string };
  validation?: { valid?: boolean; qualityStatus?: 'passed' | 'needs_review' | 'blocked'; issues?: any[] };
}

export interface GenerationDeliveryState {
  deliverableCount: number;
  rejectedCount: number;
  hasCandidates: boolean;
  allRejected: boolean;
}

export function generationDeliveryState(candidates: DeliveryCandidate[] | undefined): GenerationDeliveryState {
  const list = candidates ?? [];
  const deliverableCount = list.filter((candidate) => deliveryReadiness(candidate.validation as never, {
    generationMode: candidate.generationMode,
    deliverability: candidate.artifactRealization?.deliverability,
  }) === 'publishable').length;
  return {
    deliverableCount,
    rejectedCount: list.length - deliverableCount,
    hasCandidates: list.length > 0,
    allRejected: list.length > 0 && deliverableCount === 0,
  };
}

import { createHash } from "node:crypto";

const contract = {
  id: "agentic-creative-harness",
  version: "2.3.0",
  analysisProtocol: "fixed-search-read-submit-review-v4",
  toolPolicy: "fixed-four-stage-v4",
  outputContract: "complete-publishing-package-and-execution-plan-v4",
  reviewPolicy: "checkpointed-merged-review-and-directed-revision-v4",
  validationPolicy: "agent-harness-integrity-execution-asset-and-claim-audit-v5",
} as const;

/** Immutable methodology identity frozen into every Agent Harness job. */
export const AGENT_HARNESS_PROFILE = Object.freeze({
  ...contract,
  digest: createHash("sha256").update(JSON.stringify(contract), "utf8").digest("hex"),
});

import { createHash } from "node:crypto";

const contract = {
  id: "agentic-creative-harness",
  version: "2.11.0",
  analysisProtocol: "search-deterministic-read-narrative-path-draft-per-candidate-package-review-v9",
  toolPolicy: "fixed-three-tools-six-model-calls-v9",
  outputContract: "grounded-narrative-path-frozen-editorial-package-v11",
  reviewPolicy: "checkpointed-exception-review-and-directed-revision-v6",
  validationPolicy: "agent-harness-grounded-bridge-and-narrative-diversity-v10",
} as const;

/** Immutable methodology identity frozen into every Agent Harness job. */
export const AGENT_HARNESS_PROFILE = Object.freeze({
  ...contract,
  digest: createHash("sha256").update(JSON.stringify(contract), "utf8").digest("hex"),
});

import type { GenerateInput } from "../types";

export type PublishingTopologyDraft = {
  topology: "institution_owned" | "confirmed_individual_author";
  factStatement: string;
  factCategory: NonNullable<GenerateInput["authorContext"]>["facts"][number]["category"];
  confirmedBy: string;
  confirmedAt: string;
};

export const DEFAULT_PUBLISHING_TOPOLOGY_DRAFT: PublishingTopologyDraft = {
  topology: "institution_owned",
  factStatement: "",
  factCategory: "current_state",
  confirmedBy: "",
  confirmedAt: "",
};

/**
 * Freeze the task-level account topology before config preview or generation.
 * Project knowledge never populates authorContext: individual-author mode only
 * accepts the human-entered fact carried by this form.
 */
export function applyPublishingTopology(
  input: GenerateInput,
  draft: PublishingTopologyDraft,
): GenerateInput {
  if (draft.topology === "institution_owned") {
    return {
      ...input,
      publishingTopology: "institution_owned",
      authorContext: { status: "not_provided", facts: [] },
    };
  }

  const statement = draft.factStatement.trim();
  const confirmedBy = draft.confirmedBy.trim();
  const timestamp = Date.parse(draft.confirmedAt);
  if (!statement) throw new Error("个人作者模式必须填写一条已确认的作者事实");
  if (!confirmedBy) throw new Error("个人作者模式必须填写确认人");
  if (!draft.confirmedAt || !Number.isFinite(timestamp)) throw new Error("个人作者模式必须填写有效的确认时间");

  return {
    ...input,
    publishingTopology: "confirmed_individual_author",
    authorContext: {
      status: "confirmed",
      facts: [{
        id: "author_fact_1",
        statement,
        category: draft.factCategory,
        confirmedBy,
        confirmedAt: new Date(timestamp).toISOString(),
      }],
    },
  };
}

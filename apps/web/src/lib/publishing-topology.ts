import type { GenerateInput } from "../types";

export type AuthorFactCategory = NonNullable<GenerateInput["authorFacts"]>[number]["category"];

export type AuthorFactDraft = {
  id: string;
  statement: string;
  category: AuthorFactCategory;
  /** AI 整理时保留的原始素材片段；不进入生成请求。 */
  sourceQuote?: string;
  needsReview?: boolean;
  reviewReason?: string;
};

export type SimplePublishingTopology = "creative_scenario" | "institution_owned";

export type PublishingTopologyDraft = {
  topology: "creative_scenario" | "institution_owned" | "confirmed_individual_author";
  /** Natural-language source owned by the user. It is never submitted as a fact. */
  narrative: string;
  facts: AuthorFactDraft[];
  confirmed: boolean;
  /** AI 整理提示，仅用于当前表单，不进入生成请求。 */
  warnings?: string[];
};

export const emptyAuthorFact = (index = 0): AuthorFactDraft => ({
  id: `author_fact_${index + 1}`,
  statement: "",
  category: "current_state",
});

export const createDefaultPublishingTopologyDraft = (): PublishingTopologyDraft => ({
  topology: "creative_scenario",
  narrative: "",
  facts: [],
  confirmed: false,
});

export const DEFAULT_PUBLISHING_TOPOLOGY_DRAFT = createDefaultPublishingTopologyDraft();

export const createSimplePublishingTopologyDraft = (
  topology: SimplePublishingTopology,
): PublishingTopologyDraft => ({
  ...createDefaultPublishingTopologyDraft(),
  topology,
});

/**
 * Build the request-side truth contract. Confirmation identity and time are
 * intentionally absent: the API freezes those from the authenticated principal.
 */
export function applyPublishingTopology(
  input: GenerateInput,
  draft: PublishingTopologyDraft,
): GenerateInput {
  if (draft.topology !== "confirmed_individual_author") {
    return {
      ...input,
      publishingTopology: draft.topology,
      authorFacts: [],
      authorFactsConfirmed: false,
      authorContext: undefined,
    };
  }

  const facts = draft.facts.map((fact, index) => ({
    id: fact.id.trim() || `author_fact_${index + 1}`,
    statement: fact.statement.trim(),
    category: fact.category,
  })).filter((fact) => fact.statement);
  if (!facts.length) throw new Error("个人作者模式必须至少填写一条原子作者事实");
  if (facts.length !== draft.facts.length) throw new Error("请删除空白作者事实，或填写完整后再确认");
  if (new Set(facts.map((fact) => fact.id)).size !== facts.length) throw new Error("作者事实编号不能重复");
  if (!draft.confirmed) throw new Error("请确认这些事实真实且可公开使用");

  return {
    ...input,
    publishingTopology: "confirmed_individual_author",
    authorFacts: facts,
    authorFactsConfirmed: true,
    authorContext: undefined,
  };
}

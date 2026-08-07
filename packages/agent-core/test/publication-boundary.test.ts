import { describe, expect, it } from "vitest";
import {
  buildKnowledgeLedger,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  findSupportingSectionEvidenceIds,
  indexKnowledgeSource,
  organizationNamePublicationRestricted,
  parseGenerationDraft,
  publicationRestrictionsFromText,
  redactPublicationRestrictedText,
  redactRestrictedProjectIdentity,
  selectKnowledgeContext,
  validateGenerationDraft,
} from "../src/index.js";

const project = { id: "p", name: "项目", domain: "服务", productPoints: [], organizationPoints: [], cities: [], doctors: [] };

function draft(body: string) {
  return parseGenerationDraft(JSON.stringify({
    content: {
      H: { hashtags: ["面诊"] },
      N: { imageBrief: "中性说明画面", title: "到院前先问清楚", body },
      Cref: { disclaimer: "以下为模拟评论参考模板，不代表真实互动。", threads: [] },
    },
    evidenceIds: [], reasoning: [], unknowns: [],
  }));
}

describe("non-public source boundary", () => {
  it("extracts internal clauses and removes their source lines before copy writing", () => {
    const source = "公开地址：锦华万达附近\n| 机构全称不对外公开（内部须知） |\n公开流程：先评估再沟通";
    expect(publicationRestrictionsFromText(source)).toContain("机构全称不对外公开");
    const redacted = redactPublicationRestrictedText(source);
    expect(redacted).toContain("公开地址");
    expect(redacted).toContain("公开流程");
    expect(redacted).not.toContain("机构全称不对外公开");
  });

  it("removes only the restricted clause when public facts share the same source line", () => {
    const source = "机构定位：专注眼周年轻化，机构类型为门诊；机构全称不对外公开（内部须知）；地址：成都锦江区锦华万达附近。";
    const redacted = redactPublicationRestrictedText(source);
    expect(redacted).toContain("专注眼周年轻化");
    expect(redacted).toContain("机构类型为门诊");
    expect(redacted).toContain("成都锦江区锦华万达附近");
    expect(redacted).not.toContain("机构全称不对外公开");
    expect(redacted).not.toContain("内部须知");
  });


  it("redacts both the configured project name and a shared public alias only in writer projections", () => {
    const restriction = "机构全称不得对外公开";
    expect(organizationNamePublicationRestricted(restriction)).toBe(true);
    const projected = redactRestrictedProjectIdentity({
      projectName: "星零感眼袋（7.28）",
      product: "星零感微孔去眼袋",
      publicFact: "地址在锦华万达附近",
    }, "星零感眼袋（7.28）", restriction);
    expect(JSON.stringify(projected)).not.toContain("星零感");
    expect(projected).toMatchObject({
      projectName: "本机构",
      product: "本机构微孔去眼袋",
      publicFact: "地址在锦华万达附近",
    });
  });

  it("binds the public remainder of a compound answer to a section even when the source also carries a governance clause", () => {
    const source = "机构类型为门诊，专注眼周年轻化，地址在成都锦江区锦华万达附近；机构全称不对外公开（内部须知）。";
    const document = indexKnowledgeSource({ projectId: "p", id: "org", path: "org.md", content: source });
    const selection = selectKnowledgeContext({
      documents: [document],
      query: "机构类型 地址",
      budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    const publicAnswer = redactPublicationRestrictedText(source);
    expect(publicAnswer).not.toContain("机构全称不对外公开");
    expect(findSupportingSectionEvidenceIds([publicAnswer], selection)).toHaveLength(1);
  });

  it("blocks a restricted internal clause if it still reaches any visible channel", () => {
    const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
    config.content.bodyMinChars = 2;
    config.content.hashtagMin = 1;
    config.content.commentThreadMin = 0;
    config.content.commentThreadMax = 1;
    const issues = validateGenerationDraft({
      draft: draft("地址在锦华万达附近，机构全称不对外公开。"),
      config,
      ledger: buildKnowledgeLedger([]),
      allowedEvidenceIds: ["ev"],
      evidenceSources: { ev: "机构全称不对外公开（内部须知）" },
      evidenceReferences: [{
        id: "ev", documentId: "d", path: "facts.md", kind: "fact", evidenceStatus: "observed",
        scope: [], caveats: [], publicationRestrictions: ["机构全称不对外公开"],
      }],
    });
    expect(issues).toContainEqual(expect.objectContaining({
      code: "restricted_source_content_visible", severity: "error", disposition: "block",
    }));
  });
});

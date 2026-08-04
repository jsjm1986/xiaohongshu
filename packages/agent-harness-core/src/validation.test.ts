import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_SEEDING_MODE, type HarnessSeedingMode } from "./methods.js";
import type { HarnessCandidate, HarnessCommentThread } from "./types.js";
import { validateHarnessCandidates } from "./validation.js";

/**
 * 只为评论区拓扑测试服务的最小线程。
 *
 * 不复用 runner.test.ts 那份完整 fixture:那份为了跑通全链路把每个字段都填满了,
 * 在这里会让「哪个字段导致报错」变得看不出来。这里只填拓扑相关字段,其余给空值,
 * 断言时按 issue code 过滤,不看总数。
 */
function thread(overrides: Partial<HarnessCommentThread> & { id: string }): HarnessCommentThread {
  return {
    threadKind: "org_answer", displayName: "路人甲", replyDisplayName: "",
    question: "这个多久能好", answer: "大概两周",
    followUps: [], clarification: "", nextStep: "", boundary: "",
    stopReason: "answered", postingIdentity: "publisher", evidenceIds: [],
    ...overrides,
  };
}

/** 一条结构完整的机构答疑:四个字段齐全。 */
function orgThread(id: string, identity: HarnessCommentThread["postingIdentity"] = "staff"): HarnessCommentThread {
  return thread({
    id, postingIdentity: identity,
    clarification: "个体差异不能一概而论", nextStep: "到院面诊评估", boundary: "不构成医疗建议",
    stopReason: "professional_review",
  });
}

/** 博主本人以素人身份回复:不带那四个字段。 */
function authorThread(id: string, question: string, answer: string): HarnessCommentThread {
  return thread({ id, postingIdentity: "author", question, answer });
}

function readerExchange(id: string): HarnessCommentThread {
  return thread({
    id, threadKind: "reader_exchange", replyDisplayName: "路人乙",
    question: "我也卡在这一步", answer: "对,我准备先去问问",
    stopReason: "no_new_gap",
  });
}

function organicReaction(id: string): HarnessCommentThread {
  return thread({
    id, threadKind: "organic_reaction", question: "先码住",
    answer: "", stopReason: undefined,
  });
}

/**
 * 只取评论拓扑相关的 issue code,避免被无关必填项的报错干扰。
 *
 * 候选必须填到「不抛异常」为止:validateHarnessCandidates 会无条件解引用
 * revisionNotes / content / citations / assetDecisions,给纯空对象会 TypeError,
 * 那样测的就不是拓扑了。这些字段留空字符串,报错自然落在别的 code 上被过滤掉。
 */
function codesOf(threads: HarnessCommentThread[], seedingMode?: "peer_seeding" | "brand_voice"): string[] {
  const candidate = {
    candidateIndex: 0, concept: "", revisionNotes: { instructionApplied: [], preservedElements: [] },
    citations: [], assetDecisions: [],
    content: {
      N: {
        coverHeadline: "", coverSubheadline: "", imageBrief: "", title: "", body: "",
        callToAction: "", imageSequence: [],
      },
      H: { hashtags: [] },
      Cref: { ownedFirstComment: "", disclaimer: "模拟问答参考，不代表真实互动", threads },
      publishing: { entryPoint: "", accountIdentity: "", timingNote: "", interactionGoal: "" },
    },
  } as unknown as HarnessCandidate;
  return validateHarnessCandidates([candidate], [], new Set<string>(), {
    ...(seedingMode ? { seedingMode } : {}),
  }).filter((issue) => issue.candidateIndex === 0).map((issue) => issue.code);
}

/*
  素人代发种草模式。默认开(peer_seeding),因为这个通道的实际用途就是给真人素人
  账号起草代发内容;brand_voice 保留原有的机构口吻严格校验。
*/
describe("素人代发种草模式", () => {
  it("默认模式是素人代发", () => {
    const mode: HarnessSeedingMode = DEFAULT_HARNESS_SEEDING_MODE;
    expect(mode).toBe("peer_seeding");
  });

  it("peer_seeding:2 条博主回复 + 1 接话 + 1 短反应 → 拓扑合格", () => {
    const codes = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      readerExchange("t3"),
      organicReaction("t4"),
    ], "peer_seeding");
    expect(codes, `不该报拓扑错误：${codes.join(",")}`).not.toContain("comment_topology");
  });

  it("peer_seeding:0 条博主回复 → comment_topology 报错", () => {
    const codes = codesOf([
      orgThread("t1"), orgThread("t2"), readerExchange("t3"), organicReaction("t4"),
    ], "peer_seeding");
    expect(codes, "素人模式下没有博主回复必须报错").toContain("comment_topology");
  });

  it("peer_seeding:博主回复缺 boundary/nextStep 不报错", () => {
    const codes = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      readerExchange("t3"), organicReaction("t4"),
    ], "peer_seeding");
    for (const code of ["missing_thread_boundary", "missing_thread_next_step", "missing_thread_clarification", "missing_thread_stop_reason"]) {
      expect(codes, `博主素人回复不该要求 ${code}`).not.toContain(code);
    }
  });

  it("peer_seeding:机构身份线程仍必须带边界与下一步", () => {
    /*
     * 这条是防止「素人模式」被当成万能借口:机构一开口就得带边界,
     * 否则模型会用 staff 身份说机构话、又省掉所有约束。
     */
    const bare = thread({ id: "t2", postingIdentity: "staff" });
    const codes = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"), bare,
      readerExchange("t3"), organicReaction("t4"),
    ], "peer_seeding");
    expect(codes, "机构身份缺边界必须报错").toContain("missing_thread_boundary");
    expect(codes, "机构身份缺下一步必须报错").toContain("missing_thread_next_step");
  });

  it("brand_voice:现状不变,2 条机构答疑合格且博主回复不计入", () => {
    const ok = codesOf([orgThread("t1"), orgThread("t2"), readerExchange("t3"), organicReaction("t4")], "brand_voice");
    expect(ok, `品牌模式下 2 条机构答疑应合格：${ok.join(",")}`).not.toContain("comment_topology");
    const authorOnly = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      readerExchange("t3"), organicReaction("t4"),
    ], "brand_voice");
    expect(authorOnly, "品牌模式下博主回复不能替代机构答疑").toContain("comment_topology");
  });

  it("THREAD_SCHEMA 不再强制四个机构字段:只改校验会被 schema 假绿", () => {
    /*
     * 这四个键留在 required 里的话,模型必须为每条博主回复编出「可核验的下一步」
     * 和「停止原因」——校验放宽了也没用,产出照旧是客服话术。
     * brand_voice 的强制性由 validation.ts 的 accountable 分支保证,不靠 schema。
     *
     * 用源码断言而非行为断言:schema 是喂给模型的常量,单测里没有模型可跑。
     */
    const source = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
    const match = source.match(/const THREAD_SCHEMA = \{[\s\S]*?required: \[([^\]]+)\]/u);
    expect(match, "没解析到 THREAD_SCHEMA 的 required 数组").toBeTruthy();
    const required = match![1]!;
    for (const key of ["clarification", "nextStep", "stopReason", "boundary"]) {
      expect(required, `${key} 仍在 THREAD_SCHEMA.required 里,模型仍会被逼着输出它`).not.toContain(`"${key}"`);
    }
    // properties 里必须保留,否则模型连想填都填不了
    for (const key of ["clarification", "nextStep", "stopReason", "boundary"]) {
      expect(source, `${key} 从 properties 里被误删`).toMatch(new RegExp(`${key}: \\{`, "u"));
    }
  });
});

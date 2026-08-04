import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_SEEDING_MODE, HARNESS_SIMULATION_NOTICE, type HarnessSeedingMode } from "./methods.js";
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
function codesOf(threads: HarnessCommentThread[], seedingMode?: "peer_seeding" | "brand_voice", body = ""): string[] {
  const candidate = {
    candidateIndex: 0, concept: "", revisionNotes: { instructionApplied: [], preservedElements: [] },
    citations: [], assetDecisions: [],
    content: {
      N: {
        coverHeadline: "", coverSubheadline: "", imageBrief: "", title: "", body,
        callToAction: "", imageSequence: [],
      },
      H: { hashtags: [] },
      Cref: { ownedFirstComment: "", threads },
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

  it("peer_seeding:恰好 1 条博主回复 → comment_topology 报错", () => {
    /*
     * 边界用例,钉住 `authorReplies < 2` 里的那个 2。
     *
     * 「至少 2 条博主本人回复」是本次改动的核心数字:1 条博主回复配 1 条机构答疑
     * 仍然是机构主导的评论区,不是素人自己在回帖。只测 0 条和 2 条时,把阈值降成
     * `< 1` 也能全绿 —— 那等于这个数字根本没被测到。
     */
    const codes = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      orgThread("t2"), readerExchange("t3"), organicReaction("t4"),
    ], "peer_seeding");
    expect(codes, "素人模式下只有 1 条博主回复必须报错").toContain("comment_topology");
  });

  it("brand_voice:恰好 1 条机构答疑 → comment_topology 报错", () => {
    /* 同上,钉住 `accountableAnswers < 2` 里的那个 2。author 身份不计入机构答疑。 */
    const codes = codesOf([
      orgThread("t1"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      readerExchange("t3"), organicReaction("t4"),
    ], "brand_voice");
    expect(codes, "品牌模式下只有 1 条机构答疑必须报错").toContain("comment_topology");
  });

  it("brand_voice:author 身份线程也必须带四个字段", () => {
    /*
     * 钉住 `accountable` 里的 `peerSeeding &&` 守卫。
     *
     * 去掉那个守卫后,author 身份在**任何**模式下都不再被要求带边界 ——
     * brand_voice 就此丢掉了它声称守住的诚实边界:模型只要把机构答疑标成
     * author 身份,四项约束全部消失。这条线程本身要让拓扑合格(另配 2 条 staff
     * 机构答疑),否则报错会落在 comment_topology 上,断言不到真正要测的码。
     */
    const bareAuthor = thread({ id: "t3", postingIdentity: "author" });
    const codes = codesOf([
      orgThread("t1"), orgThread("t2"), bareAuthor,
      readerExchange("t4"), organicReaction("t5"),
    ], "brand_voice");
    expect(codes, "品牌模式下 author 身份缺边界必须报错").toContain("missing_thread_boundary");
    expect(codes, "品牌模式下 author 身份缺下一步必须报错").toContain("missing_thread_next_step");
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

/*
  模拟提示语的归属:它是给操盘手看的标注,不是交付内容。
*/
describe("模拟提示语不进交付字段", () => {
  it("交付结构不再有 disclaimer 字段,校验不因此报错", () => {
    /*
     * disclaimer 原先是交付字段,由模型每次生成,于是那句「模拟问答参考」会跟着
     * 评论正文一起被粘到小红书评论区里——读者看到的是一句对他毫无意义的内部标注。
     * 字段删掉后,旧的 comment_disclaimer ERROR 也必须消失,否则每个候选都恒定阻断。
     */
    const codes = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      readerExchange("t3"),
      organicReaction("t4"),
    ], "peer_seeding");
    expect(codes, "comment_disclaimer 应已删除").not.toContain("comment_disclaimer");
  });

  it("模拟提示语作为常量存在,不由模型生成", () => {
    /*
     * 写成常量而非模型输出:界面固定显示、导出固定携带,不会因为模型这次漏写就消失,
     * 诚实性披露因此比原来更稳,只是不再是可粘贴的内容。
     */
    expect(HARNESS_SIMULATION_NOTICE).toMatch(/模拟/u);
    expect(HARNESS_SIMULATION_NOTICE).toMatch(/不是|不代表/u);
  });

  it("schema、组装与提示词都不再产出 disclaimer", () => {
    /*
     * 源码断言:schema 的 required 少了这个键、组装时不再读它、提示词也不再要求
     * 模型复述那句话。三处任一残留都会让这句标注以另一种形式回到交付物里,而单测
     * 里没有模型可跑,只能直接看喂给模型的常量。
     *
     * 只匹配代码形态(带引号的键、属性访问、`键:`),不匹配裸词——否则解释这次改动
     * 的注释本身会把测试搞红,反而逼人把 WHY 从源码里删掉。
     */
    const runner = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
    expect(runner, 'disclaimer 仍在 schema 的 required 里').not.toMatch(/"disclaimer"/u);
    expect(runner, "组装 Cref 时仍在读 cref.disclaimer").not.toMatch(/cref\.disclaimer/u);
    expect(runner, "disclaimer 仍是 schema 的一个属性").not.toMatch(/disclaimer: \{/u);
    expect(runner, "提示词仍在要求模型把披露语写进评论里").not.toMatch(/模拟问答参考，不代表真实互动/u);
    const types = readFileSync(new URL("./types.ts", import.meta.url), "utf8");
    expect(types, "types.ts 的交付结构仍留着 disclaimer 字段").not.toMatch(/disclaimer: string/u);
  });
});

/** 只为正文措辞测试服务:把待测句子放进正文,评论区给一套合格拓扑,免得拓扑报错混进来。 */
function codesForBody(body: string, seedingMode: "peer_seeding" | "brand_voice"): string[] {
  return codesOf([
    authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
    authorThread("t2", "价格多少", "看方案，5k到1w"),
    readerExchange("t3"),
    organicReaction("t4"),
  ], seedingMode, body);
}

/*
  第一人称措辞分两支:营销化的伪造口碑,和朴素的时间线叙述。原先一条正则同时管两类。
*/
describe("第一人称措辞按模式分叉", () => {
  it("peer_seeding:朴素时间线叙述允许", () => {
    /*
     * 「我做完两天了」是真人自然叙述,不是营销话术。内容由真人素人账号发布、
     * 经历真实,AI 只是代笔起草,所以素人模式放开这一支。
     * 实测 67 篇语料里这一支命中 13 篇(19%),原规则会把它们全判死。
     */
    const codes = codesForBody("我做完两天了，确实不肿。", "peer_seeding");
    expect(codes, `素人模式不该拦时间线叙述：${codes.join(",")}`).not.toContain("fabricated_experience");
  });

  it("peer_seeding:模拟读者的问题、接话和追问始终不能伪造体验时间线", () => {
    const placements: HarnessCommentThread[] = [
      readerExchange("question"),
      readerExchange("answer"),
      readerExchange("follow-up"),
    ];
    placements[0]!.question = "我同事上个月做了，第三天就不肿了。";
    placements[1]!.answer = "我朋友做完两天就恢复了。";
    placements[2]!.followUps = [{ kind: "follow_up", question: "我姐妹刚做完也是这样吗？", answer: "我家人术后很快就好了。" }];

    for (const leaked of placements) {
      const codes = codesOf([
        authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
        authorThread("t2", "价格多少", "看方案，5k到1w"),
        leaked,
        organicReaction("t4"),
      ], "peer_seeding");
      expect(codes).toContain("fabricated_experience");
    }
  });

  it("peer_seeding:机构账号答复不能借作者豁免伪装顾客经历", () => {
    const institution = orgThread("institution", "staff");
    institution.answer = "我朋友做完两天就恢复了。";
    const codes = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      readerExchange("t3"),
      organicReaction("t4"),
      institution,
    ], "peer_seeding");
    expect(codes).toContain("fabricated_experience");
  });

  it("brand_voice:时间线叙述仍然阻断", () => {
    const codes = codesForBody("我做完两天了，确实不肿。", "brand_voice");
    expect(codes, "品牌口吻下机构不能假装自己是顾客").toContain("fabricated_experience");
  });

  it("营销口碑话术两种模式都阻断", () => {
    for (const mode of ["peer_seeding", "brand_voice"] as const) {
      const codes = codesForBody("亲测有效，真实顾客都说好。", mode);
      expect(codes, `${mode} 下「亲测」必须阻断`).toContain("fabricated_experience");
    }
  });

  it("peer_seeding:模拟读者被编造经历仍然阻断 —— 放开的只是博主自己的时间线", () => {
    /*
     * 这条守住规格里的另半句:发布账号可以说自己「做完两天」,虚构读者不能被安排成
     * 「我同事上个月做了」。两者都命中 FIRST_PERSON_TIMELINE,区别只在谁在说 ——
     * 所以判断必须按文本来源分区,不能拿整段可见文本一刀切。
     */
    const codes = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      { ...readerExchange("t3"), question: "我同事上个月做了，第三天就不肿了。" },
      organicReaction("t4"),
    ], "peer_seeding");
    expect(codes).toContain("fabricated_experience");
  });

  it("peer_seeding:博主自己讲时间线不阻断,同一句话换成模拟读者说就阻断", () => {
    // 同一字符串,只换说话人 —— 直接证明判据是「谁在说」而不是「说了什么」。
    const line = "我刚做完第三天，肿得还没消。";
    const asAuthor = codesOf([
      { ...authorThread("t1", "恢复几天了？", line) },
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      readerExchange("t3"), organicReaction("t4"),
    ], "peer_seeding");
    expect(asAuthor).not.toContain("fabricated_experience");

    const asReader = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      { ...readerExchange("t3"), answer: line },
      organicReaction("t4"),
    ], "peer_seeding");
    expect(asReader).toContain("fabricated_experience");
  });
});

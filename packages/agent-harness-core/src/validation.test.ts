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
function minimalCandidate(threads: HarnessCommentThread[], body = "", hashtags: string[] = []): HarnessCandidate {
  return {
    candidateIndex: 0, concept: "", revisionNotes: { instructionApplied: [], preservedElements: [] },
    citations: [], assetDecisions: [],
    content: {
      N: {
        coverHeadline: "", coverSubheadline: "", imageBrief: "", title: "", body,
        callToAction: "", imageSequence: [],
      },
      H: { hashtags },
      Cref: { ownedFirstComment: "", threads },
      publishing: { entryPoint: "", accountIdentity: "", timingNote: "", interactionGoal: "" },
    },
  } as unknown as HarnessCandidate;
}

function codesOf(threads: HarnessCommentThread[], seedingMode?: "peer_seeding" | "brand_voice", body = ""): string[] {
  return validateHarnessCandidates([minimalCandidate(threads, body)], [], new Set<string>(), {
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

  it("peer_seeding:reader_exchange 谎报 author 身份也不能借豁免", () => {
    /*
     * schema 对 threadKind 与 postingIdentity 是独立约束的(runner.ts:87-96 两个
     * 平行 enum,不做交叉校验),15 种组合都合法;而 runner.ts:633 那句提示词还明写
     * reader_exchange 的 postingIdentity「仅供显示」——等于告诉模型这个字段随便填。
     * 所以「reader_exchange 且身份为 author」是模型真能产出的组合。
     *
     * 时间线豁免只认「org_answer + author」这一对。少了 kind 判断,虚构读者
     * 只要把身份标成 author 就能说「我朋友做完两天就恢复了」,那正是伪造社会
     * 证明——这条测试钉住那个 kind 守卫。
     */
    const fake: HarnessCommentThread = {
      ...readerExchange("t3"), postingIdentity: "author", answer: "我朋友做完两天就恢复了",
    };
    const codes = codesOf([
      authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
      authorThread("t2", "价格多少", "看方案，5k到1w"),
      fake, organicReaction("t4"),
    ], "peer_seeding");
    expect(codes).toContain("fabricated_experience");
  });
});

/*
  标签里的品牌词。67 篇真实语料无一篇标签带品牌名,全是品类词加城市词。
*/
describe("标签禁品牌词", () => {
  /** 一套合格拓扑,免得拓扑报错混进断言。 */
  const okThreads = (): HarnessCommentThread[] => [
    authorThread("t1", "是哪个白白哦？", "老朱，朱冠锋呀"),
    authorThread("t2", "价格多少", "看方案，5k到1w"),
    readerExchange("t3"),
    organicReaction("t4"),
  ];

  function issuesForHashtags(hashtags: string[], seedingMode: HarnessSeedingMode, projectName?: string) {
    return validateHarnessCandidates([minimalCandidate(okThreads(), "", hashtags)], [], new Set<string>(), {
      seedingMode, ...(projectName === undefined ? {} : { projectName }),
    });
  }

  it("peer_seeding:标签含项目名给 WARNING", () => {
    const issues = issuesForHashtags(["#成都眼袋", "#星零感微孔去眼袋"], "peer_seeding", "星零感微孔去眼袋");
    const branded = issues.filter((issue) => issue.code === "brand_hashtag");
    expect(branded.length, JSON.stringify(issues)).toBe(1);
    expect(branded[0]?.severity, "品牌词必须是 WARNING：项目名可能含通用品类词，硬拦会误伤").toBe("warning");
  });

  it("peer_seeding:品牌词标签不阻断导出", () => {
    /*
     * 「不阻断」= 没有因此多出任何 error。这里的最小候选本身就缺一堆必填项、
     * 恒定带一批无关 error,所以不能断言「一条 error 都没有」;改成和不带品牌词
     * 的同一候选比对 error 集合 —— 差集为空才叫这次检查没升级成阻断项。
     */
    const clean = issuesForHashtags(["#成都眼袋"], "peer_seeding", "星零感微孔去眼袋");
    const branded = issuesForHashtags(["#成都眼袋", "#星零感微孔去眼袋"], "peer_seeding", "星零感微孔去眼袋");
    const errorCodes = (issues: readonly { code: string; severity: string }[]) =>
      [...new Set(issues.filter((issue) => issue.severity === "error").map((issue) => issue.code))].sort();
    expect(errorCodes(branded), "标签带品牌词不该新增任何 error").toEqual(errorCodes(clean));
  });

  it("peer_seeding:标签只有品类词与城市词不报品牌词", () => {
    const issues = issuesForHashtags(["#成都眼袋", "#眼袋泪沟", "#变美日记"], "peer_seeding", "星零感微孔去眼袋");
    expect(issues.map((issue) => issue.code), JSON.stringify(issues)).not.toContain("brand_hashtag");
  });

  it("brand_voice:标签含项目名不报警,机构自己发就该带品牌", () => {
    const issues = issuesForHashtags(["#星零感微孔去眼袋"], "brand_voice", "星零感微孔去眼袋");
    expect(issues.map((issue) => issue.code), JSON.stringify(issues)).not.toContain("brand_hashtag");
  });

  it("没传项目名时跳过该检查", () => {
    /* 判据只有项目名,拿不到就不猜 —— 不维护关键词表。 */
    const issues = issuesForHashtags(["#星零感微孔去眼袋"], "peer_seeding");
    expect(issues.map((issue) => issue.code), JSON.stringify(issues)).not.toContain("brand_hashtag");
  });

  it("项目名是空白时跳过该检查,不把每条标签都标成品牌词", () => {
    /*
     * 钉住守卫里的 `.trim()`,它不是顺手整理空白而是必要条件:
     * 项目名为 "" 或纯空格时 `tag.includes("")` 对任何字符串都为真,
     * 于是**每一条**标签都会收到一条 brand_hashtag —— 一个名字填空的项目
     * 会让整个标签区变成一片噪声警告。
     *
     * 用两条毫不相干的标签,把「误报」和「恰好命中」彻底分开:它们与任何
     * 真实项目名都无关,报出来只可能是空串匹配所致。
     */
    for (const blank of ["", "   "]) {
      const issues = issuesForHashtags(["#成都眼袋", "#变美日记"], "peer_seeding", blank);
      const branded = issues.filter((issue) => issue.code === "brand_hashtag");
      expect(branded, `项目名为 ${JSON.stringify(blank)} 时不该报品牌词：${JSON.stringify(branded)}`).toEqual([]);
    }
  });
});

/*
  两个调用点与提示词的一致性。这一组是源码断言:被测对象是「喂给校验器的参数」和
  「喂给模型的常量」,单测里既跑不到 service 的运行时,也没有模型可跑。
*/
describe("生产路径把模式真的传下去", () => {
  /*
   * 只截 validateHarnessCandidates 那一次调用的参数块,不整文件 grep。
   *
   * 必要而非讲究:service 里 seedingMode 出现在三处(校验调用、runAgentHarness、
   * reviewHarnessCandidates),整文件 grep 时把校验调用里那个删掉测试照旧是绿的 ——
   * 而那正是本任务要防的分叉。断言必须落在参数块内才咬得住。
   */
  function validatorCallBlock(source: string): string {
    // 锚在赋值那一行而不是 lastIndexOf:后者只是「碰巧文件里最后一次出现」,
    // 将来任一文件多出一处调用(哪怕在注释或类型里),截出来的就不是被测的那一次。
    const start = source.indexOf("const issues = validateHarnessCandidates(");
    expect(start, "没找到 `const issues = validateHarnessCandidates(` 这次调用").toBeGreaterThan(-1);
    const end = source.indexOf("});", start);
    expect(end, "没找到调用的参数块结尾").toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("两个调用点都传了同一套 seedingMode,不能只改一处", () => {
    /*
     * validateHarnessCandidates 有两个调用点:runner(生成时)和 service(断点恢复读结果时)。
     * 只改一处的后果是同一份候选在两条路上判定不同——界面说合格、导出却被拦,极难查。
     * 实测既有缺陷:service 此前漏传 bodyLength,导致长度检查静默按 medium 判。
     *
     * 断言到**值**而不只是键:只查键名时,service 里写死 `seedingMode: 'brand_voice'`
     * 照样能过 —— 而这条测试的全部意义就是两处判定标准一致。
     */
    const runnerSource = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
    const serviceSource = readFileSync(
      new URL("../../../apps/api/src/agent-harness.service.ts", import.meta.url), "utf8");
    const runnerBlock = validatorCallBlock(runnerSource);
    const serviceBlock = validatorCallBlock(serviceSource);
    for (const [label, block] of [["runner", runnerBlock], ["service", serviceBlock]] as const) {
      expect(block, `${label} 的校验调用没有传 projectName`).toMatch(/projectName: \w+\.project\.name/u);
      expect(block, `${label} 的校验调用没有传 bodyLength`).toMatch(/bodyLength: \w+\.task\.bodyLength/u);
      expect(block, `${label} 的校验调用没有把模式落到 DEFAULT_HARNESS_SEEDING_MODE`)
        .toMatch(/seedingMode: (?:input\.seedingMode \?\? )?DEFAULT_HARNESS_SEEDING_MODE/u);
    }
    // runner 那处要尊重调用方显式指定的模式,service 那处没有调用方可尊重。
    expect(runnerBlock, "runner 丢掉了调用方显式指定的模式").toContain("input.seedingMode ??");
  });

  it("提示词区分博主本人与模拟读者:博主可讲自己时间线,读者不许编经历", () => {
    /*
     * 原提示词有一句禁止模拟读者提到「治疗/到访/朋友案例/恢复天数/结果/购买」。
     * 素人代发下博主本人恰恰要说「两个月了」「我刚做完」,所以这句必须区分主体:
     * 博主(author)可以讲自己的时间线,模拟读者仍不许编造自己的经历。
     * 不区分的话,这个模式会变成「谁都能编」——那是真的造假,不是代笔。
     */
    const source = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
    const start = source.indexOf("const PEER_SEEDING_GUIDANCE = [");
    expect(start, "找不到素人指引常量").toBeGreaterThan(-1);
    /*
     * 只截常量本身,不切到文件末尾:末尾还有一句原有指引带着 "simulated reader voice",
     * 切到 EOF 时把素人指引最后那条划界句删掉,断言照旧能命中那句原文 —— 测试就成了假绿。
     */
    const peerBlock = source.slice(start, source.indexOf("] as const;", start));
    expect(peerBlock, "素人指引没有点明博主身份").toMatch(/author/u);
    /*
     * 断言必须咬住「划界」本身,不能只查 "simulated reader" 出没出现过 ——
     * 实测:这个常量里另有两条顺带提到 simulated reader(「读者问了博主再答」
     * 「读者可以问是哪位医生」),所以把最后那条划界句整条删掉,宽泛的
     * /simulated reader/ 照旧命中,测试假绿。变异验证就是这么发现的。
     *
     * 改为分别钉住两个半句:博主可以讲自己的经历、模拟读者仍不许编造自己的经历。
     * 少了后半句,这个模式就从「代笔」滑成「谁都能编」。
     */
    expect(peerBlock, "素人指引没写明博主可以讲自己的经历").toMatch(/publisher may describe their own experience/u);
    expect(peerBlock, "素人指引没把模拟读者排除在豁免之外").toMatch(/simulated reader still may not invent/u);
  });

  it("拓扑那两句按模式分叉,peer_seeding 必须点名 author 身份", () => {
    /*
     * 这一条盯的是本任务真正修掉的生产故障,不是文案偏好:
     * 解析器把缺省 postingIdentity 落到 `publisher`(runner.ts 的 postingIdentity 归一),
     * 而校验层 peer_seeding 要求 ≥2 条 `author` 回复。提示词若仍照原文要求
     * 「2-3 条机构答疑」且从不点名 `author`,模型就会全部产出 publisher,
     * 于是默认模式下每次实跑都因「0 条博主回复」撞 comment_topology —— 比改动前更严。
     *
     * 同时钉住 brand_voice 那两句逐字不变:换模式不该动机构口吻的既有契约。
     */
    const source = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
    const start = source.indexOf("const COMMENT_TOPOLOGY_GUIDANCE = {");
    expect(start, "找不到按模式分叉的拓扑指引").toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("} as const;", start));
    const brandVoice = block.slice(block.indexOf("brand_voice:"), block.indexOf("peer_seeding:"));
    const peerSeeding = block.slice(block.indexOf("peer_seeding:"));

    expect(peerSeeding, "peer_seeding 的拓扑句没点名 author 身份，模型会全部漏填成 publisher")
      .toMatch(/postingIdentity 'author'/u);
    expect(peerSeeding, "peer_seeding 仍在要求 2-3 条机构答疑，与校验层的博主回复要求矛盾")
      .not.toMatch(/2-3 org_answer threads,/u);
    expect(peerSeeding, "peer_seeding 仍把四段式写成无条件必须")
      .toMatch(/clarification, verifiable next step and boundary are optional/u);

    /*
     * 「逐字保留」按整句比对,不是抓两个中间片段。
     *
     * 原先只 includes 两个句中片段,于是两句的句尾都没人管:实测把
     * 「4-6」改成「3-7」、把「these names never imply real accounts」
     * 反转成「may imply real accounts」,测试照旧全绿 —— 后者紧邻伪造边界。
     * 整句相等才是这条断言名字所声称的东西。
     */
    expect(brandVoiceLines(brandVoice), "brand_voice 那两句必须逐字保留原文").toEqual(BRAND_VOICE_TOPOLOGY_LINES);
  });
});

/*
 * brand_voice 拓扑两句的原文,取自本次改动前的 runner.ts,作为回归基线。
 * 它们的作用是「不许动」,所以写成整句字面量而不是片段。
 */
const BRAND_VOICE_TOPOLOGY_LINES = [
  "Create 4-6 Cref threads per candidate as a small uneven comment section, not 4-6 FAQs. Mix all three threadKind values: 2-3 org_answer threads, at least 1 reader_exchange, and at least 1 organic_reaction. Give simulated readers short display-only nicknames; these names never imply real accounts.",
  "org_answer is a residual reader question answered by an accountable publishing identity. It follows: direct answer -> optional follow-up or counterexample only when a concrete new condition appears -> clarification -> verifiable next step -> explicit stopReason. Keep the visible answer compact; audit fields may be fuller.",
] as const;

/** 从源码块里取出 brand_voice 那两条字符串字面量的完整内容。 */
function brandVoiceLines(brandVoiceBlock: string): string[] {
  return [...brandVoiceBlock.matchAll(/^\s*"((?:[^"\\]|\\.)*)",$/gmu)].map((match) => match[1]!);
}

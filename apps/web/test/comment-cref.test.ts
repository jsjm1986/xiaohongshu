import assert from "node:assert/strict";
import test from "node:test";
import {
  auditAnswerAttribution,
  commentNodeKindLabel,
  commentThreadKindLabel,
  commentThreadKindOf,
  deploymentSla,
  liveRoutingLine,
  liveRoutingLines,
  postingIdentityText,
  uncoveredGapLabels,
} from "../src/lib/comment-cref";
import { candidateToMarkdown } from "../src/lib/utils";
import type { Candidate } from "../src/types";

test("comment node kind labels cover the v1.1 kinds and pass through unknown values", () => {
  assert.equal(commentNodeKindLabel("question"), "问题");
  assert.equal(commentNodeKindLabel("answer"), "回答");
  assert.equal(commentNodeKindLabel("follow_up"), "追问");
  assert.equal(commentNodeKindLabel("clarification"), "澄清");
  assert.equal(commentNodeKindLabel("custom_kind"), "custom_kind");
  assert.equal(commentNodeKindLabel(undefined), "未标注");
});

test("posting identity text marks publisher as the publishing account and keeps historical values", () => {
  assert.equal(postingIdentityText("publisher"), "发布账号（publisher）");
  assert.equal(postingIdentityText("author"), "author");
  assert.equal(postingIdentityText("staff"), "staff");
  assert.equal(postingIdentityText(undefined), "");
});

test("live routing lines render structured, legacy and historical string forms without undefined", () => {
  assert.equal(
    liveRoutingLine({ route: "项目事实类问题", condition: "知识库已有已批准口径", action: "由发布账号引用已批准口径答复" }),
    "项目事实类问题（知识库已有已批准口径） → 由发布账号引用已批准口径答复",
  );
  assert.equal(
    liveRoutingLine({ route: "个体结论类问题", condition: "", action: "转人工渠道" }),
    "个体结论类问题 → 转人工渠道",
  );
  assert.equal(
    liveRoutingLine({ intent: "价格咨询", target: "人工客服", reason: "动态信息" }),
    "价格咨询 → 人工客服：动态信息",
  );
  assert.equal(liveRoutingLine("历史字符串路由"), "历史字符串路由");
  assert.equal(liveRoutingLine({} as never), "");

  const lines = liveRoutingLines([
    { route: "事实类", condition: "有口径", action: "引用口径" },
    "历史字符串",
    { intent: "旧意图", target: "旧去向" },
  ]);
  assert.deepEqual(lines, [
    "事实类（有口径） → 引用口径",
    "历史字符串",
    "旧意图 → 旧去向",
  ]);
  assert.ok(lines.every((line) => !line.includes("undefined")));
  assert.deepEqual(liveRoutingLines(undefined), []);
});

test("deployment sla prefers the v1.1 field and falls back to the historical alias", () => {
  assert.equal(deploymentSla({ sla: "24h 内答复", responseSla: "历史时效" }), "24h 内答复");
  assert.equal(deploymentSla({ responseSla: "历史时效" }), "历史时效");
  assert.equal(deploymentSla({}), undefined);
});

test("uncovered gap labels resolve via planning cards and keep unresolved ids raw", () => {
  const cards = [
    {
      gapId: "gap_price",
      label: "价格区间",
      question: "多少钱",
      category: "decision",
      audienceStages: [],
      importance: 0.8,
      decisionLeverage: 0.7,
      proofability: 0.9,
      required: true,
      priority: "required" as const,
      evidenceIds: [],
      plannedPlacements: [],
    },
  ];
  assert.deepEqual(uncoveredGapLabels(["gap_price", "gap_unknown"], cards), ["价格区间", "gap_unknown"]);
  assert.deepEqual(uncoveredGapLabels([], cards), []);
  assert.deepEqual(uncoveredGapLabels(undefined, cards), []);
});

const baseCandidate: Candidate = {
  id: "candidate",
  title: "标题",
  body: "正文",
  tags: [],
  comments: [
    {
      question: "恢复期多久？",
      answer: "因人而异，以面诊为准。",
      simulated: true,
      simulationLabel: "模拟潜在读者情景",
      postingIdentity: "staff",
    },
  ],
};

test("candidate markdown renders v1.1 Cref and aC fields when present", () => {
  const candidate: Candidate = {
    ...baseCandidate,
    commentOwnedFirstComment: "置顶说明：价格以当期确认为准。",
    commentUncoveredGaps: ["gap_aftercare"],
    orchestrationSnapshot: {
      gapPlanningCards: [
        {
          gapId: "gap_aftercare",
          label: "术后护理",
          question: "怎么护理",
          category: "decision",
          audienceStages: [],
          importance: 0.6,
          decisionLeverage: 0.6,
          proofability: 0.6,
          required: false,
          priority: "standard",
          evidenceIds: [],
          plannedPlacements: [],
        },
      ],
    },
    comments: [
      {
        question: "大概多少钱？",
        answer: "我做的时候是这个区间，以当期确认为准。",
        simulated: true,
        simulationLabel: "模拟潜在读者情景",
        postingIdentity: "publisher",
        kind: "question",
        answerKind: "answer",
        boundary: "价格以当期确认为准",
        evidenceIds: ["evidence_price_1"],
        followUps: [
          {
            question: "能优惠吗？",
            answer: "不清楚，要问当期的顾问。",
            kind: "follow_up",
            boundary: "不代承诺优惠",
            evidenceIds: ["evidence_faq_2"],
          },
        ],
      },
    ],
    deploymentPlan: {
      postingIdentity: "publisher",
      ownedFirstComment: true,
      sla: "工作日 24h 内答复真实评论",
      liveRouting: [
        { route: "项目事实类问题", condition: "知识库已有已批准口径", action: "由发布账号引用已批准口径答复" },
        { route: "个体结论类问题", condition: "需要个人条件", action: "转专业/人工渠道处理" },
      ],
      updatePolicy: ["新高频问题进入更新队列"],
      stopRules: ["无法核验时不代填答案"],
    },
  };
  const markdown = candidateToMarkdown(candidate);
  assert.match(markdown, /可发布首评参考】由发布账号（publisher）身份发布：置顶说明/u);
  assert.match(markdown, /本篇未展开缺口（规划期投影，非遗漏错误）：术后护理/u);
  assert.match(markdown, /答复身份：发布账号（publisher）/u);
  assert.match(markdown, /节点类型：提问=问题；答复=回答/u);
  assert.match(markdown, /答复边界：价格以当期确认为准/u);
  assert.match(markdown, /证据引用：evidence_price_1/u);
  assert.match(markdown, /接话节点类型：追问/u);
  assert.match(markdown, /接话边界：不代承诺优惠/u);
  assert.match(markdown, /接话证据引用：evidence_faq_2/u);
  assert.match(markdown, /发布身份：发布账号（publisher）/u);
  assert.match(markdown, /答复时效：工作日 24h 内答复真实评论/u);
  assert.match(markdown, /真实评论路由：项目事实类问题（知识库已有已批准口径） → 由发布账号引用已批准口径答复/u);
  assert.match(markdown, /更新政策：新高频问题进入更新队列/u);
  assert.ok(!markdown.includes("undefined"));
});

test("candidate markdown for historical packages keeps the previous shape", () => {
  const markdown = candidateToMarkdown({
    ...baseCandidate,
    deploymentPlan: {
      postingIdentity: "staff",
      ownedFirstComment: false,
      liveRouting: ["历史字符串路由"],
      updateTriggers: ["知识库证据变化"],
      stopRules: ["不得伪装消费者"],
    },
  });
  assert.match(markdown, /答复身份：staff/u);
  assert.match(markdown, /真实评论路由：历史字符串路由/u);
  assert.doesNotMatch(markdown, /可发布首评参考/u);
  assert.doesNotMatch(markdown, /本篇未展开缺口/u);
  assert.doesNotMatch(markdown, /节点类型/u);
  assert.doesNotMatch(markdown, /答复时效/u);
  assert.doesNotMatch(markdown, /更新政策/u);
  assert.ok(!markdown.includes("undefined"));
});

test("candidate markdown for v1.1 packages uses the two-part executive + audit layout", () => {
  const candidate: Candidate = {
    ...baseCandidate,
    imageBrief: "一张自然光下的术前咨询照片",
    commentOwnedFirstComment: "置顶说明：价格以当期确认为准。",
    commentUncoveredGaps: ["gap_aftercare"],
    orchestrationSnapshot: {
      gapPlanningCards: [
        {
          gapId: "gap_aftercare",
          label: "术后护理",
          question: "怎么护理",
          category: "decision",
          audienceStages: [],
          importance: 0.6,
          decisionLeverage: 0.6,
          proofability: 0.6,
          required: false,
          priority: "standard",
          evidenceIds: [],
          plannedPlacements: [],
        },
      ],
    },
    comments: [
      {
        question: "大概多少钱？",
        answer: "我做的时候是这个区间，以当期确认为准。",
        simulated: true,
        simulationLabel: "模拟潜在读者情景",
        postingIdentity: "publisher",
        kind: "question",
        answerKind: "answer",
        boundary: "价格以当期确认为准",
        evidenceIds: ["evidence_price_1"],
        nextStep: "面诊时向医生核验",
        densityProxy: { auxiliaryDimensionCount: 1, constraintCount: 1, questionTargetChars: 22 } as never,
        followUps: [
          {
            question: "能优惠吗？",
            answer: "不清楚，要问当期的顾问。",
            kind: "follow_up",
            boundary: "不代承诺优惠",
            evidenceIds: ["evidence_faq_2"],
          },
        ],
      },
    ],
    deploymentPlan: {
      postingIdentity: "publisher",
      ownedFirstComment: true,
      sla: "工作日 24h 内答复真实评论",
      liveRouting: [
        { route: "项目事实类问题", condition: "知识库已有已批准口径", action: "由发布账号引用已批准口径答复" },
      ],
      updatePolicy: ["新高频问题进入更新队列"],
      stopRules: ["无法核验时不代填答案"],
    },
  };
  const markdown = candidateToMarkdown(candidate);

  // Two-part structure: executive part first, audit appendix after the separator.
  const appendixIndex = markdown.indexOf("---\n\n# 审计附录（非发布素材）");
  assert.ok(appendixIndex > 0, "audit appendix separator must be present");
  const executive = markdown.slice(0, appendixIndex);
  const appendix = markdown.slice(appendixIndex);

  // Executive order: 发布内容 → 可发布首评参考 → 问答话术 → aC 运营规则.
  assert.ok(executive.indexOf("## 发布内容") >= 0);
  assert.ok(executive.indexOf("## 发布内容") < executive.indexOf("## 可发布首评参考"));
  assert.ok(executive.indexOf("## 可发布首评参考") < executive.indexOf("## 问答话术（模拟情景演练，非真实评论）"));
  assert.ok(executive.indexOf("## 问答话术（模拟情景演练，非真实评论）") < executive.indexOf("## aC · 评论运营规则"));

  // First comment is labelled as published by the publisher account.
  assert.match(executive, /可发布首评参考】由发布账号（publisher）身份发布：置顶说明/u);

  // Dialogue script keeps the four operator elements plus identity and follow-up pair.
  assert.match(executive, /- 提问：大概多少钱？/u);
  assert.match(executive, /- 回复：我做的时候是这个区间，以当期确认为准。/u);
  assert.match(executive, /- 答复边界：价格以当期确认为准/u);
  assert.match(executive, /- 下一步：面诊时向医生核验/u);
  assert.match(executive, /- 可追责答复身份：发布账号（publisher）/u);
  assert.match(executive, /- 追问：能优惠吗？/u);
  assert.match(executive, /- 补充：不清楚，要问当期的顾问。/u);

  // The executive part must be free of audit vocabulary / field names.
  for (const banned of [
    "密度代理", "discoveryPlan", "发现式路径", "后台答复库存", "证据引用",
    "evidenceIds", "节点类型", "信息闭合台账", "图片产物状态账本", "后台决策状态",
  ]) {
    assert.ok(!executive.includes(banned), `executive part must not contain audit term: ${banned}`);
  }

  // aC operating rules stay in the executive part.
  assert.match(executive, /答复时效：工作日 24h 内答复真实评论/u);
  assert.match(executive, /真实评论路由：项目事实类问题（知识库已有已批准口径） → 由发布账号引用已批准口径答复/u);
  assert.match(executive, /更新政策：新高频问题进入更新队列/u);
  assert.match(executive, /停止规则：无法核验时不代填答案/u);

  // The audit appendix keeps the full metadata trail.
  assert.match(appendix, /## 评论线程完整元数据/u);
  assert.match(appendix, /信息密度代理：1个主缺口＋1个辅助维度/u);
  assert.match(appendix, /证据引用：evidence_price_1/u);
  assert.match(appendix, /接话证据引用：evidence_faq_2/u);
  assert.match(appendix, /节点类型：提问=问题；答复=回答/u);
  assert.match(appendix, /本篇未展开缺口（规划期投影，非遗漏错误）：术后护理/u);
  assert.match(appendix, /### 图片产物状态账本/u);
  assert.ok(!markdown.includes("undefined"));
});

test("candidate markdown flips to the two-part layout on any single Cref v1.1 field", () => {
  const byBoundary = candidateToMarkdown({
    ...baseCandidate,
    comments: [{ question: "恢复期多久？", answer: "以面诊为准。", boundary: "个体条件不同" }],
  });
  assert.match(byBoundary, /# 审计附录（非发布素材）/u);
  assert.match(byBoundary, /## 问答话术（模拟情景演练，非真实评论）/u);
  assert.doesNotMatch(byBoundary, /## 可发布首评参考/u);

  const byEmptyProjection = candidateToMarkdown({ ...baseCandidate, commentUncoveredGaps: [] });
  assert.match(byEmptyProjection, /# 审计附录（非发布素材）/u);
});

test("thread kind helpers default to org_answer and label the three interaction forms", () => {
  assert.equal(commentThreadKindOf({}), "org_answer");
  assert.equal(commentThreadKindOf({ threadKind: "未知形态" }), "org_answer");
  assert.equal(commentThreadKindOf({ threadKind: "org_answer" }), "org_answer");
  assert.equal(commentThreadKindOf({ threadKind: "reader_exchange" }), "reader_exchange");
  assert.equal(commentThreadKindOf({ threadKind: "organic_reaction" }), "organic_reaction");
  assert.equal(commentThreadKindLabel("org_answer"), "机构问答");
  assert.equal(commentThreadKindLabel("reader_exchange"), "读者互聊");
  assert.equal(commentThreadKindLabel("organic_reaction"), "漂浮短反应");
  assert.equal(commentThreadKindLabel("custom_kind"), "custom_kind");
  assert.equal(commentThreadKindLabel(undefined), "机构问答");
});

test("candidate markdown formats reader-exchange and organic-reaction threads by kind, legacy threads unchanged", () => {
  const candidate: Candidate = {
    ...baseCandidate,
    commentOwnedFirstComment: "置顶说明：价格以当期确认为准。",
    comments: [
      {
        question: "我也在纠结要不要去面诊",
        answer: "姐妹我也是，主要怕恢复时间对不上",
        threadKind: "reader_exchange",
        displayName: "桃子气泡水",
        replyDisplayName: "熬夜的猫",
        simulated: true,
        simulationLabel: "模拟潜在读者情景",
        postingIdentity: "publisher",
      },
      {
        question: "蹲一个",
        answer: "历史脏答复不应导出",
        threadKind: "organic_reaction",
        displayName: "半糖去冰",
        simulated: true,
        simulationLabel: "模拟潜在读者情景",
        postingIdentity: "publisher",
        followUps: [{ question: "历史脏追问", answer: "历史脏回复", evidenceIds: [] }],
      },
      {
        question: "大概多少钱？",
        answer: "以当期确认为准。",
        simulated: true,
        simulationLabel: "模拟潜在读者情景",
        postingIdentity: "staff",
      },
    ],
  };
  const markdown = candidateToMarkdown(candidate);
  // T2 读者互聊:读者 B 接话结构,不用机构答复格式。
  assert.match(markdown, /读者接话：熬夜的猫：姐妹我也是，主要怕恢复时间对不上/u);
  assert.match(markdown, /互动类型：读者互聊/u);
  assert.match(markdown, /互动类型：读者互聊（桃子气泡水 → 熬夜的猫）/u);
  // T3 漂浮短反应:轻量单行,机构不出现。
  assert.match(markdown, /漂浮反应：半糖去冰：蹲一个/u);
  assert.match(markdown, /无需机构回复/u);
  assert.doesNotMatch(markdown, /历史脏答复|历史脏追问|历史脏回复/u);
  // 缺省 kind 的旧线程保持机构问答格式不变。
  assert.match(markdown, /- 回复：以当期确认为准。/u);
  assert.match(markdown, /可追责答复身份：staff/u);
  assert.ok(!markdown.includes("undefined"));
});

/**
 * 审计附录的答复归属。
 *
 * 回归目标是一条实测缺陷:附录此前无条件写「楼主/可追责身份回复」+「答复身份：
 * staff」,于是 reader_exchange 里另一位读者说的「同问，这个很关键」在导出物里
 * 被署成机构助理发言——把消费者的话挂到自有账号名下,正是方法论《ROLE 04》
 * 禁止的反向踩线。实测 198 条线程受影响,横跨 8 个项目。
 *
 * 数据本身是对的:replyDisplayName 带着接话人昵称,threadKind 标明形态。错只在
 * 附录挑错了字段。所以这里锁「同一份 markdown 内正文区与附录区口径一致」。
 */
test("审计附录:reader_exchange 的答复署模拟读者,不套机构身份", () => {
  const attribution = auditAnswerAttribution({
    threadKind: "reader_exchange",
    postingIdentity: "staff",
    replyDisplayName: "芒果糯米饭",
  });
  assert.equal(attribution.label, "模拟读者接话（芒果糯米饭）");
  assert.equal(attribution.identity, "不适用（读者互聊，非机构发言）");
  // 关键否证:附录里不能出现任何机构身份字样
  assert.ok(!attribution.identity.includes("staff"));
  assert.ok(!attribution.label.includes("可追责"));
});

test("审计附录:没有 replyDisplayName 时仍不冒充机构,只说读者接话", () => {
  const attribution = auditAnswerAttribution({ threadKind: "reader_exchange", postingIdentity: "expert" });
  assert.equal(attribution.label, "模拟读者接话");
  assert.equal(attribution.identity, "不适用（读者互聊，非机构发言）");
});

test("审计附录:org_answer 与 threadKind 缺失的历史包保持机构口径", () => {
  const org = auditAnswerAttribution({ threadKind: "org_answer", postingIdentity: "staff" });
  assert.equal(org.label, "楼主/可追责身份回复");
  assert.equal(org.identity, "staff");

  // 历史包没有 threadKind,按 org_answer 兜底——与其余判定同一套口径,行为不变。
  const legacy = auditAnswerAttribution({ postingIdentity: "publisher" });
  assert.equal(legacy.label, "楼主/可追责身份回复");
  assert.equal(legacy.identity, "发布账号（publisher）");

  // 身份缺失时仍要有个可读兜底,不能出 undefined
  const bare = auditAnswerAttribution({ threadKind: "org_answer" });
  assert.equal(bare.identity, "可追责发布者");
});

test("整份 markdown（v1.1 两段式）:读者互聊在正文区与审计附录里口径一致", () => {
  const candidate = {
    title: "泪沟三档怎么选",
    body: "问了三档报价。",
    tags: ["#成都医美"],
    imageBrief: "报价单随手拍",
    commentDisclaimer: "情景演练参考。",
    comments: [
      {
        question: "能保证两边对称吗？",
        answer: "同问，这个很关键。",
        threadKind: "reader_exchange",
        postingIdentity: "staff",
        displayName: "蹲一个答案",
        replyDisplayName: "芒果糯米饭",
        speakerType: "simulated_reader",
        simulated: true,
        // kind 让判定落到 v1.1 两段式布局(正文区 + 审计附录),
        // 这才是实测数据的形态——缺陷正是两段口径打架。
        kind: "question",
        answerKind: "answer",
        followUps: [],
      },
    ],
  } as unknown as Candidate;

  const markdown = candidateToMarkdown(candidate);
  // 正文区:早就是对的
  assert.match(markdown, /读者接话：芒果糯米饭：同问，这个很关键。/u);
  // 附录区:修好之后也署读者
  assert.match(markdown, /模拟读者接话（芒果糯米饭）：同问，这个很关键。/u);
  assert.match(markdown, /答复身份：不适用（读者互聊，非机构发言）/u);
  // 这两句是缺陷的原样:整份导出里不能再出现
  assert.ok(
    !markdown.includes("楼主/可追责身份回复：同问"),
    "读者接话不能被署成可追责身份回复",
  );
  assert.ok(!markdown.includes("答复身份：staff"), "读者互聊不能标机构身份");
  assert.ok(!markdown.includes("undefined"));
});

test("整份 markdown（legacy 单流）:审计段同样不把读者接话署成机构", () => {
  // 历史候选没有 v1.1 判据字段,走 legacy 单流布局——它只有审计段,
  // 没有分路正文区,所以修复必须同样覆盖它。
  const candidate = {
    title: "泪沟三档怎么选",
    body: "问了三档报价。",
    tags: ["#成都医美"],
    imageBrief: "报价单随手拍",
    comments: [
      {
        question: "能保证两边对称吗？",
        answer: "同问，这个很关键。",
        threadKind: "reader_exchange",
        postingIdentity: "staff",
        replyDisplayName: "芒果糯米饭",
        followUps: [],
      },
    ],
  } as unknown as Candidate;

  const markdown = candidateToMarkdown(candidate);
  assert.match(markdown, /模拟读者接话（芒果糯米饭）：同问，这个很关键。/u);
  assert.ok(!markdown.includes("楼主/可追责身份回复：同问"));
  assert.ok(!markdown.includes("答复身份：staff"));
});

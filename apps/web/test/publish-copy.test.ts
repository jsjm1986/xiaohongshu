import assert from "node:assert/strict";
import { test } from "node:test";
import { publishBlocks, publishOrderText, readerCandidateToMarkdown } from "../src/lib/publish-copy.ts";
import {
  ACCOUNTABLE_ANSWER_COPY_LABEL,
  SIMULATED_COMMENT_COPY_NOTICE,
  SIMULATED_QUESTION_COPY_LABEL,
  SIMULATED_REACTION_COPY_LABEL,
  SIMULATED_REPLY_COPY_LABEL,
} from "../src/lib/simulation-notice.ts";
import type { ReaderCandidate } from "../src/types.ts";

type Src = Parameters<typeof publishBlocks>[0];

function candidate(patch: Partial<ReaderCandidate> = {}): Src {
  return {
    title: "渗水能换班组吗",
    body: "卫生间墙角这两天渗水。\n给客服打了电话。",
    tags: ["#杭州装修", "保修"],
    imageBrief: "手机随手拍墙角",
    commentOwnedFirstComment: "补充一下保修范围：",
    comments: [
      { question: "谁来判定不合格", answer: "按合同由第三方验收", followUps: [] },
      { question: "换班组要加钱吗", answer: "不加，工期顺延", followUps: [] },
    ],
    ...patch,
  } as Src;
}

test("正文区一次贴完:标题、正文、标签", () => {
  const { post } = publishBlocks(candidate());
  assert.equal(post, "渗水能换班组吗\n\n卫生间墙角这两天渗水。\n给客服打了电话。\n\n#杭州装修 #保修");
});

test("标签统一带 # 且不重复加", () => {
  const { post } = publishBlocks(candidate());
  assert.ok(post.includes("#杭州装修 #保修"));
  assert.equal(post.includes("##"), false);
});

test("自备首评排评论区第一条,并标注本账号归属", () => {
  const { comments } = publishBlocks(candidate());
  assert.equal(comments[0], "【自备首评 · 本账号发布】\n补充一下保修范围：");
  assert.equal(comments.length, 3);
});

test("问答条目必须带角色标注:模拟提问勿代发,答复标明本账号参考", () => {
  const { comments } = publishBlocks(candidate({ commentOwnedFirstComment: undefined }));
  assert.equal(comments.length, 2);
  assert.equal(
    comments[0],
    `${SIMULATED_QUESTION_COPY_LABEL}\n谁来判定不合格\n${ACCOUNTABLE_ANSWER_COPY_LABEL}\n按合同由第三方验收`,
  );
});

test("读者互聊两侧都是模拟读者,接话不得标成本账号答复", () => {
  const { comments } = publishBlocks(candidate({
    commentOwnedFirstComment: undefined,
    comments: [
      { question: "我也在纠结这个", answer: "同感，我先等等看", threadKind: "reader_exchange", followUps: [] },
    ],
  } as Partial<ReaderCandidate>));
  assert.equal(
    comments[0],
    `${SIMULATED_QUESTION_COPY_LABEL}\n我也在纠结这个\n${SIMULATED_REPLY_COPY_LABEL}\n同感，我先等等看`,
  );
  assert.equal(comments[0]!.includes(ACCOUNTABLE_ANSWER_COPY_LABEL), false);
});

test("漂浮短反应整条只有模拟读者一句话,同样勿代发", () => {
  const { comments } = publishBlocks(candidate({
    commentOwnedFirstComment: undefined,
    comments: [
      { question: "蹲一个", answer: "", threadKind: "organic_reaction", followUps: [] },
    ],
  } as Partial<ReaderCandidate>));
  assert.equal(comments[0], `${SIMULATED_REACTION_COPY_LABEL}\n蹲一个`);
});

test("图片简报单独一块,不混进正文", () => {
  const { post, imageBrief } = publishBlocks(candidate());
  assert.equal(imageBrief, "手机随手拍墙角");
  assert.equal(post.includes("手机随手拍"), false);
});

test("没有标签时正文末尾不留空行", () => {
  const { post } = publishBlocks(candidate({ tags: [] }));
  assert.equal(post.endsWith("给客服打了电话。"), true);
});

test("整份文本按发布顺序分段,评论段自带模拟情景声明", () => {
  const text = publishOrderText(candidate());
  assert.ok(text.startsWith("—— 正文区（直接粘贴）——"));
  assert.ok(text.includes("—— 配图说明"));
  assert.ok(text.includes("—— 评论区话术参考（模拟情景 · 共 3 条）——"));
  assert.ok(text.includes(SIMULATED_COMMENT_COPY_NOTICE));
  assert.ok(text.includes("1. 【自备首评 · 本账号发布】"));
  assert.ok(text.includes(`3. ${SIMULATED_QUESTION_COPY_LABEL}\n换班组要加钱吗`));
  assert.equal(text.includes("发帖后按顺序贴"), false, "不得再出现指示代发评论的措辞");
  assert.equal(text.endsWith("\n"), false, "末尾不该留空行");
});

test("没有评论时不出现空的评论区标题与声明", () => {
  const text = publishOrderText(candidate({ comments: [], commentOwnedFirstComment: undefined }));
  assert.equal(text.includes("评论区"), false);
  assert.equal(text.includes(SIMULATED_COMMENT_COPY_NOTICE), false);
});

test("没有图片简报时不出现配图段", () => {
  const text = publishOrderText(candidate({ imageBrief: undefined }));
  assert.equal(text.includes("配图说明"), false);
});

test("与 Markdown 导出不同:不带 # 标题和 ## 小节标记", () => {
  const text = publishOrderText(candidate());
  assert.equal(text.includes("# 渗水能换班组吗"), false);
  assert.equal(text.includes("## "), false);
});

test("Markdown 归档同样带模拟情景声明与角色标注", () => {
  const md = readerCandidateToMarkdown({ ...candidate(), unknowns: [{ question: "保修年限？" }] } as Parameters<typeof readerCandidateToMarkdown>[0]);
  assert.ok(md.includes("## 评论区话术参考（模拟情景 · 非真实评论）"));
  assert.ok(md.includes(`> ${SIMULATED_COMMENT_COPY_NOTICE}`));
  assert.ok(md.includes("模拟提问（勿代发）: 谁来判定不合格"));
  assert.ok(md.includes("本账号答复参考: 按合同由第三方验收"));
  assert.ok(md.includes("## 自备首评（本账号发布）"));
  assert.equal(md.includes("## 评论区参考\n"), false, "旧的无标注小节名不得回归");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { publishBlocks, publishOrderText } from "../src/lib/publish-copy.ts";
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

test("自备首评排评论区第一条", () => {
  const { comments } = publishBlocks(candidate());
  assert.equal(comments[0], "补充一下保修范围：");
  assert.equal(comments.length, 3);
});

test("没有自备首评时评论区就是问答条数", () => {
  const { comments } = publishBlocks(candidate({ commentOwnedFirstComment: undefined }));
  assert.equal(comments.length, 2);
  assert.equal(comments[0], "【问】谁来判定不合格\n【答】按合同由第三方验收");
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

test("整份文本按发布顺序分段,并给出评论条数", () => {
  const text = publishOrderText(candidate());
  assert.ok(text.startsWith("—— 正文区（直接粘贴）——"));
  assert.ok(text.includes("—— 配图说明"));
  assert.ok(text.includes("—— 评论区（发帖后按顺序贴，共 3 条）——"));
  assert.ok(text.includes("1. 补充一下保修范围："));
  assert.ok(text.includes("3. 【问】换班组要加钱吗"));
  assert.equal(text.endsWith("\n"), false, "末尾不该留空行");
});

test("没有评论时不出现空的评论区标题", () => {
  const text = publishOrderText(candidate({ comments: [], commentOwnedFirstComment: undefined }));
  assert.equal(text.includes("评论区"), false);
});

test("没有图片简报时不出现配图段", () => {
  const text = publishOrderText(candidate({ imageBrief: undefined }));
  assert.equal(text.includes("配图说明"), false);
});

test("与 Markdown 导出不同:不带 # 标题和 ## 小节标记", () => {
  const text = publishOrderText(candidate());
  assert.equal(text.includes("# 渗水能换班组吗"), false);
  assert.equal(text.includes("## 问答话术"), false);
});

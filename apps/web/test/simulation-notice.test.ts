import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCOUNTABLE_ANSWER_COPY_LABEL,
  DRAFT_EXPORT_WATERMARK,
  labeledCommentCopy,
  SIMULATED_COMMENT_COPY_NOTICE,
  SIMULATED_QUESTION_COPY_LABEL,
  SIMULATED_REACTION_COPY_LABEL,
  SIMULATED_REPLY_COPY_LABEL,
} from "../src/lib/simulation-notice.ts";

// 出口层合规红线:模拟读者的发言离开界面时必须自带「勿代发」标注。
// 这组测试锁的是判定规则本身——它只由 threadKind 与节点位置决定。

test("提问侧永远是模拟读者:org_answer/host_reply/缺省线程都带勿代发标注", () => {
  for (const kind of ["org_answer", "host_reply", undefined, "unknown_future_kind"]) {
    assert.equal(
      labeledCommentCopy(kind, "question", "会反弹吗？"),
      `${SIMULATED_QUESTION_COPY_LABEL}\n会反弹吗？`,
      `threadKind=${kind}`,
    );
    assert.equal(
      labeledCommentCopy(kind, "follow_up_question", "恢复期多久？"),
      `${SIMULATED_QUESTION_COPY_LABEL}\n恢复期多久？`,
      `threadKind=${kind}`,
    );
  }
});

test("可追责答复按原文返回:那是本账号自己的话", () => {
  assert.equal(labeledCommentCopy("org_answer", "answer", "按合同由第三方验收"), "按合同由第三方验收");
  assert.equal(labeledCommentCopy("host_reply", "answer", "我现在还没定下来。"), "我现在还没定下来。");
  assert.equal(labeledCommentCopy(undefined, "follow_up_answer", "工期顺延。"), "工期顺延。");
});

test("读者互聊的接话是第二位模拟读者,必须带勿代发标注", () => {
  assert.equal(
    labeledCommentCopy("reader_exchange", "answer", "同感，我先等等看"),
    `${SIMULATED_REPLY_COPY_LABEL}\n同感，我先等等看`,
  );
  assert.equal(
    labeledCommentCopy("reader_exchange", "follow_up_answer", "我也还没敢定"),
    `${SIMULATED_REPLY_COPY_LABEL}\n我也还没敢定`,
  );
});

test("漂浮短反应整条都是模拟读者的话,任何节点都带标注", () => {
  assert.equal(
    labeledCommentCopy("organic_reaction", "question", "蹲一个"),
    `${SIMULATED_REACTION_COPY_LABEL}\n蹲一个`,
  );
  assert.equal(
    labeledCommentCopy("organic_reaction", "answer", "历史脏数据也不放行"),
    `${SIMULATED_REACTION_COPY_LABEL}\n历史脏数据也不放行`,
  );
});

test("声明与水印文案不得空置或弱化", () => {
  assert.ok(SIMULATED_COMMENT_COPY_NOTICE.includes("不得由任何账号代发"));
  assert.ok(SIMULATED_COMMENT_COPY_NOTICE.includes("不代表真实用户发言"));
  assert.ok(DRAFT_EXPORT_WATERMARK.includes("不得直接发布"));
  assert.ok(ACCOUNTABLE_ANSWER_COPY_LABEL.includes("真实提问"));
});

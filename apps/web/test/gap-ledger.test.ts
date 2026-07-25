import assert from "node:assert/strict";
import { test } from "node:test";
import { channelLabel, gapLedgerView } from "../src/lib/gap-ledger.ts";
import type { ReaderCandidate } from "../src/types.ts";

function candidate(patch: Partial<ReaderCandidate> = {}): Pick<ReaderCandidate, "gapLedger" | "gapCards"> {
  return {
    gapLedger: {
      realizationStatus: "evaluated",
      entries: [
        {
          gapId: "g-1",
          label: "班组更换",
          status: "realization_failed",
          required: false,
          plannedPlacements: ["N.body", "Cref"],
          reason: "正文与评论都未完整落地",
          realizations: [
            { channel: "N.body", resolved: false, missing: ["answer", "condition_or_boundary", "evidence", "findability"] },
            { channel: "Cref", threadId: "t-1", resolved: false, missing: ["evidence"] },
          ],
        },
      ],
    },
    gapCards: [
      {
        gapId: "g-1",
        label: "班组更换",
        question: "不合格能换吗，谁来判定？",
        required: false,
        priority: "high",
        boundary: "工期顺延",
        plannedPlacements: ["N.body", "Cref"],
      },
    ],
    ...patch,
  } as Pick<ReaderCandidate, "gapLedger" | "gapCards">;
}

test("计划未落地要说清缺哪几项:这是「不能直接发」的具体原因", () => {
  const view = gapLedgerView(candidate())!;
  const row = view.rows[0]!;
  assert.equal(row.failed, true);
  assert.equal(row.statusText, "计划未落地");
  assert.equal(row.tone, "error");
  assert.deepEqual(row.realizations[0]?.missingLabels, [
    "没给出答案", "没写适用条件或边界", "没有证据支撑", "读者找不到（藏得太深）",
  ]);
  assert.deepEqual(row.realizations[1]?.missingLabels, ["没有证据支撑"]);
});

test("同通道多线程合并成一行,不把「评论区：…」重复五遍", () => {
  // 实测:一个缺口能有 5 条 Cref 记录,缺项完全一样
  const view = gapLedgerView({
    gapLedger: {
      realizationStatus: "evaluated",
      entries: [{
        gapId: "g", label: "产品是什么", status: "realization_failed", required: true,
        plannedPlacements: ["N.body", "Cref"],
        realizations: [
          { channel: "N.body", resolved: false, missing: ["answer"] },
          { channel: "Cref", threadId: "t1", resolved: false, missing: ["answer", "evidence"] },
          { channel: "Cref", threadId: "t2", resolved: false, missing: ["answer", "evidence"] },
          { channel: "Cref", threadId: "t3", resolved: false, missing: ["evidence"] },
        ],
      }],
    },
    gapCards: [],
  })!;
  const r = view.rows[0]!.realizations;
  assert.equal(r.length, 2, `应合并成正文+评论区两行,实际 ${r.length} 行`);
  assert.equal(r[1]!.channelText, "评论区");
  // 缺项取并集且去重
  assert.deepEqual(r[1]!.missingLabels, ["没给出答案", "没有证据支撑"]);
  assert.equal(r[1]!.detail, "3 条线程中 0 条落地");
  // 单条不加 detail,免得啰嗦
  assert.equal(r[0]!.detail, undefined);
});

test("同通道全部线程都落地才算 resolved", () => {
  const view = gapLedgerView({
    gapLedger: {
      realizationStatus: "evaluated",
      entries: [{
        gapId: "g", label: "A", status: "thread_resolved", required: false, plannedPlacements: ["Cref"],
        realizations: [
          { channel: "Cref", threadId: "t1", resolved: true, missing: [] },
          { channel: "Cref", threadId: "t2", resolved: false, missing: ["evidence"] },
        ],
      }],
    },
    gapCards: [],
  })!;
  assert.equal(view.rows[0]!.realizations[0]!.resolved, false, "有一条没落地就不能算已落地");
  assert.equal(view.rows[0]!.realizations[0]!.detail, "2 条线程中 1 条落地");
});

test("缺口的原始问题与边界从 gapCards 补上,台账才讲得清在问什么", () => {
  const row = gapLedgerView(candidate())!.rows[0]!;
  assert.equal(row.question, "不合格能换吗，谁来判定？");
  assert.equal(row.boundary, "工期顺延");
});

test("通道名译成中文,不给用户看 N.body / Cref", () => {
  const row = gapLedgerView(candidate())!.rows[0]!;
  assert.deepEqual(row.plannedLabels, ["正文", "评论区"]);
  assert.equal(row.realizations[0]?.channelText, "正文");
  assert.equal(row.realizations[1]?.channelText, "评论区");
});

test("计数区分已落地与未落地", () => {
  const view = gapLedgerView({
    gapLedger: {
      realizationStatus: "evaluated",
      entries: [
        { gapId: "a", label: "A", status: "body_resolved", required: false, plannedPlacements: [], realizations: [] },
        { gapId: "b", label: "B", status: "thread_resolved", required: false, plannedPlacements: [], realizations: [] },
        { gapId: "c", label: "C", status: "realization_failed", required: true, plannedPlacements: [], realizations: [] },
      ],
    },
    gapCards: [],
  })!;
  assert.equal(view.total, 3);
  assert.equal(view.resolved, 2);
  assert.equal(view.failedCount, 1);
});

test("终稿未评估时 evaluated=false:此时不能把「未落地」说成失败", () => {
  const view = gapLedgerView({
    gapLedger: {
      realizationStatus: "not_evaluated",
      entries: [{ gapId: "a", label: "A", status: "planned_for_body", required: false, plannedPlacements: ["N.body"], realizations: [] }],
    },
    gapCards: [],
  })!;
  assert.equal(view.evaluated, false);
  assert.equal(view.rows[0]?.failed, false);
  assert.equal(view.rows[0]?.statusText, "计划由正文回答");
});

test("答不了但给了核验路径的缺口:按 warn 呈现并带出路径", () => {
  const view = gapLedgerView({
    gapLedger: {
      realizationStatus: "evaluated",
      entries: [{
        gapId: "a", label: "凹陷概率", status: "unknown_with_verification", required: false,
        plannedPlacements: ["Cref"], verificationPath: "让医生面诊时给出统计口径",
        realizations: [],
      }],
    },
    gapCards: [],
  })!;
  assert.equal(view.rows[0]?.tone, "warn");
  assert.equal(view.rows[0]?.statusText, "答不了，已给核验路径");
  assert.equal(view.rows[0]?.verificationPath, "让医生面诊时给出统计口径");
});

test("未识别的状态原样显示,不猜也不当成失败", () => {
  const view = gapLedgerView({
    gapLedger: { realizationStatus: "evaluated", entries: [{ gapId: "a", label: "A", status: "brand_new_status", required: false, plannedPlacements: [], realizations: [] }] },
    gapCards: [],
  })!;
  assert.equal(view.rows[0]?.statusText, "brand_new_status");
  assert.equal(view.rows[0]?.tone, "muted");
  assert.equal(view.rows[0]?.failed, false);
});

test("未识别的 missing 值原样保留", () => {
  const view = gapLedgerView({
    gapLedger: { realizationStatus: "evaluated", entries: [{ gapId: "a", label: "A", status: "realization_failed", required: false, plannedPlacements: [], realizations: [{ channel: "N.body", resolved: false, missing: ["some_new_missing"] }] }] },
    gapCards: [],
  })!;
  assert.deepEqual(view.rows[0]?.realizations[0]?.missingLabels, ["some_new_missing"]);
});

test("没有台账(历史包)返回 null,让调用方整块不渲染", () => {
  assert.equal(gapLedgerView(undefined), null);
  assert.equal(gapLedgerView({ gapCards: [] } as Pick<ReaderCandidate, "gapLedger" | "gapCards">), null);
  assert.equal(gapLedgerView({ gapLedger: { entries: [] }, gapCards: [] }), null);
});

test("gapCards 缺失时用台账自己的 label,不显示裸 id", () => {
  const view = gapLedgerView({
    gapLedger: { entries: [{ gapId: "g-9", label: "证据核验", status: "body_resolved", required: false, plannedPlacements: [], realizations: [] }] },
    gapCards: [],
  })!;
  assert.equal(view.rows[0]?.label, "证据核验");
  assert.equal(view.rows[0]?.question, undefined);
});

test("台账连 label 都没有时退到 gapId,不留空", () => {
  const view = gapLedgerView({
    gapLedger: { entries: [{ gapId: "g-9", label: "", status: "body_resolved", required: false, plannedPlacements: [], realizations: [] }] },
    gapCards: [],
  })!;
  assert.equal(view.rows[0]?.label, "g-9");
});

test("channelLabel 对未知通道原样返回", () => {
  assert.equal(channelLabel("N.body"), "正文");
  assert.equal(channelLabel("SomeNewChannel"), "SomeNewChannel");
});

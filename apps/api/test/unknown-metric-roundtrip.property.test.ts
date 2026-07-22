// Feature: content-methodology-self-consistency, Property 2: 未知度量往返保真
//
// Property 2 (Validates: Requirements 2.1, 2.2, 2.6, 2.8):
// 对任意度量输入，若其在提交时为未知（留空 / 非数值 / 越界——即被折叠为 null 的输入），则经
// "提交 → DTO/规范化 → 持久化形态 → 读取规范化 → 传递规划上下文" 的每一环节后仍为未知度量
// （持久层 null / 规划层 undefined），且在任一环节都不等于 0、0.5、0.3、中位值或任何默认值。
// 覆盖 gap 三项 / opportunity 七项 / image 三项。
//
// 各环节以真实实现驱动（不 mock、不复制被测逻辑）：
//   · DTO/规范化(写)   —— 选题走真实创建路径的 canonicalOpportunityData（内部经 optionalRatio 折叠）；
//                         gap / image 写入侧不折叠（原样入库），折叠发生在读取侧。
//   · 持久化形态       —— JSON.stringify → JSON.parse（模拟 SQLite data_json / observation_json 文本
//                         往返：NaN / ±Infinity → null、undefined 键被丢弃，二者均仍为"未知"）。
//   · 读取规范化       —— normalizeOpportunity / normalizeGap / normalizeImageAnalysis（内部 optionalRatio）。
//   · 传递规划上下文   —— 选题经真实 rankTopicOpportunities（内部 metricValue(null) → undefined）：未知度量
//                         计入 unknownMetrics、分量 rawValue/contribution 为 null、从 persistedOpportunity
//                         删除、且 baseScore/finalScore 为 null，绝不以数值替代；gap / image 由
//                         hydratePlanningContext 原样透传（structuredClone），未知恒保持 null。
//
// 未知输入集合说明：optionalRatio 仅把"非数值 / 非有限"折叠为 null；有限的越界数值（如 2 / -1）会被
// 前端按需求 4.7 拒绝（以留空到达）或被后端钳制为已知值，故不属于"未知"输入。这里用
// null / 非数值 / 空串 / 布尔 / NaN / ±Infinity 覆盖"留空 / 非数值 / 越界"三类未知提交。
// 以单一属性测试实现，numRuns=300（≥100）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { rankTopicOpportunities, type TopicOpportunity } from '@content-agent/agent-core';
import {
  canonicalOpportunityData,
  normalizeGap,
  normalizeImageAnalysis,
  normalizeOpportunity,
} from '../src/intelligence.service.js';

type AnyRecord = Record<string, unknown>;

// 三类资源的度量字段（预测表现轴）。
const OPPORTUNITY_METRICS = [
  'relevance',
  'importance',
  'proofability',
  'decisionLeverage',
  'novelty',
  'cognitiveCost',
  'risk',
] as const;
const GAP_METRICS = ['importance', 'decisionLeverage', 'proofability'] as const;
const IMAGE_METRICS = ['clarity', 'relevance', 'textLegibility'] as const;

// 固定图片素材行（结构恒定；度量承载在 observation 的 quality 中）。
const IMAGE_ASSET = {
  id: 'asset-1',
  filename: 'sample.png',
  media_type: 'image/png',
  width: 100,
  height: 80,
} as const;

// OMIT：提交时"留空"——完全不写入该键。
const OMIT = Symbol('omit');

// 提交侧度量单元：要么"未知"（会被折叠为 null），要么用户显式提供的 [0,1] 已知值。
type MetricCell =
  | { readonly kind: 'unknown'; readonly raw: unknown }
  | { readonly kind: 'known'; readonly raw: number };

// 未知提交输入：留空(OMIT / undefined) / 非数值(null、字符串、空串、布尔) / 越界·非有限(NaN、±Infinity)。
const unknownRaw: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant<unknown>(OMIT),
  fc.constant<unknown>(undefined),
  fc.constant<unknown>(null),
  fc.constant<unknown>('n/a'),
  fc.constant<unknown>(''),
  fc.constant<unknown>('  '),
  fc.constant<unknown>(true),
  fc.constant<unknown>(false),
  fc.constant<unknown>(Number.NaN),
  fc.constant<unknown>(Number.POSITIVE_INFINITY),
  fc.constant<unknown>(Number.NEGATIVE_INFINITY),
);

// 已知输入：落在 [0,1] 的显式数值；规避 -0（optionalRatio / JSON 会归一为 +0，避免 SameValue 误报）。
const knownRatio: fc.Arbitrary<number> = fc
  .double({ min: 0, max: 1, noNaN: true })
  .map((value) => (Object.is(value, -0) ? 0 : value));

const metricCell: fc.Arbitrary<MetricCell> = fc.oneof(
  unknownRaw.map((raw): MetricCell => ({ kind: 'unknown', raw })),
  knownRatio.map((raw): MetricCell => ({ kind: 'known', raw })),
);

function cellsArb(names: readonly string[]): fc.Arbitrary<Record<string, MetricCell>> {
  return fc.record(Object.fromEntries(names.map((name) => [name, metricCell])));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// 提交侧：把度量单元铺进目标记录（留空 = 不写入该键）。
function applyCells(target: AnyRecord, names: readonly string[], cells: Record<string, MetricCell>): void {
  for (const name of names) {
    const cell = cells[name]!;
    if (cell.kind === 'unknown' && cell.raw === OMIT) continue; // 留空：省略该键
    target[name] = cell.raw;
  }
}

// 持久化往返：模拟 data_json / observation_json 以 JSON 文本存取。
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// 持久层 / 读取层的未知度量恒为 null——绝不是数值（据此排除 0 / 0.5 / 0.3 / 中位值 / 任何默认值）。
function assertUnknownNull(actual: unknown, where: string): void {
  assert.strictEqual(
    actual,
    null,
    `${where}: 未知度量应为 null，绝不折叠为 0 / 0.5 / 0.3 / 中位值 / 任何默认值（实际=${String(actual)}）`,
  );
}

// 用户显式提供的 [0,1] 已知度量应原样保真，绝不被默认值或未知替代。
function assertKnownPreserved(actual: unknown, expected: number, where: string): void {
  assert.strictEqual(actual, expected, `${where}: 已知度量应原样保真（期望=${expected}，实际=${String(actual)}）`);
}

// 写入不折叠的持久化形态中，未知度量绝不表现为有限数值（即绝不被注入默认值）。
function assertUnknownNotNumeric(actual: unknown, where: string): void {
  assert.ok(!isFiniteNumber(actual), `${where}: 未知度量不应被持久化为数值（实际=${String(actual)}）`);
}

// —— 选题（7 项）：提交 → canonicalOpportunityData(写) → JSON 往返 → normalizeOpportunity(读) → rankTopicOpportunities(规划) ——
function runOpportunityRoundTrip(cells: Record<string, MetricCell>): void {
  const submitted: AnyRecord = { topic: 'roundtrip-topic', angle: 'a', gapIds: ['gap-1'], status: 'eligible' };
  applyCells(submitted, OPPORTUNITY_METRICS, cells);

  const canonical = canonicalOpportunityData(submitted); // DTO/规范化（写，内部 optionalRatio）
  const persisted = jsonRoundTrip(canonical); // 持久化形态（data_json 文本往返）
  const readback = normalizeOpportunity({ // 读取规范化（内部 optionalRatio）
    id: 'opp-1',
    title: 'roundtrip-topic',
    angle: 'a',
    data_json: JSON.stringify(canonical),
  });

  for (const metric of OPPORTUNITY_METRICS) {
    const cell = cells[metric]!;
    if (cell.kind === 'unknown') {
      assertUnknownNull(canonical[metric], `opportunity/canonical/${metric}`);
      assertUnknownNull(persisted[metric], `opportunity/persisted/${metric}`);
      assertUnknownNull(readback[metric], `opportunity/readback/${metric}`);
    } else {
      assertKnownPreserved(canonical[metric], cell.raw, `opportunity/canonical/${metric}`);
      assertKnownPreserved(persisted[metric], cell.raw, `opportunity/persisted/${metric}`);
      assertKnownPreserved(readback[metric], cell.raw, `opportunity/readback/${metric}`);
    }
  }

  // 传递规划上下文：真实 rankTopicOpportunities（recentCoverage=[] 使 unknownMetrics 仅含度量名）。
  const ranked = rankTopicOpportunities({
    opportunities: [readback as unknown as TopicOpportunity],
    recentCoverage: [],
  })[0];
  assert.ok(ranked, 'opportunity/planning: rankTopicOpportunities 应返回结果');
  const rankedOpportunity = ranked.opportunity as unknown as AnyRecord;
  const unknownRankMetrics = ranked.unknownMetrics as unknown as string[];
  let anyUnknown = false;

  for (const metric of OPPORTUNITY_METRICS) {
    const cell = cells[metric]!;
    const component = ranked.components.find((entry) => entry.metric === metric);
    assert.ok(component, `opportunity/planning/${metric}: 应存在排序分量`);
    if (cell.kind === 'unknown') {
      anyUnknown = true;
      // 规划层未知：计入 unknownMetrics、分量为 null、从选题对象删除——绝不以数值替代（metricValue(null)→undefined）。
      assert.ok(unknownRankMetrics.includes(metric), `opportunity/planning/${metric}: 未知度量应计入 unknownMetrics`);
      assert.strictEqual(component.rawValue, null, `opportunity/planning/${metric}: 未知度量分量 rawValue 应为 null`);
      assert.strictEqual(component.contribution, null, `opportunity/planning/${metric}: 未知度量分量 contribution 应为 null`);
      assert.ok(
        !(metric in rankedOpportunity),
        `opportunity/planning/${metric}: 未知度量应从规划选题中删除（undefined），而非填入默认值`,
      );
    } else {
      assert.ok(!unknownRankMetrics.includes(metric), `opportunity/planning/${metric}: 已知度量不应计入 unknownMetrics`);
      assertKnownPreserved(component.rawValue, cell.raw, `opportunity/planning/${metric}/rawValue`);
      assertKnownPreserved(rankedOpportunity[metric], cell.raw, `opportunity/planning/${metric}`);
    }
  }

  // 含任一未知度量时，未标定启发式不得凭空造分（baseScore / finalScore 为 null）。
  if (anyUnknown) {
    assert.strictEqual(ranked.baseScore, null, 'opportunity/planning: 含未知度量时 baseScore 应为 null（不造分）');
    assert.strictEqual(ranked.finalScore, null, 'opportunity/planning: 含未知度量时 finalScore 应为 null（不造分）');
  }
}

// —— 信息缺口（3 项）：提交 → JSON 往返(写入不折叠) → normalizeGap(读) → 规划上下文透传 ——
function runGapRoundTrip(cells: Record<string, MetricCell>): void {
  const submitted: AnyRecord = { label: 'gap-label', question: 'gap-question' };
  applyCells(submitted, GAP_METRICS, cells);

  const persisted = jsonRoundTrip(submitted); // gap 写入侧不折叠（真实 createGap: JSON.stringify(resourceData(body))）
  const readback = normalizeGap({ id: 'gap-1', title: 'gap-question', data_json: JSON.stringify(submitted) });
  const planningGap = structuredClone(readback); // hydratePlanningContext 对 gap 原样透传

  for (const metric of GAP_METRICS) {
    const cell = cells[metric]!;
    if (cell.kind === 'unknown') {
      assertUnknownNotNumeric(persisted[metric], `gap/persisted/${metric}`); // 写入侧不折叠但绝不被注入默认数值
      assertUnknownNull(readback[metric], `gap/readback/${metric}`);
      assertUnknownNull(planningGap[metric], `gap/planning/${metric}`);
    } else {
      assertKnownPreserved(persisted[metric], cell.raw, `gap/persisted/${metric}`);
      assertKnownPreserved(readback[metric], cell.raw, `gap/readback/${metric}`);
      assertKnownPreserved(planningGap[metric], cell.raw, `gap/planning/${metric}`);
    }
  }
}

// —— 图片观察（3 项，quality 内）：提交 → JSON 往返(写入不折叠) → normalizeImageAnalysis(读) → 规划上下文透传 ——
function runImageRoundTrip(cells: Record<string, MetricCell>): void {
  const quality: AnyRecord = {};
  applyCells(quality, IMAGE_METRICS, cells);
  const observation: AnyRecord = { observedFacts: ['fact'], quality };

  const persisted = jsonRoundTrip(observation); // observation_json 写入侧不折叠；折叠发生在读取侧
  const persistedQuality = (persisted.quality ?? {}) as AnyRecord;
  const readback = normalizeImageAnalysis(IMAGE_ASSET as never, {
    id: 'analysis-1',
    observation_json: JSON.stringify(observation),
  });
  const readbackQuality = readback.quality as AnyRecord;
  const planningImage = structuredClone(readback); // hydratePlanningContext 对 image analyses 原样透传(+URL)
  const planningQuality = planningImage.quality as AnyRecord;

  for (const metric of IMAGE_METRICS) {
    const cell = cells[metric]!;
    if (cell.kind === 'unknown') {
      assertUnknownNotNumeric(persistedQuality[metric], `image/persisted/${metric}`);
      assertUnknownNull(readbackQuality[metric], `image/readback/${metric}`);
      assertUnknownNull(planningQuality[metric], `image/planning/${metric}`);
    } else {
      assertKnownPreserved(persistedQuality[metric], cell.raw, `image/persisted/${metric}`);
      assertKnownPreserved(readbackQuality[metric], cell.raw, `image/readback/${metric}`);
      assertKnownPreserved(planningQuality[metric], cell.raw, `image/planning/${metric}`);
    }
  }
}

const resourceCaseArb = fc.oneof(
  fc.record({ kind: fc.constant('opportunity' as const), cells: cellsArb(OPPORTUNITY_METRICS) }),
  fc.record({ kind: fc.constant('gap' as const), cells: cellsArb(GAP_METRICS) }),
  fc.record({ kind: fc.constant('image' as const), cells: cellsArb(IMAGE_METRICS) }),
);

test('Property 2: unknown metrics round-trip as unknown through submit → persist → read → planning', () => {
  fc.assert(
    fc.property(resourceCaseArb, (testCase) => {
      switch (testCase.kind) {
        case 'opportunity':
          runOpportunityRoundTrip(testCase.cells);
          break;
        case 'gap':
          runGapRoundTrip(testCase.cells);
          break;
        case 'image':
          runImageRoundTrip(testCase.cells);
          break;
      }
    }),
    { numRuns: 300 },
  );
});

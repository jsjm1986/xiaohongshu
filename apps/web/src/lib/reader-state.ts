import type {
  AudienceStateSeedProxy,
  LegacyReaderStateProxy,
  ReaderStateHypothesis,
  ReaderStateHypothesisLevel,
  ReaderStateProxy,
} from "../types.js";

export interface ReaderStateDetailView {
  id: string;
  label: string;
  value: string;
  explanation: string;
}

export interface ReaderStateHypothesisView {
  id: "skepticism" | "fatigue" | "closureNeed";
  label: string;
  level: string;
  range: string;
  basis: string;
}

export interface ReaderStateView {
  kind: "scenario" | "legacy";
  stage: string;
  entry: string;
  details: ReaderStateDetailView[];
  hypotheses: ReaderStateHypothesisView[];
  notice: string;
}

const LEVEL_LABELS: Record<ReaderStateHypothesisLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const HYPOTHESIS_LABELS: Array<{
  id: ReaderStateHypothesisView["id"];
  label: string;
}> = [
  { id: "skepticism", label: "审慎程度" },
  { id: "fatigue", label: "信息疲劳" },
  { id: "closureNeed", label: "收束需要" },
];

export function isAudienceStateSeed(state: ReaderStateProxy): state is AudienceStateSeedProxy {
  return "stateHypotheses" in state && "history" in state && "preContactKnown" in state;
}

export function resolveReaderStateView(state: ReaderStateProxy): ReaderStateView {
  if (!isAudienceStateSeed(state)) return legacyReaderStateView(state);

  return {
    kind: "scenario",
    stage: state.stage || "阶段未知",
    entry: state.entry || "入口未知",
    details: [
      {
        id: "pre-contact-known",
        label: "接触前已知（用户提供）",
        value: listValue(state.preContactKnown, "未提供"),
        explanation: "只接受用户显式输入；不会从项目事实或证据自动推断。",
      },
      {
        id: "available-evidence",
        label: "系统可用证据",
        value: listValue(state.availableEvidence, "暂无可用证据"),
        explanation: "供生成代理核验内容，不代表读者已经看过或知道。",
      },
      {
        id: "hypothesized-gaps",
        label: "假设信息缺口",
        value: listValue(state.hypothesizedGaps, "未形成"),
        explanation: "本候选准备补全的问题，不是真实用户调研结论。",
      },
      {
        id: "reader-constraints",
        label: "读者情景约束（用户提供）",
        value: listValue(state.readerConstraints, "未提供"),
        explanation: "描述本次读者情景，不等同于项目规则或禁止项。",
      },
      {
        id: "available-boundaries",
        label: "系统可用内容边界",
        value: listValue(state.availableBoundaries, "暂无明确边界"),
        explanation: "约束生成内容，不代表读者自身的条件或特征。",
      },
      historyDetail(state.history),
    ],
    hypotheses: HYPOTHESIS_LABELS.map(({ id, label }) => hypothesisView(id, label, state.stateHypotheses[id])),
    notice: "这是本候选的写作情景假设。等级与区间来自阶段启发式且尚未标定，不是概率、心理测量或真实用户分布。",
  };
}

function historyDetail(history: AudienceStateSeedProxy["history"]): ReaderStateDetailView {
  if (history.status === "unknown") {
    return {
      id: "history",
      label: "接触前历史",
      value: "unknown（未提供）",
      explanation: "系统不会把缺失历史当作没有历史，也不会自行补写。",
    };
  }

  return {
    id: "history",
    label: "接触前历史（用户提供）",
    value: history.items.length ? history.items.join("；") : "已明确提供为空",
    explanation: "provided 与 unknown 分开保留，避免把缺失信息误当成事实。",
  };
}

function hypothesisView(
  id: ReaderStateHypothesisView["id"],
  label: string,
  hypothesis: ReaderStateHypothesis,
): ReaderStateHypothesisView {
  return {
    id,
    label,
    level: LEVEL_LABELS[hypothesis.level],
    range: formatRange(hypothesis.range),
    basis: hypothesis.basis || "未提供形成依据。",
  };
}

function legacyReaderStateView(state: LegacyReaderStateProxy): ReaderStateView {
  const details: ReaderStateDetailView[] = [];
  if (state.known?.length) {
    details.push({
      id: "legacy-known",
      label: "历史 known 字段（来源未区分）",
      value: state.known.join("；"),
      explanation: "旧快照可能混入项目事实，不能视为读者接触前已知。",
    });
  }
  if (state.perceivedGaps?.length || state.concern) {
    details.push({
      id: "legacy-gaps",
      label: "历史缺口 / 顾虑",
      value: state.perceivedGaps?.join("；") || state.concern || "未提供",
      explanation: "旧字段没有记录假设依据，仅用于兼容查看。",
    });
  }
  if (state.constraints?.length) {
    details.push({
      id: "legacy-constraints",
      label: "历史 constraints 字段（来源未区分）",
      value: state.constraints.join("；"),
      explanation: "无法判断属于读者条件还是内容边界，不作新的语义推断。",
    });
  }
  if (state.priorKnowledge) {
    details.push({
      id: "legacy-prior-knowledge",
      label: "历史 priorKnowledge 字段",
      value: state.priorKnowledge,
      explanation: "来源未记录，不能视为用户已确认的接触前已知。",
    });
  }
  if (state.comparisonHistory) {
    details.push({
      id: "legacy-history",
      label: "历史 comparisonHistory 字段",
      value: state.comparisonHistory,
      explanation: "旧快照未区分 provided 与 unknown。",
    });
  }
  for (const [id, label, value] of [
    ["legacy-skepticism", "历史审慎程度代理", state.skepticism],
    ["legacy-fatigue", "历史信息疲劳代理", state.fatigue],
    ["legacy-closure", "历史收束需要代理", state.closureNeed],
  ] as const) {
    if (typeof value === "number" && Number.isFinite(value)) {
      details.push({
        id,
        label,
        value: `未标定数值 ${formatNumber(value)}`,
        explanation: "不按概率、测量值或人群统计解释。",
      });
    }
  }

  return {
    kind: "legacy",
    stage: state.stage || "阶段未知",
    entry: state.entry || state.scene || "入口未知",
    details,
    hypotheses: [],
    notice: "这是历史兼容快照：字段来源没有完整分离，known 不等于接触前已知，旧 0.x 代理也不是概率或心理测量。",
  };
}

function listValue(items: string[], empty: string): string {
  return items.length ? items.join("；") : empty;
}

function formatRange(range: [number, number]): string {
  return `${formatNumber(range[0])}–${formatNumber(range[1])}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

import type {
  FormulaDefinition,
  FormulaVersion,
  GenerationParameterDefinition,
  GenerationParameterSchema,
  ParameterControl,
  ParameterOption,
} from '../types';

type UnknownRecord = Record<string, unknown>;

const groups = [
  { id: 'information', label: '信息窗口', description: '决定补什么、补多少、补到什么深度。' },
  { id: 'expression', label: '表达窗口', description: '决定如何把信息分配给标题、正文和评论区。' },
  { id: 'evidence', label: '证据与边界', description: '决定哪些内容可以当作事实，哪些必须标记为推理或未知。' },
  { id: 'runtime', label: '生成与修复', description: '调节内容多样性和自动质量修复。' },
];

const groupLabels: Record<string, { label: string; description: string }> = {
  reader: { label: '读者与入口', description: '描述读者当前阶段、任务和看到内容的路径。' },
  information: { label: '信息窗口', description: '决定补什么、补多少、补到什么深度。' },
  expression: { label: '表达窗口', description: '决定语气、结构和表达形态。' },
  channel: { label: '通道分工', description: '把信息分配给标题、正文、标签、图片和评论区。' },
  evidence: { label: '证据与边界', description: '控制事实依据、未知标记和风险边界。' },
  diagnostic: { label: '检查与人工复核', description: 'F32/F33 emphasis 只调整页面和人工检查清单的显示顺序，不调度系统检查，也不改变合格线、权重或分数；独立规则开关会另行标明。' },
  operation: { label: '生成与修复', description: '控制候选、随机性与质量修复。' },
  runtime: { label: '生成与修复', description: '控制候选、随机性与质量修复。' },
};

const fallbackParameters: GenerationParameterDefinition[] = [
  {
    id: 'information-breadth', path: 'config.informationBreadth', label: '信息广度', shortLabel: '广度', group: 'information', control: 'slider', min: 20, max: 100, step: 1, unit: '%', defaultValue: 76, recommendedRange: [58, 82], formulaIds: ['F04', 'F26', 'F28'],
    description: '本次内容试图覆盖的决策信息范围。', noviceExplanation: '就是这篇内容准备帮读者解决多少类问题。调高会讲得更全，但不等于把所有信息都堆进正文。', equation: 'Wᴵ = (G, Ans, E, θ, Priority, Boundary)',
    increaseEffect: '覆盖更多信息缺口，评论区会承担更多补全任务。', decreaseEffect: '聚焦少量核心问题，内容更轻、更容易阅读。', risk: '过高会造成信息堆叠；知识库不足时还会放大未知信息。',
  },
  {
    id: 'information-depth', path: 'config.informationDepth', label: '信息深度', shortLabel: '深度', group: 'information', control: 'slider', min: 20, max: 100, step: 1, unit: '%', defaultValue: 64, recommendedRange: [52, 78], formulaIds: ['F04', 'F06', 'F09'],
    description: '每个核心问题追问到什么程度。', noviceExplanation: '低深度只告诉读者“是什么”；高深度还会说明“怎么判断、什么情况不适用”。', equation: 'Gres = Gdecision \\ Resolve(H ⊕ N)',
    increaseEffect: '增加判断依据、条件和边界，更适合理性收集期。', decreaseEffect: '更快给出主线结论，阅读负担更小。', risk: '深度过高会增加认知成本，也可能超出现有证据的支撑范围。',
  },
  {
    id: 'task-goal', path: 'task.goal', label: '本次决策目标', shortLabel: '目标', group: 'information', control: 'text', defaultValue: '', formulaIds: ['F15', 'F16', 'F17'],
    description: '读者看完后应该少一个什么困难。', noviceExplanation: '不是写“提高转化”，而是写读者能得到的具体决策帮助，例如“知道下一步应该先核实什么”。', equation: 'V* = regretBefore − regretAfter − cognitiveCost',
    increaseEffect: '目标越具体，信息选择和结构越稳定。', decreaseEffect: '目标越宽泛，候选的表达空间更大。', risk: '把业务转化直接当成读者目标，容易产生生硬营销表达。',
  },
  {
    id: 'priority-gaps', path: 'task.mustInclude', label: '优先补全项', shortLabel: '必须补全', group: 'information', control: 'list', defaultValue: [], formulaIds: ['F04', 'F09', 'F28'],
    description: '本次必须回答的具体信息缺口。', noviceExplanation: '每行写一个读者必须得到的答案，例如“哪些情况不适用”。系统会再决定它放在正文还是评论区。', equation: 'Wᴵinst = {xᵢ} ∩ Feasible(KBₜ)',
    increaseEffect: '约束生成结果必须覆盖这些信息。', decreaseEffect: '让 Agent 更自由地从知识库选择信息缺口。', risk: '条目太多或知识库无法支持时，会变成冲突或未知项。',
  },
  {
    id: 'expression-freedom', path: 'config.expressionFreedom', label: '表达自由度', shortLabel: '自由度', group: 'expression', control: 'slider', min: 10, max: 100, step: 1, unit: '%', defaultValue: 58, recommendedRange: [42, 76], formulaIds: ['F05', 'F08', 'F26'],
    description: '允许 Agent 在叙事、清单、问答和结构之间尝试多大变化。', noviceExplanation: '它只改变“怎么说”，不改变事实边界。调高后三个候选会更不一样。', equation: 'X = Wᴵ × Π(Wˣ) × Aᶜ',
    increaseEffect: '候选间的结构、语气和切入角度差异更大。', decreaseEffect: '更贴近项目默认表达范式，结果稳定。', risk: '过高可能让语气与项目不一致，需要更严格的事实校验。',
  },
  {
    id: 'tone', path: 'config.tone', label: '内容语气', shortLabel: '语气', group: 'expression', control: 'select', defaultValue: '真实分享', formulaIds: ['F05', 'F13'],
    description: '用户实际读到的声音和距离感。', noviceExplanation: '选择“像谁在说话”。语气不会把猜想变成事实，也不会改变禁止表达。', equation: 'Wˣ = (Channel, Form, Voice, Sequence, Thread)',
    options: [{ label: '真实分享', value: '真实分享' }, { label: '理性功课', value: '理性功课' }, { label: '轻松聊天', value: '轻松聊天' }, { label: '专业解答', value: '专业解答' }],
    increaseEffect: '选更口语的风格会缩短阅读距离。', decreaseEffect: '选更理性的风格会增强结构和判断感。', risk: '过度模仿“真实经历”可能导致虚构，必须保持知识来源边界。',
  },
  {
    id: 'body-length', path: 'config.bodyLength', label: '正文目标字数', shortLabel: '正文长度', group: 'expression', control: 'slider', min: 60, max: 1200, step: 10, unit: '字', defaultValue: 220, recommendedRange: [120, 420], formulaIds: ['F07', 'F09', 'F32'],
    description: '正文承载信息的大致空间。', noviceExplanation: '这不是整个内容包的长度。参考样本的正文中位数约 122 字，这只是对 70 篇样本的描述性统计，不是“最优字数”标准。系统会根据信息缺口和评论区分工分配长度。', equation: 'N = (Img, Ttitle, Body)',
    increaseEffect: '正文能承载更多判断背景和过渡。', decreaseEffect: '正文更轻，更多细节会转移到评论区参考。', risk: '字数少但信息广度高时，容易变成密集结论堆叠。',
  },
  {
    id: 'comment-enabled', path: 'config.commentsEnabled', label: '启用评论区补全', shortLabel: '评论区', group: 'expression', control: 'toggle', defaultValue: true, formulaIds: ['F03', 'F09', 'F10', 'F33'],
    description: '是否让评论区问答承担信息补全任务。', noviceExplanation: '开启后会生成“可能的真实提问 + 业务回复参考”，而不是伪造已经发布的口碑。', equation: 'Cref = Rollout(αᶜ)',
    increaseEffect: '在正文之外建立条件化问答和追问链。', decreaseEffect: '所有核心信息都要在正文中完成。', risk: '如果把参考问答当作真实用户评论发布，就越过了设计边界。',
  },
  {
    id: 'comment-threads', path: 'config.commentThreads', label: '评论问答组数', shortLabel: '问答组数', group: 'expression', control: 'slider', min: 0, max: 8, step: 1, unit: '组', defaultValue: 4, recommendedRange: [3, 6], formulaIds: ['F10', 'F22', 'F33'],
    description: '准备多少条独立的评论区问答参考。', noviceExplanation: '每一组都应解决一个正文后仍然存在的问题，而不是重复正文。', equation: 'Qᶜ = coverage + increment + fit + grounding − clutter',
    increaseEffect: '可补全更多条件、追问和个体差异。', decreaseEffect: '评论区更简洁，用户查找成本更低。', risk: '数量过多会增加翻找成本，也更容易出现重复信息。',
  },
  {
    id: 'vigilance', path: 'config.vigilanceLevel', label: '证据审慎 / 边界显式控制', shortLabel: '审慎与边界', group: 'evidence', control: 'slider', min: 0, max: 100, step: 1, defaultValue: 44, recommendedRange: [35, 70], formulaIds: ['F06', 'F14', 'F25', 'F34'],
    description: '旧版合并控制：同时调整证据严格度和限制条件的可见程度。', noviceExplanation: '0—100 只是写作控制刻度，不是读者警惕性百分比、心理测量或人群分布。新配置会把它拆成“证据严格度”和“边界可见度”。', equation: 'legacy(vigilanceLevel) → evidence_strictness + boundary_visibility',
    increaseEffect: '更坚决地保留未知，并让条件、反例和风险靠近相关结论。', decreaseEffect: '减少重复提醒、让表达更流畅；关键事实边界仍不可隐藏。', risk: '这是兼容旧配置的合并键，不能据此推断真实读者状态。', evidenceStatus: 'operational_default', evidenceNote: '未标定的控制刻度；API 只把它映射为 evidence_strictness 与 boundary_visibility。',
  },
  {
    id: 'strict-evidence', path: 'config.strictEvidence', label: '严格事实模式', shortLabel: '严格事实', group: 'evidence', control: 'toggle', defaultValue: false, formulaIds: ['F06', 'F25', 'F34'],
    description: '是否只允许已知事实进入最终文案。', noviceExplanation: '开启后，方法论推理、猜想和信息不足项不会作为文案结论使用。', equation: 'Wᴵinst ⊆ Feasible(KBₜ)',
    increaseEffect: '事实边界更稳固，生成可能留下更多未知。', decreaseEffect: '可使用明确标记的方法论推理和猜想。', risk: '知识库很小时，严格模式可能导致内容信息不足。',
  },
  {
    id: 'knowledge-scope', path: 'config.knowledgeScope', label: '知识使用范围', shortLabel: '知识范围', group: 'evidence', control: 'select', defaultValue: 'all', formulaIds: ['F06', 'F25', 'F34'],
    description: '本次任务可以使用哪些知识文件。', noviceExplanation: '知识库很小时建议用“全部知识”。只有在需要排除样本风格或限定事实时才缩小范围。', equation: 'KBₜ = Active(ProjectKnowledge, Scope)',
    options: [{ label: '全部知识', value: 'all', description: '优先全量注入' }, { label: '仅事实与约束', value: 'facts' }, { label: '仅手动选中文件', value: 'selected' }],
    increaseEffect: '范围更大，可用素材和表达样本更多。', decreaseEffect: '范围更小，事实边界更容易检查。', risk: '手动限定范围后可能遗漏关键禁止项，系统仍会强制读取约束文件。',
  },
  {
    id: 'temperature', path: 'config.temperature', label: '模型随机度', shortLabel: '随机度', group: 'runtime', control: 'slider', min: 0, max: 1.5, step: 0.05, defaultValue: 0.75, recommendedRange: [0.55, 0.95], formulaIds: ['F26', 'F27'],
    description: '候选文案在用词、角度和结构上的随机变化。', noviceExplanation: '它不是质量分。调高会让三个候选差异更大，调低则更稳定。', equation: 'x* = arg maxₓ minθ J(x; θ)',
    increaseEffect: '增加候选差异和非预期表达机会。', decreaseEffect: '提高可复现性和结构稳定性。', risk: '过高会增加偏离风格或产生边缘表达的概率。',
  },
  {
    id: 'repair-rounds', path: 'config.repairRounds', label: '自动修复轮数', shortLabel: '修复轮数', group: 'runtime', control: 'select', defaultValue: 1, formulaIds: ['F32', 'F33'],
    description: '系统规则校验发现问题后允许 Agent 局部重做一次。', noviceExplanation: '它不会无限循环。每轮只修正检查出的问题，不重写已经合格的部分。', equation: 'Diagnose → Repair(affected channels) → Revalidate',
    options: [{ label: '不自动修复', value: 0 }, { label: '1 轮（推荐）', value: 1 }],
    increaseEffect: '开启后提供一次修复证据、重复与结构问题的机会。', decreaseEffect: '生成更快，但需要人工检查诊断警告。', risk: '修复只能改善表达与约束符合度，不能弥补知识库中不存在的事实。',
  },
];

const isRecord = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asOptions = (value: unknown): ParameterOption[] | undefined => Array.isArray(value)
  ? value.map((item) => isRecord(item) ? { label: String(item.label ?? item.value ?? ''), value: item.value as string | number | boolean, description: typeof item.description === 'string' ? item.description : undefined } : { label: String(item), value: item as string | number | boolean })
  : undefined;

const normalizeParameter = (raw: UnknownRecord): GenerationParameterDefinition | null => {
  const ui = isRecord(raw.ui) ? raw.ui : {};
  const controlMeta = isRecord(raw.control) ? raw.control : isRecord(raw.controlMeta) ? raw.controlMeta : {};
  const id = String(raw.id ?? raw.key ?? '');
  const path = String(raw.path ?? raw.configPath ?? '');
  if (!id || !path) return null;
  const control = String(
    (typeof raw.control === 'string' ? raw.control : controlMeta.kind) ??
    raw.controlType ?? ui.control ?? 'text',
  ) as ParameterControl;
  return {
    id, path, control,
    label: String(raw.label ?? raw.title ?? id),
    shortLabel: typeof raw.shortLabel === 'string' ? raw.shortLabel : undefined,
    group: String(raw.group ?? raw.groupId ?? 'runtime'),
    description: String(raw.description ?? raw.changeEffect ?? raw.plainLanguage ?? raw.noviceExplanation ?? ''),
    noviceExplanation: String(raw.noviceExplanation ?? raw.plainLanguage ?? raw.help ?? ''),
    formulaIds: Array.isArray(raw.formulaIds) ? raw.formulaIds.map(String) : [],
    equation: typeof raw.equation === 'string' ? raw.equation : undefined,
    min: typeof raw.min === 'number' ? raw.min : typeof controlMeta.min === 'number' ? controlMeta.min : typeof ui.min === 'number' ? ui.min : undefined,
    max: typeof raw.max === 'number' ? raw.max : typeof controlMeta.max === 'number' ? controlMeta.max : typeof ui.max === 'number' ? ui.max : undefined,
    step: typeof raw.step === 'number' ? raw.step : typeof controlMeta.step === 'number' ? controlMeta.step : typeof ui.step === 'number' ? ui.step : undefined,
    unit: typeof raw.unit === 'string' ? raw.unit : typeof controlMeta.unit === 'string' ? controlMeta.unit : undefined,
    defaultValue: raw.defaultValue ?? raw.default ?? null,
    options: asOptions(raw.options ?? controlMeta.options ?? ui.options),
    increaseEffect: typeof raw.increaseEffect === 'string' ? raw.increaseEffect : typeof raw.higherImpact === 'string' ? raw.higherImpact : undefined,
    decreaseEffect: typeof raw.decreaseEffect === 'string' ? raw.decreaseEffect : typeof raw.lowerImpact === 'string' ? raw.lowerImpact : undefined,
    risk: typeof raw.evidenceNote === 'string' ? raw.evidenceNote : typeof raw.risk === 'string' ? `风险级别：${raw.risk}` : undefined,
    recommendedRange: Array.isArray(raw.recommendedRange) && raw.recommendedRange.length === 2 ? [Number(raw.recommendedRange[0]), Number(raw.recommendedRange[1])] : undefined,
    advancedOnly: typeof raw.advancedOnly === 'boolean' ? raw.advancedOnly : controlMeta.advanced === true,
    simpleMode: typeof raw.simpleMode === 'boolean' ? raw.simpleMode : typeof controlMeta.simpleMode === 'boolean' ? controlMeta.simpleMode : undefined,
    evidenceStatus: typeof raw.evidenceStatus === 'string' ? raw.evidenceStatus : undefined,
    evidenceNote: typeof raw.evidenceNote === 'string' ? raw.evidenceNote : undefined,
    channels: Array.isArray(raw.channels) ? raw.channels.map(String) : Array.isArray(raw.effects) ? raw.effects.map(String) : [],
  };
};

const formulaMap = (formulas: FormulaDefinition[]) => new Map(formulas.map((formula) => [formula.id, formula]));

export function normalizeParameterSchema(raw: unknown, formulaVersion?: FormulaVersion): GenerationParameterSchema {
  const record = isRecord(raw) ? raw : {};
  const nested = isRecord(record.schema) ? record.schema : record;
  const backendParameters = Array.isArray(nested.parameters) ? nested.parameters.filter(isRecord).map(normalizeParameter).filter((item): item is GenerationParameterDefinition => Boolean(item)) : [];
  const backendFormulas = Array.isArray(nested.formulas) ? nested.formulas as FormulaDefinition[] : formulaVersion?.formulas ?? [];
  const formulasById = formulaMap(backendFormulas);
  const sampleBaseline = isRecord(nested.sampleBaseline) ? nested.sampleBaseline : isRecord(record.sampleBaseline) ? record.sampleBaseline : undefined;
  const bodyMetric = sampleBaseline && Array.isArray(sampleBaseline.metrics)
    ? sampleBaseline.metrics.find((item) => isRecord(item) && item.id === 'body_chars') as UnknownRecord | undefined
    : undefined;
  const bodyStatistics = bodyMetric && isRecord(bodyMetric.statistics) ? bodyMetric.statistics : undefined;
  const bodyMedian = typeof bodyStatistics?.median === 'number' ? bodyStatistics.median : undefined;
  const parameters = (backendParameters.length ? backendParameters : fallbackParameters).map((parameter) => {
    const linked = parameter.formulaIds.map((id) => formulasById.get(id)).filter(Boolean) as FormulaDefinition[];
    return {
      ...parameter,
      equation: parameter.equation || linked[0]?.equation,
      noviceExplanation: `${parameter.noviceExplanation || linked[0]?.plainLanguage || parameter.description}${bodyMedian !== undefined && ['body_min_chars', 'body_max_chars'].includes(parameter.id) ? ` 70篇参考内容的正文中位数约${Math.round(bodyMedian)}字，它只是描述性样本观察，不是最优长度、质量阈值或平台推荐规则。` : ''}`,
    };
  });
  const backendGroups = Array.isArray(nested.groups) ? nested.groups.filter(isRecord).map((item) => ({ id: String(item.id), label: String(item.label ?? item.name ?? item.id), description: typeof item.description === 'string' ? item.description : undefined })) : [];
  const presentGroups = [...new Set(parameters.map((parameter) => parameter.group))];
  const resolvedGroups = backendGroups.length ? backendGroups : presentGroups.map((id) => ({ id, label: groupLabels[id]?.label ?? id, description: groupLabels[id]?.description }));
  return {
    schemaVersion: String(nested.schemaVersion ?? nested.version ?? '1.0'),
    groups: resolvedGroups.length ? resolvedGroups : groups,
    parameters,
    formulas: backendFormulas,
    formulaVersion,
  };
}

export const defaultParameterSchema = normalizeParameterSchema({});

export function findFormulaDetails(parameter: GenerationParameterDefinition, schema: GenerationParameterSchema) {
  const byId = formulaMap(schema.formulas ?? []);
  return parameter.formulaIds.map((id) => byId.get(id)).filter(Boolean) as FormulaDefinition[];
}

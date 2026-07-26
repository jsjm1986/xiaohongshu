import type { AdvancedGenerationConfig, ContentPreset } from '../types';

/**
 * 离线兜底卡片是 agent-core 内置预设的**手抄副本**,不是从 agent-core import 的。
 *
 * 不能直接 import:`packages/agent-core/src/parameters.ts` 第一行就
 * `import { createHash } from "node:crypto"`,拉进浏览器包会把整个生成引擎和它的
 * Node 依赖一起打进去。所以这里重抄一份,由 `presets.test.ts` 的
 * 「offline cards mirror the core labels...」逐字段锁死两边一致。
 *
 * 代价是核心预设改了这里不会自动跟——实测已经漂移过:`comment_multi_turn_growth`
 * 在 Cref v1.1(144a8d4)进了全部 10 个核心预设,而卡片自基线提交起就没更新,
 * 于是 API 不可达、走离线兜底时用户拿到的是缺字段的旧预设。改核心预设时必须同步
 * 改这里,那条测试就是拦网。
 */
const commentMethodPresetBase = {
  // 多轮生长开关:核心预设 10 个全为 true,属于公共底而不是逐个 override。
  comment_multi_turn_growth: true,
  comment_role_diversity: 65,
  comment_constraint_density: 60,
  comment_gap_multiplexing: 55,
  comment_reply_increment: 70,
  question_compression: 60,
  comment_platform_register: 68,
  comment_conversation_rate: 48,
  comment_branching_strength: 62,
  comment_organic_variation: 58,
  comment_discovery_strength: 65,
  comment_inference_effort: 35,
  comment_self_verification: 70,
  comment_false_closure_guard: 95,
};

const builtInPresetsWithoutDiscovery: ContentPreset[] = [
  {
    id: 'real_minimal', name: '真实极简', description: '正文约 120 字，只建立场景和主线，把深层信息留给评论区问答。', source: 'built-in',
    values: { comment_role_diversity: 85, comment_constraint_density: 75, comment_gap_multiplexing: 65, comment_reply_increment: 90, question_compression: 90, audience_stage: 'collecting', entry_route: 'recommendation', information_breadth: 50, decision_information_depth: 55, state_information_strength: 70, experience_information_strength: 65, body_completeness: 40, comment_expansion: 88, comment_conditionality: 85, redundancy_tolerance: 10, evidence_strictness: 95, boundary_visibility: 90, question_naturalness: 85, title_target_chars: 11, paragraph_target: 3, body_min_chars: 100, body_max_chars: 140, comment_thread_min: 3, comment_thread_max: 5 },
  },
  {
    id: 'first_research', name: '新手功课', description: '帮助刚开始了解的人建立问题清单和判断顺序。', source: 'built-in',
    values: { comment_role_diversity: 75, comment_constraint_density: 55, comment_gap_multiplexing: 35, comment_reply_increment: 80, question_compression: 65, audience_stage: 'discovering', entry_route: 'search', information_breadth: 85, decision_information_depth: 72, state_information_strength: 55, experience_information_strength: 35, body_completeness: 72, comment_expansion: 70, comment_conditionality: 75, redundancy_tolerance: 15, evidence_strictness: 90, boundary_visibility: 90, route_specificity: 80, novelty_angle: 35, question_naturalness: 85, title_target_chars: 14, paragraph_target: 5, body_min_chars: 200, body_max_chars: 320, comment_thread_min: 3, comment_thread_max: 5 },
  },
  {
    id: 'rational_compare', name: '理性比较', description: '不直接给唯一答案，重点解释方案差异和适用条件。', source: 'built-in',
    values: { comment_role_diversity: 80, comment_constraint_density: 85, comment_gap_multiplexing: 60, comment_reply_increment: 90, question_compression: 55, audience_stage: 'comparing', entry_route: 'search', information_breadth: 80, decision_information_depth: 92, state_information_strength: 55, experience_information_strength: 35, body_completeness: 82, comment_expansion: 68, comment_conditionality: 92, redundancy_tolerance: 15, evidence_strictness: 95, boundary_visibility: 98, route_specificity: 85, novelty_angle: 45, question_naturalness: 65, title_target_chars: 16, paragraph_target: 5, body_min_chars: 260, body_max_chars: 480, comment_thread_min: 3, comment_thread_max: 5 },
  },
  {
    id: 'hesitation_completion', name: '犹豫补全', description: '承认不确定性，优先补风险、边界和下一步信息。', source: 'built-in',
    values: { comment_role_diversity: 85, comment_constraint_density: 90, comment_gap_multiplexing: 55, comment_reply_increment: 92, question_compression: 70, audience_stage: 'hesitating', entry_route: 'recommendation', information_breadth: 68, decision_information_depth: 85, state_information_strength: 75, experience_information_strength: 45, body_completeness: 75, comment_expansion: 82, comment_conditionality: 95, redundancy_tolerance: 15, evidence_strictness: 95, boundary_visibility: 100, route_specificity: 65, novelty_angle: 35, question_naturalness: 90, title_target_chars: 15, paragraph_target: 4, body_min_chars: 220, body_max_chars: 360, comment_thread_min: 4, comment_thread_max: 6, follow_up_depth: 3 },
  },
  {
    id: 'local_choice', name: '本地选择', description: '面向已准备行动的用户，补全城市、人物和筛选依据。', source: 'built-in',
    values: { comment_role_diversity: 80, comment_constraint_density: 85, comment_gap_multiplexing: 65, comment_reply_increment: 90, question_compression: 70, audience_stage: 'ready', entry_route: 'profile', information_breadth: 75, decision_information_depth: 90, state_information_strength: 65, experience_information_strength: 40, body_completeness: 85, comment_expansion: 80, comment_conditionality: 90, redundancy_tolerance: 15, evidence_strictness: 98, boundary_visibility: 98, route_specificity: 100, novelty_angle: 35, question_naturalness: 85, title_target_chars: 16, paragraph_target: 5, body_min_chars: 240, body_max_chars: 420, comment_thread_min: 4, comment_thread_max: 6 },
  },
  {
    id: 'balanced_information', name: '均衡信息补全', description: '正文保留共同主线，评论展开条件分支。', source: 'built-in', isDefault: true,
    values: { comment_role_diversity: 65, comment_constraint_density: 60, comment_gap_multiplexing: 55, comment_reply_increment: 70, question_compression: 60, information_breadth: 65, decision_information_depth: 70, body_completeness: 65, comment_expansion: 70, comment_conditionality: 75, evidence_strictness: 90, boundary_visibility: 90, body_min_chars: 180, body_max_chars: 260 },
  },
  {
    id: 'search_decision', name: '搜索决策补全', description: '主动搜索/比较，直接答疑、依据和经验方法。', source: 'built-in',
    values: { comment_role_diversity: 65, comment_constraint_density: 80, comment_gap_multiplexing: 55, comment_reply_increment: 90, question_compression: 60, audience_stage: 'comparing', entry_route: 'search', information_breadth: 80, decision_information_depth: 90, body_completeness: 80, comment_expansion: 72, route_specificity: 95, novelty_angle: 40, comment_conditionality: 85, evidence_strictness: 95, boundary_visibility: 95, question_naturalness: 70, title_target_chars: 15, paragraph_target: 5, body_min_chars: 220, body_max_chars: 700, comment_thread_min: 3, comment_thread_max: 5 },
  },
  {
    id: 'minimal_body_conditional_comments', name: '短正文＋条件问答', description: '正文保持最小充分，评论承担可查找的长尾分支。', source: 'built-in',
    values: { comment_role_diversity: 90, comment_constraint_density: 80, comment_gap_multiplexing: 70, comment_reply_increment: 95, question_compression: 90, audience_stage: 'collecting', entry_route: 'recommendation', information_breadth: 70, body_completeness: 40, comment_expansion: 90, comment_conditionality: 90, decision_information_depth: 70, redundancy_tolerance: 10, evidence_strictness: 95, boundary_visibility: 95, question_naturalness: 95, title_target_chars: 12, paragraph_target: 3, body_min_chars: 80, body_max_chars: 170, comment_thread_min: 4, comment_thread_max: 7, follow_up_depth: 3 },
  },
  {
    id: 'comparison_framework', name: '比较核验清单', description: '把模糊纠结变成可比较条件和筛选步骤。', source: 'built-in',
    values: { comment_role_diversity: 65, comment_constraint_density: 85, comment_gap_multiplexing: 75, comment_reply_increment: 92, question_compression: 55, audience_stage: 'comparing', entry_route: 'search', decision_information_depth: 95, information_breadth: 75, body_completeness: 80, comment_expansion: 75, comment_conditionality: 90, redundancy_tolerance: 10, route_specificity: 95, novelty_angle: 55, evidence_strictness: 95, boundary_visibility: 95, question_naturalness: 70, title_target_chars: 16, paragraph_target: 6, body_min_chars: 300, body_max_chars: 520, comment_thread_min: 3, comment_thread_max: 5 },
  },
  {
    id: 'state_experience_entry', name: '状态/经历入口', description: '用有依据的状态和生活线索建立相关性，再进入判断信息。', source: 'built-in',
    values: { comment_role_diversity: 80, comment_constraint_density: 65, comment_gap_multiplexing: 40, comment_reply_increment: 70, question_compression: 75, audience_stage: 'discovering', entry_route: 'recommendation', information_breadth: 55, state_information_strength: 85, experience_information_strength: 75, decision_information_depth: 60, body_completeness: 60, comment_expansion: 70, comment_conditionality: 75, redundancy_tolerance: 20, evidence_strictness: 95, boundary_visibility: 95, route_specificity: 55, novelty_angle: 50, question_naturalness: 80, title_target_chars: 13, paragraph_target: 4, body_min_chars: 160, body_max_chars: 280, comment_thread_min: 3, comment_thread_max: 5 },
  },
];

const surfacePresetOverrides: Record<string, { description: string; values: Record<string, number | string> }> = {
  real_minimal: { description: '用一个人物处境和一个窄问题起帖，评论区自然接住细节。', values: { comment_role_diversity: 92, comment_constraint_density: 55, comment_gap_multiplexing: 45, comment_reply_increment: 55, question_compression: 92, audience_stage: 'collecting', entry_route: 'recommendation', information_breadth: 50, decision_information_depth: 55, state_information_strength: 85, experience_information_strength: 75, body_completeness: 32, comment_expansion: 88, comment_conditionality: 85, redundancy_tolerance: 10, evidence_strictness: 95, boundary_visibility: 90, question_naturalness: 95, title_target_chars: 9, paragraph_target: 1, body_min_chars: 25, body_max_chars: 75, comment_thread_min: 3, comment_thread_max: 5 } },
  first_research: { description: '帮助刚开始了解的人建立问题清单和判断顺序。', values: { comment_role_diversity: 75, comment_constraint_density: 55, comment_gap_multiplexing: 35, comment_reply_increment: 80, question_compression: 65, audience_stage: 'discovering', entry_route: 'search', information_breadth: 85, decision_information_depth: 72, state_information_strength: 80, experience_information_strength: 55, body_completeness: 38, comment_expansion: 78, comment_conditionality: 75, redundancy_tolerance: 15, evidence_strictness: 90, boundary_visibility: 90, route_specificity: 80, novelty_angle: 35, question_naturalness: 95, title_target_chars: 10, paragraph_target: 2, body_min_chars: 30, body_max_chars: 95, comment_thread_min: 3, comment_thread_max: 5 } },
  rational_compare: { description: '不直接给唯一答案，重点解释方案差异和适用条件。', values: { comment_role_diversity: 80, comment_constraint_density: 85, comment_gap_multiplexing: 60, comment_reply_increment: 90, question_compression: 55, audience_stage: 'comparing', entry_route: 'search', information_breadth: 80, decision_information_depth: 92, state_information_strength: 75, experience_information_strength: 55, body_completeness: 52, comment_expansion: 76, comment_conditionality: 92, redundancy_tolerance: 15, evidence_strictness: 95, boundary_visibility: 98, route_specificity: 85, novelty_angle: 45, question_naturalness: 90, title_target_chars: 12, paragraph_target: 3, body_min_chars: 55, body_max_chars: 150, comment_thread_min: 3, comment_thread_max: 5 } },
  hesitation_completion: { description: '承认不确定性，优先补风险、边界和下一步信息。', values: { comment_role_diversity: 85, comment_constraint_density: 90, comment_gap_multiplexing: 55, comment_reply_increment: 92, question_compression: 70, audience_stage: 'hesitating', entry_route: 'recommendation', information_breadth: 68, decision_information_depth: 85, state_information_strength: 88, experience_information_strength: 68, body_completeness: 42, comment_expansion: 86, comment_conditionality: 95, redundancy_tolerance: 15, evidence_strictness: 95, boundary_visibility: 100, route_specificity: 65, novelty_angle: 35, question_naturalness: 95, title_target_chars: 11, paragraph_target: 2, body_min_chars: 40, body_max_chars: 120, comment_thread_min: 3, comment_thread_max: 5, follow_up_depth: 2 } },
  local_choice: { description: '面向已准备行动的用户，补全城市、人物和筛选依据。', values: { comment_role_diversity: 80, comment_constraint_density: 85, comment_gap_multiplexing: 65, comment_reply_increment: 90, question_compression: 70, audience_stage: 'ready', entry_route: 'profile', information_breadth: 75, decision_information_depth: 90, state_information_strength: 85, experience_information_strength: 72, body_completeness: 45, comment_expansion: 82, comment_conditionality: 90, redundancy_tolerance: 15, evidence_strictness: 98, boundary_visibility: 98, route_specificity: 100, novelty_angle: 35, question_naturalness: 95, title_target_chars: 10, paragraph_target: 2, body_min_chars: 30, body_max_chars: 110, comment_thread_min: 3, comment_thread_max: 5 } },
  balanced_information: { description: '正文保留共同主线，评论展开条件分支。', values: { comment_role_diversity: 85, comment_constraint_density: 60, comment_gap_multiplexing: 55, comment_reply_increment: 58, question_compression: 78, audience_stage: 'collecting', entry_route: 'search', information_breadth: 65, decision_information_depth: 70, state_information_strength: 75, experience_information_strength: 72, body_completeness: 45, comment_expansion: 78, comment_conditionality: 75, redundancy_tolerance: 15, evidence_strictness: 90, boundary_visibility: 90, route_specificity: 70, novelty_angle: 45, question_naturalness: 90, title_target_chars: 10, paragraph_target: 2, body_min_chars: 40, body_max_chars: 140, comment_thread_min: 3, comment_thread_max: 5 } },
  search_decision: { description: '主动搜索/比较，直接答疑、依据和经验方法。', values: { comment_role_diversity: 88, comment_constraint_density: 70, comment_gap_multiplexing: 55, comment_reply_increment: 62, question_compression: 80, audience_stage: 'comparing', entry_route: 'search', information_breadth: 80, decision_information_depth: 90, state_information_strength: 72, experience_information_strength: 58, body_completeness: 52, comment_expansion: 78, route_specificity: 95, novelty_angle: 40, comment_conditionality: 85, evidence_strictness: 95, boundary_visibility: 95, question_naturalness: 92, title_target_chars: 12, paragraph_target: 3, body_min_chars: 55, body_max_chars: 155, comment_thread_min: 3, comment_thread_max: 5 } },
  minimal_body_conditional_comments: { description: '正文保持最小充分，评论承担可查找的长尾分支。', values: { comment_role_diversity: 95, comment_constraint_density: 55, comment_gap_multiplexing: 50, comment_reply_increment: 55, question_compression: 95, audience_stage: 'collecting', entry_route: 'recommendation', information_breadth: 65, state_information_strength: 88, experience_information_strength: 72, body_completeness: 28, comment_expansion: 92, comment_conditionality: 82, decision_information_depth: 65, redundancy_tolerance: 10, evidence_strictness: 95, boundary_visibility: 90, question_naturalness: 98, title_target_chars: 8, paragraph_target: 1, body_min_chars: 20, body_max_chars: 70, comment_thread_min: 3, comment_thread_max: 5, follow_up_depth: 2 } },
  comparison_framework: { description: '把模糊纠结变成可比较条件和筛选步骤。', values: { comment_role_diversity: 88, comment_constraint_density: 75, comment_gap_multiplexing: 65, comment_reply_increment: 65, question_compression: 72, audience_stage: 'comparing', entry_route: 'search', decision_information_depth: 95, information_breadth: 75, state_information_strength: 72, experience_information_strength: 55, body_completeness: 55, comment_expansion: 82, comment_conditionality: 90, redundancy_tolerance: 10, route_specificity: 95, novelty_angle: 55, evidence_strictness: 95, boundary_visibility: 95, question_naturalness: 90, title_target_chars: 12, paragraph_target: 3, body_min_chars: 65, body_max_chars: 165, comment_thread_min: 3, comment_thread_max: 5 } },
  state_experience_entry: { description: '用有依据的状态和生活线索建立相关性，再进入判断信息。', values: { comment_role_diversity: 85, comment_constraint_density: 55, comment_gap_multiplexing: 40, comment_reply_increment: 55, question_compression: 82, audience_stage: 'discovering', entry_route: 'recommendation', information_breadth: 55, state_information_strength: 95, experience_information_strength: 95, decision_information_depth: 55, body_completeness: 48, comment_expansion: 72, comment_conditionality: 70, redundancy_tolerance: 20, evidence_strictness: 95, boundary_visibility: 90, route_specificity: 55, novelty_angle: 50, question_naturalness: 92, title_target_chars: 11, paragraph_target: 3, body_min_chars: 70, body_max_chars: 190, comment_thread_min: 3, comment_thread_max: 5 } },
};

const commentNetworkPresetOverrides: Record<string, Record<string, number>> = {
  real_minimal: { comment_platform_register: 82, comment_conversation_rate: 60, comment_branching_strength: 65, comment_organic_variation: 85 },
  first_research: { comment_platform_register: 58, comment_conversation_rate: 55, comment_branching_strength: 70, comment_organic_variation: 45 },
  rational_compare: { comment_platform_register: 45, comment_conversation_rate: 65, comment_branching_strength: 85, comment_organic_variation: 55 },
  hesitation_completion: { comment_platform_register: 65, comment_conversation_rate: 75, comment_branching_strength: 80, comment_organic_variation: 65 },
  local_choice: { comment_platform_register: 72, comment_conversation_rate: 55, comment_branching_strength: 70, comment_organic_variation: 55 },
  balanced_information: { comment_platform_register: 68, comment_conversation_rate: 48, comment_branching_strength: 62, comment_organic_variation: 58 },
  search_decision: { comment_platform_register: 55, comment_conversation_rate: 60, comment_branching_strength: 80, comment_organic_variation: 45 },
  minimal_body_conditional_comments: { comment_platform_register: 85, comment_conversation_rate: 70, comment_branching_strength: 72, comment_organic_variation: 88 },
  comparison_framework: { comment_platform_register: 45, comment_conversation_rate: 65, comment_branching_strength: 88, comment_organic_variation: 55 },
  state_experience_entry: { comment_platform_register: 75, comment_conversation_rate: 50, comment_branching_strength: 65, comment_organic_variation: 80 },
};

export const builtInPresets: ContentPreset[] = builtInPresetsWithoutDiscovery.map((preset) => {
  const override = surfacePresetOverrides[preset.id];
  return {
    ...preset,
    ...(override ? { description: override.description } : {}),
    values: { ...commentMethodPresetBase, ...(override?.values ?? preset.values), ...(commentNetworkPresetOverrides[preset.id] ?? {}) },
  };
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isParameterValue = (value: unknown) =>
  typeof value === 'string'
  || typeof value === 'number'
  || typeof value === 'boolean'
  || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

export interface PresetApplication {
  directValues: Record<string, unknown>;
  parameterValues: Record<string, unknown>;
  legacyConfig?: Partial<AdvancedGenerationConfig>;
  advancedPatch: Partial<AdvancedGenerationConfig>;
  audienceStage?: string;
  entryPoint?: string;
}

/** Normalize both API-native and old browser-local presets without carrying state from another card. */
export function preparePresetApplication(preset: ContentPreset): PresetApplication {
  const values = preset.values || {};
  const directValues = isRecord(values.parameters) ? values.parameters : values;
  const parameterValues = Object.fromEntries(Object.entries(directValues).filter(([id, value]) =>
    /^[a-z][a-z0-9_]*$/u.test(id) && id.includes('_') && isParameterValue(value),
  ));
  const legacyConfig = isRecord(values.config)
    ? values.config as Partial<AdvancedGenerationConfig>
    : undefined;
  const advancedPatch: Partial<AdvancedGenerationConfig> = {};
  const numberPatch: Array<[string, keyof AdvancedGenerationConfig]> = [
    ['information_breadth', 'informationBreadth'],
    ['decision_information_depth', 'informationDepth'],
    ['body_max_chars', 'bodyLength'],
    ['comment_thread_max', 'commentThreads'],
    ['model_temperature', 'temperature'],
    ['repair_attempts', 'repairRounds'],
    ['boundary_visibility', 'vigilanceLevel'],
  ];
  for (const [parameterId, configKey] of numberPatch) {
    const value = parameterValues[parameterId];
    if (typeof value === 'number') (advancedPatch as Record<string, unknown>)[configKey] = value;
  }
  if (typeof parameterValues.expression_voice === 'string') advancedPatch.tone = parameterValues.expression_voice;
  if (typeof parameterValues.evidence_strictness === 'number') {
    advancedPatch.evidenceMode = parameterValues.evidence_strictness >= 85
      ? 'strict'
      : parameterValues.evidence_strictness >= 65 ? 'balanced' : 'creative';
  }
  if (typeof parameterValues.knowledge_mode === 'string') {
    advancedPatch.knowledgeScope = ['auto', 'full'].includes(parameterValues.knowledge_mode) ? 'all' : 'selected';
  }
  return {
    directValues,
    parameterValues,
    legacyConfig,
    advancedPatch,
    audienceStage: typeof parameterValues.audience_stage === 'string'
      ? parameterValues.audience_stage
      : typeof values.audienceStage === 'string' ? values.audienceStage : undefined,
    entryPoint: typeof parameterValues.entry_route === 'string'
      ? parameterValues.entry_route
      : typeof values.entryPoint === 'string' ? values.entryPoint : undefined,
  };
}

/** API values/default state win; local built-ins are only an offline shelf fallback. */
export function mergePresetShelf(projectPresets: ContentPreset[]): ContentPreset[] {
  const remoteBuiltIns = projectPresets.filter((item) => item.source === 'built-in');
  const allBuiltIns = [...remoteBuiltIns, ...builtInPresets].filter(
    (item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index,
  );
  const customPresets = projectPresets.filter((item) => item.source === 'project');
  const defaultId = projectPresets.find((item) => item.isDefault)?.id
    ?? builtInPresets.find((item) => item.isDefault)?.id;
  return [...allBuiltIns, ...customPresets].map((item) => ({
    ...item,
    isDefault: item.id === defaultId,
  }));
}

const key = (projectId: string) => `content-agent-presets:${projectId}`;

export function readLocalPresets(projectId: string): ContentPreset[] {
  try {
    const value = JSON.parse(localStorage.getItem(key(projectId)) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export function writeLocalPresets(projectId: string, presets: ContentPreset[]) {
  localStorage.setItem(key(projectId), JSON.stringify(presets));
}

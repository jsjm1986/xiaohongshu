import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DatabaseService } from '../src/database.service.js';

const MODULES: Record<string, Record<string, unknown>> = {
  knowledge_map: { entries: [] },
  domain_model: {
    projectNoun: '测试项目', industry: '通用信息服务', domain: '决策支持',
    objects: ['项目'], actions: ['比较', '核验'], concepts: ['适用边界'],
    decisionTasks: ['确认会改变答案的条件'], vocabulary: ['适用边界'],
  },
  audience_model: {
    states: [{
      id: 'collecting', label: '正在收集信息', stages: ['collecting', 'comparing'],
      goals: ['补全判断依据'], constraints: [], knowledgeState: '知道主题但缺少判断条件',
      hesitationReasons: ['口径不一致'], actionConditions: ['关键条件可核验'],
      source: { status: 'inference', evidenceIds: [] },
    }],
  },
  scenario_model: {
    families: [{
      id: 'generic-comparison', label: '比较中的生活片段', prototype: 'option_comparison',
      applicableStages: ['discovering', 'collecting', 'comparing', 'hesitating', 'ready'],
      hostIdentityCues: ['正在认真做功课的人'], lifeContexts: ['午休时继续查资料'],
      timeAnchors: ['今天'], settings: ['查看已有资料时'], triggers: ['两种说法对不上'],
      observableActions: ['把差异记进备忘录'], frictions: ['时间有限'],
      emotionalAftertastes: ['想问清楚再决定'], imageMoments: ['与当前问题有关的记录'],
      prohibitedUnsupportedHistories: [], source: { status: 'hypothesis', evidenceIds: [] },
    }],
  },
  role_model: {
    hostVoiceTraits: ['自然', '具体'], hostSpeechMarkers: ['短句'],
    roles: [{
      id: 'peer', displayRole: '处境相近的读者', relationToHost: '处在相近决策阶段',
      identityCues: ['也在做功课'], situationCues: ['有一个现实限制'], motives: ['确认关键边界'],
      knowledgePosition: '只知道公开内容和自己的处境', speechPatterns: ['先说限制，再问一个窄问题'],
      lexicalCues: [], interactionHooks: ['追问适用条件'], permittedContributions: ['条件化问题'],
      utteranceModes: ['direct_question'], replyDisplayRoles: ['发布者'], targetChars: [6, 30],
      accountable: false, source: { status: 'hypothesis', evidenceIds: [] },
    }, {
      id: 'comparer', displayRole: '谨慎比较者', relationToHost: '正在比较不同选择',
      identityCues: ['手里已有两个选项'], situationCues: ['担心口径不同'], motives: ['补一个反例'],
      knowledgePosition: '只使用公开信息', speechPatterns: ['先说不同意见'], lexicalCues: [],
      interactionHooks: ['请对方补条件'], permittedContributions: ['反例或不同优先级'],
      utteranceModes: ['counterexample'], replyDisplayRoles: ['发布者'], targetChars: [6, 32],
      accountable: false, source: { status: 'hypothesis', evidenceIds: [] },
    }, {
      id: 'detail', displayRole: '细节发现者', relationToHost: '从正文或图片注意到一个细节',
      identityCues: ['先看细节'], situationCues: ['刚看到一处线索'], motives: ['确认细节含义'],
      knowledgePosition: '只知道可见内容', speechPatterns: ['短反应后追问'], lexicalCues: [],
      interactionHooks: ['从可见细节接话'], permittedContributions: ['观察和窄问题'],
      utteranceModes: ['detail_spotter'], replyDisplayRoles: ['发布者'], targetChars: [4, 26],
      accountable: false, source: { status: 'hypothesis', evidenceIds: [] },
    }, {
      id: 'translator', displayRole: '信息翻译者', relationToHost: '帮助把术语换成人话',
      identityCues: ['熟悉公开资料'], situationCues: ['发现说法太抽象'], motives: ['澄清一个概念'],
      knowledgePosition: '只翻译已核验知识', speechPatterns: ['先给短结论，再补条件'], lexicalCues: [],
      interactionHooks: ['留下适用边界'], permittedContributions: ['已核验信息的通俗解释'],
      utteranceModes: ['knowledge_translation'], replyDisplayRoles: ['发布者'], targetChars: [8, 40],
      accountable: true, source: { status: 'hypothesis', evidenceIds: [] },
    }, {
      id: 'reaction', displayRole: '自然共鸣者', relationToHost: '被正文处境触发',
      identityCues: ['处境相似'], situationCues: ['只想回应这一刻'], motives: ['表达共鸣'],
      knowledgePosition: '不承担专业回答', speechPatterns: ['几个字的自然反应'], lexicalCues: [],
      interactionHooks: ['给下一位留下话头'], permittedContributions: ['生活反应'],
      utteranceModes: ['social_reaction'], replyDisplayRoles: ['发布者'], targetChars: [3, 18],
      accountable: false, source: { status: 'hypothesis', evidenceIds: [] },
    }],
  },
  claim_policy: {
    rules: [], prohibitedClaims: [], dynamicInformation: [],
    unknownHandling: ['缺少证据时保持未知并给出核验路径'],
  },
  surface_language: {
    registerDescription: '自然、具体、符合当前项目读者的日常表达', preferredTerms: ['适用边界'],
    optionalColloquialisms: [], prohibitedCliches: ['闭眼入'], antiCopyRules: ['不复刻样本原句'],
  },
};

/** Seeds the explicit approved project contract required by formal-generation tests. */
export function seedApprovedProjectBlueprint(app: NestExpressApplication, projectId: string): string {
  const database = app.get(DatabaseService);
  const project = database.prepare('SELECT created_by, profile_json FROM projects WHERE id=? AND deleted_at IS NULL')
    .get(projectId) as { created_by: string; profile_json: string } | undefined;
  if (!project) throw new Error(`Project fixture not found: ${projectId}`);
  const now = new Date().toISOString();
  let intelligence = database.prepare(
    `SELECT id FROM project_intelligence
     WHERE project_id=? AND status='approved' AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`,
  ).get(projectId) as { id: string } | undefined;
  if (!intelligence) {
    const version = Number((database.prepare(
      'SELECT COALESCE(MAX(version), 0) AS value FROM project_intelligence WHERE project_id=?',
    ).get(projectId) as { value: number }).value) + 1;
    intelligence = { id: randomUUID() };
    const profile = JSON.parse(project.profile_json || '{}') as Record<string, unknown>;
    const verifiedFacts = [
      ...(Array.isArray(profile.productPoints) ? profile.productPoints : []),
      ...(Array.isArray(profile.organizationPoints) ? profile.organizationPoints : []),
    ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    database.prepare(
      `INSERT INTO project_intelligence
       (id, project_id, version, status, source_fingerprint, map_json, created_by, approved_by,
        created_at, updated_at, approved_at)
       VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      intelligence.id, projectId, version, `test-blueprint-${projectId}`,
      JSON.stringify({
        industry: '通用信息服务', domain: '决策支持', projectSummary: '测试项目蓝图',
        verifiedFacts, differentiators: [], audienceStates: ['collecting'], hardBoundaries: [],
        prohibitedClaims: [], dynamicUnknowns: [], evidenceIds: [],
      }),
      project.created_by, project.created_by, now, now, now,
    );
  }
  for (const [moduleKey, data] of Object.entries(MODULES)) {
    const exists = database.prepare(
      `SELECT 1 FROM project_blueprint_modules
       WHERE project_id=? AND intelligence_id=? AND module_key=? AND status='approved' AND deleted_at IS NULL`,
    ).get(projectId, intelligence.id, moduleKey);
    if (exists) continue;
    const version = Number((database.prepare(
      'SELECT COALESCE(MAX(version), 0) AS value FROM project_blueprint_modules WHERE project_id=? AND module_key=?',
    ).get(projectId, moduleKey) as { value: number }).value) + 1;
    const dataJson = JSON.stringify(data);
    database.prepare(
      `INSERT INTO project_blueprint_modules
       (id, project_id, intelligence_id, module_key, version, status, source_fingerprint,
        content_revision, data_json, created_by, approved_by, created_at, updated_at, approved_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), projectId, intelligence.id, moduleKey, version, `test-blueprint-${projectId}`,
      createHash('sha256').update(dataJson).digest('hex'), dataJson,
      project.created_by, project.created_by, now, now, now,
    );
  }
  return intelligence.id;
}

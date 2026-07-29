/**
 * 审计记录的中文文案。
 *
 * 「操作审计」原来直接把 `member.upsert`、`topic-opportunity.select` 这类内部
 * action 标识符和 `generation_job` 这类表名摆给用户看,读不出发生了什么。这里
 * 给 action 一个中文说法、给 entityType 一个中文资源名。
 *
 * 两条原则:
 *  1. 标识符不丢。它是排查问题时和日志、API 对得上的唯一凭据,降级为副标题保留。
 *  2. 未登记的值降级显示,不隐藏。审计是问责用的,宁可露出一条看不懂的记录,
 *     也不能让一条真实发生过的操作在界面上消失。
 *
 * 几处按字面会译错的,已按后端实际行为核对:
 *  - `member.upsert` 是「设置成员角色与权限」(新增或改都走这条,upsert 语义)。
 *  - `topic-opportunity.select` 是「选定选题」;intelligence.service.ts 在这条
 *    记录里专门写了 note 说明选定并不等于批准其依赖项,所以不能译成「批准选题」。
 *  - `*.approve` 的 status 可以是 approved / rejected / draft
 *    (approveResource:1939),所以统一译作「审批」而不是「通过」——译成「通过」
 *    会把一条驳回记录显示成批准。
 *  - `research.release.baseline-heal` 是代码契约摘要漂移后自动重建基线
 *    (research.service.ts:634 details.reason = code_contract_digest_drift),
 *    不是人工操作。
 *  - `formula.auto-upgrade` 同理,是公式变更后自动失效相关发布版本。
 */
export interface AuditCopy {
  /** 中文动作名。 */
  label: string;
  /** 是否由系统自动触发,而非人工操作。 */
  automatic?: boolean;
}

/** action → 中文。键与后端写入的 action 字面量一致。 */
export const AUDIT_ACTION_COPY: Record<string, AuditCopy> = {
  'workspace.create': { label: '创建工作区' },
  'workspace.update': { label: '修改工作区' },
  'workspace.delete': { label: '删除工作区' },
  'member.upsert': { label: '设置成员角色与权限' },
  'member.delete': { label: '移除成员' },
  'user.create': { label: '创建用户' },
  'registration.approve': { label: '通过注册申请' },
  'registration.reject': { label: '驳回注册申请' },
  'settings.update': { label: '修改模型与额度设置' },
  'api-key.create': { label: '创建 API Key' },
  'api-key.revoke': { label: '吊销 API Key' },
  'project.create': { label: '创建项目' },
  'project.update': { label: '修改项目' },
  'project.delete': { label: '删除项目' },
  'project-acl.upsert': { label: '设置项目访问权限' },
  'project-acl.delete': { label: '移除项目访问权限' },
  'knowledge.import': { label: '导入知识库资料' },
  'knowledge.recategorize': { label: '重新归类知识库资料' },
  'knowledge.delete': { label: '删除知识库资料' },
  // 起草与合并各记一次。这是模型调用的记账,不是「写入了知识库」——
  // 真正落库的是随后的 knowledge.import。
  'knowledge.enrich.model': { label: 'AI 补充知识库(模型调用)' },
  'formula.create': { label: '新建公式版本' },
  'formula.activate': { label: '启用公式版本' },
  'formula.auto-upgrade': { label: '公式变更后自动失效相关发布', automatic: true },
  'generation.create': { label: '发起生成' },
  'generation.revise': { label: '提交修改要求' },
  'intelligence.analyze': { label: '分析项目情报' },
  'intelligence.create': { label: '新建项目情报' },
  'intelligence.update': { label: '修改项目情报' },
  'intelligence.delete': { label: '删除项目情报' },
  'intelligence.approve': { label: '审批项目情报' },
  'blueprint-module.update': { label: '修改蓝图模块' },
  'blueprint-module.approve': { label: '审批蓝图模块' },
  'information-gap.create': { label: '新建信息缺口' },
  'information-gap.update': { label: '修改信息缺口' },
  'information-gap.delete': { label: '删除信息缺口' },
  'information-gap.approve': { label: '审批信息缺口' },
  'expression-strategy.create': { label: '新建表达策略' },
  'expression-strategy.update': { label: '修改表达策略' },
  'expression-strategy.delete': { label: '删除表达策略' },
  'expression-strategy.approve': { label: '审批表达策略' },
  'topic-opportunity.create': { label: '新建选题机会' },
  'topic-opportunity.update': { label: '修改选题机会' },
  'topic-opportunity.delete': { label: '删除选题机会' },
  'topic-opportunity.refresh': { label: '刷新选题机会' },
  'topic-opportunity.select': { label: '选定选题' },
  /*
    approveOpportunity 在 status=approved 时改走 selectOpportunity(记 .select),
    只有驳回或退回草稿才落到 approveResource(记 .approve)。所以这条实际只会
    在「非通过」时出现,但仍统一译作「审批」——不在文案层预判具体结果。
  */
  'topic-opportunity.approve': { label: '审批选题机会' },
  'topic-opportunity.collection': { label: '调整选题收藏状态' },
  'image-asset.create': { label: '上传图片素材' },
  'image-asset.delete': { label: '删除图片素材' },
  'image-asset.restore': { label: '恢复图片素材' },
  'image-analysis.analyze': { label: '分析图片素材' },
  'image-analysis.update': { label: '修改图片观察' },
  'image-analysis.approve': { label: '审批图片观察' },
  'coverage.create': { label: '新建覆盖记录' },
  'coverage.update': { label: '修改覆盖记录' },
  'coverage.delete': { label: '删除覆盖记录' },
  'preset.create': { label: '新建生成预设' },
  'preset.update': { label: '修改生成预设' },
  'preset.delete': { label: '删除生成预设' },
  'preset.set-default': { label: '设为默认预设' },
  'prompt-template.create': { label: '新建提示词模板' },
  'prompt-template.delete': { label: '删除提示词模板' },
  'style-profile.update': { label: '修改风格画像' },
  'research.catalog.import': { label: '导入研究目录' },
  'research.claim.create': { label: '登记研究主张' },
  'research.claim.review': { label: '复核研究主张' },
  'research.claim.link-evidence': { label: '为主张关联证据' },
  'research.source.create': { label: '登记证据来源' },
  'research.source.review': { label: '复核证据来源' },
  'research.dataset.create': { label: '登记数据集' },
  'research.dataset.review': { label: '复核数据集' },
  'research.experiment.create': { label: '登记实验' },
  'research.experiment.transition': { label: '推进实验状态' },
  'research.experiment-result.create': { label: '登记实验结果' },
  'research.experiment-result.review': { label: '复核实验结果' },
  'research.calibration.create': { label: '登记标定记录' },
  'research.calibration.review': { label: '复核标定记录' },
  'research.release.create': { label: '创建研究发布' },
  'research.release.review': { label: '复核研究发布' },
  'research.release.activate': { label: '启用研究发布' },
  'research.release.baseline': { label: '建立发布基线', automatic: true },
  'research.release.baseline-heal': { label: '契约漂移后自动重建基线', automatic: true },
};

/** entityType → 中文资源名。键是后端写入的表名/资源名字面量。 */
export const AUDIT_ENTITY_COPY: Record<string, string> = {
  workspace: '工作区',
  user: '用户',
  registration: '注册申请',
  'api-key': 'API Key',
  project: '项目',
  'knowledge-file': '知识库资料',
  knowledge_file: '知识库资料',
  formula_version: '公式版本',
  generation_job: '生成任务',
  content_package: '内容包',
  project_intelligence: '项目情报',
  project_blueprint_modules: '蓝图模块',
  information_gaps: '信息缺口',
  expression_strategies: '表达策略',
  topic_opportunity: '选题机会',
  topic_opportunities: '选题机会',
  image_asset: '图片素材',
  image_analysis_versions: '图片观察',
  analysis_task: '分析任务',
  coverage: '覆盖记录',
  preset: '生成预设',
  prompt_template: '提示词模板',
  style_profile: '风格画像',
  release_manifest: '研究发布',
  research_catalog: '研究目录',
};

/**
 * 取一条 action 的文案。未登记时回退到标识符本身。
 *
 * 回退返回 `known: false`,好让界面能把「这条还没翻译」和「这条是自动操作」
 * 区分开——两者都不该被静音处理。
 */
export function auditActionCopy(action: string): AuditCopy & { known: boolean } {
  const copy = AUDIT_ACTION_COPY[action];
  return copy ? { ...copy, known: true } : { label: action, known: false };
}

/** 取 entityType 的中文资源名;未登记时回退到原值。 */
export function auditEntityLabel(entityType: string): string {
  return AUDIT_ENTITY_COPY[entityType] ?? entityType;
}

/**
 * 资源列的显示文本:中文资源名 + 短 id。
 *
 * id 截断到 8 位:审计列表是用来扫的,完整 UUID 会把这一列撑成一堵墙,而定位
 * 单条记录时 8 位前缀在同一工作区内已足够区分。完整 id 通过 title 保留。
 */
export function auditResourceText(entityType: string, entityId?: string | null): string {
  const label = auditEntityLabel(entityType);
  const id = entityId?.trim();
  return id ? `${label} · ${id.slice(0, 8)}` : label;
}

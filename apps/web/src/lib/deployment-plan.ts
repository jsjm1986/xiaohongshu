/**
 * 发布执行方案的展示层。
 *
 * 后端为每个候选都生成了 deploymentPlan——发布身份、答复时限、评论分流、停止规则、
 * 更新触发条件——这正是运营拿到文案之后要做的事,但极简创作此前零消费,
 * 只有完整版工作台露出。这里把它整理成「摘要 + 可展开」两层:
 * 卡片正面只给下一步要做什么,完整方案收进折叠区,不把整个对象摊在面上。
 *
 * 只做整理与翻译,不做判断:方案内容一律原样带出。
 */

/** 置顶优先级用的是 CommentReferenceThread["function"] 枚举(agent-core/types.ts)。 */
export const PIN_FUNCTION_LABEL: Record<string, string> = {
  verification: '可验证信息',
  clarify: '澄清误解',
  answer: '直接回答',
  counterexample: '反例说明',
  next_step: '下一步指引',
  surface_gap: '点出信息缺口',
};

/** 答复侧的可追责身份。reader_question_template 是提问侧模板,不是答复身份。 */
const IDENTITY_LABEL: Record<string, string> = {
  publisher: '发布账号',
  author: '作者本人',
  brand: '品牌方',
  staff: '工作人员',
  expert: '专业人士',
  reader_question_template: '读者提问模板',
};

export interface RoutingRule {
  route: string;
  condition: string;
  action: string;
}

export interface PinnedThreadView {
  /** 问题摘录:运营者按它在评论区认出要置顶哪条 */
  excerpt: string;
  functionLabel: string | null;
}

export interface DeploymentPlanView {
  identityLabel: string;
  ownedFirstComment: boolean;
  /** 答复时限承诺;没有则 null */
  sla: string | null;
  pinLabels: string[];
  /** 逐包置顶建议(指到终稿具体话术);历史包没有,回退显示 pinLabels 类别 */
  pinnedThreads: PinnedThreadView[];
  /** 本篇的禁答清单:被真实评论问到时不代填,进更新队列 */
  doNotAnswer: string[];
  routing: RoutingRule[];
  updateTriggers: string[];
  updatePolicy: string[];
  stopRules: string[];
  /** 是否有值得展开的明细。只有摘要字段时不给展开入口,免得点开是空的。 */
  hasDetail: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => Boolean(s)) : []);

export function deploymentPlanView(plan: unknown): DeploymentPlanView | null {
  if (!plan || typeof plan !== 'object') return null;
  const p = plan as Record<string, unknown>;
  const identity = str(p.postingIdentity);
  const sla = str(p.sla);
  const pinLabels = list(p.pinPriority).map((fn) => PIN_FUNCTION_LABEL[fn] ?? fn);
  const pinnedThreads: PinnedThreadView[] = (Array.isArray(p.pinnedThreads) ? p.pinnedThreads : [])
    .map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const excerpt = str(item.excerpt);
      const fn = str(item.function);
      return excerpt ? { excerpt, functionLabel: fn ? (PIN_FUNCTION_LABEL[fn] ?? fn) : null } : null;
    })
    .filter((item): item is PinnedThreadView => Boolean(item));
  const doNotAnswer = list(p.doNotAnswer);
  const updateTriggers = list(p.updateTriggers);
  const updatePolicy = list(p.updatePolicy);
  const stopRules = list(p.stopRules);

  // 缺 route 或 action 的条目没有可操作性,剔除而不是渲染成空行
  const routing: RoutingRule[] = (Array.isArray(p.liveRouting) ? p.liveRouting : [])
    .map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return { route: str(r.route) ?? '', condition: str(r.condition) ?? '', action: str(r.action) ?? '' };
    })
    .filter((r) => r.route && r.action);

  // 全空视为没有方案:整块不渲染
  if (!identity && !sla && pinLabels.length === 0 && routing.length === 0
      && updateTriggers.length === 0 && updatePolicy.length === 0 && stopRules.length === 0) {
    return null;
  }

  return {
    identityLabel: identity ? (IDENTITY_LABEL[identity] ?? identity) : '未指定',
    ownedFirstComment: p.ownedFirstComment === true,
    sla,
    pinLabels,
    pinnedThreads,
    doNotAnswer,
    routing,
    updateTriggers,
    updatePolicy,
    stopRules,
    hasDetail: routing.length > 0 || stopRules.length > 0 || updateTriggers.length > 0
      || updatePolicy.length > 0 || pinnedThreads.length > 0 || doNotAnswer.length > 0,
  };
}

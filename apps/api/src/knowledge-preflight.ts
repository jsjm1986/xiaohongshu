/**
 * 知识库完善度预检:一条信息缺口的答案,到了生成那一步还站得住吗。
 *
 * 现有的判断只有前端 `gapStats`(看 answer 有没有、sourceStatus 是什么),而生成端
 * 真正的硬门在 engine.ts:892——`required && !((answer || framework) && evidenceIds.length)`。
 * 两边不是同一个标准,于是仪表盘显示「已确认,可直接引用」的缺口,生成时可能被丢掉。
 *
 * 这里复刻生成端 `bindGapEvidence` 的判定,把缺口分成五档,其中 `will_be_dropped`
 * 是当前界面完全看不见的一档。
 *
 * `bindGapEvidence` 只接受三类事实来源:当前知识分节、任务中明确填写的项目字段、
 * 以及带批准人和批准时间的逐条人工确认。预检可精确判断知识分节与人工确认；任务
 * 字段只在生成配置中存在，因此本结果仍是保守下界。
 */

/** 缺口答案的证据强度分档。 */
export type PreflightTier =
  /** 有上传资料的分节支撑。最强,任何证据路径都成立。 */
  | 'evidence_backed'
  /** 无资料支撑,但有批准人和批准时间冻结的项目负责人确认。 */
  | 'approved_only'
  /**
   * 分析器判定资料里有出处,但那些引用已经失效(资料存过新版本或被删除)。
   *
   * 当前生成不会采用这条旧引用；必须重新分析或重新上传资料后才能恢复事实资格。
   */
  | 'evidence_stale'
  /** 无资料支撑,也没有真实人工审批元数据；生成会丢弃这条答案。 */
  | 'will_be_dropped'
  /** 没有答案。 */
  | 'blank';

export interface PreflightGapInput {
  id: string;
  label: string;
  status: string;
  required: boolean;
  answer: string;
  framework: string;
  /** 缺口自己声明的证据 id。仅用于回显差异,不参与分档——生成端也不信任它,会重算。 */
  declaredEvidenceIds: readonly string[];
  category: string;
  /**
   * 缺口答案的来源标记,由分析器或缺口编辑器写。
   *
   * 只用来区分「分析器说有出处」与「用户自己填的」:前者引用失效时要说实话
   * (evidence_stale),后者本来就是人工确认,不该改口。调用方须先过白名单——
   * 库里实测有 'unacknowledged' 这种不在联合类型里的值。
   */
  sourceStatus?: string;
  /** 当前行是否具有真实的批准状态、批准人和批准时间。 */
  humanConfirmed: boolean;
  /** 由调用方跑 findSupportingSectionEvidenceIds 得出的、内容支撑这条答案的证据 id。 */
  sectionEvidenceIds: readonly string[];
  /**
   * 项目当前全部可用的证据 id。
   *
   * 判断「声明的引用是否失效」必须对着这个集合,不能对着 sectionEvidenceIds——
   * 后者是「内容支撑这条答案的分节」,两者是不同的问题。混用会把大量仍然存在的
   * 引用误报成失效:实测某项目 69 条引用里只有 1 条真失效,却报了 69 条。
   */
  availableEvidenceIds: ReadonlySet<string>;
}

export interface PreflightGapResult {
  id: string;
  label: string;
  status: string;
  required: boolean;
  category: string;
  tier: PreflightTier;
  /** 真实命中的知识分节证据。 */
  sectionEvidenceIds: string[];
  /** 声明了却没能命中任何知识分节的证据 id。 */
  staleDeclaredEvidenceIds: string[];
  /** 给用户看的、可操作的说明。 */
  reasons: string[];
}

/** 单条缺口分档。纯函数,不碰数据库也不读盘。 */
export function classifyGap(input: PreflightGapInput): PreflightGapResult {
  const answer = input.answer.trim();
  const framework = input.framework.trim();
  const proposed = answer || framework;
  const sectionEvidenceIds = [...new Set(input.sectionEvidenceIds)];
  const declared = [...new Set(input.declaredEvidenceIds)];
  // 失效 = 这个 id 已经不在项目的可用证据集合里(资料被删、或被存成新版本导致
  // evidenceId 全变)。不是「没能支撑这条答案」——那是另一件事,由分档表达。
  const staleDeclaredEvidenceIds = declared.filter((id) => !input.availableEvidenceIds.has(id));
  const reasons: string[] = [];

  let tier: PreflightTier;
  if (!proposed) {
    tier = 'blank';
    reasons.push('还没有答案,需要你补充真实资料。');
  } else if (sectionEvidenceIds.length) {
    tier = 'evidence_backed';
    reasons.push(`答案能在已上传资料里找到支撑(${sectionEvidenceIds.length} 处分节)。`);
  } else if (input.sourceStatus === 'supplied_fact' && staleDeclaredEvidenceIds.length > 0) {
    tier = 'evidence_stale';
    reasons.push('原本有资料出处,但引用已失效(资料存过新版本或被删除)。重新分析会一并更新;资料已删除的,要重新上传才能再有出处。');
  } else if (input.sourceStatus === 'user_supplied' && input.humanConfirmed) {
    tier = 'approved_only';
    reasons.push('答案没有对应的上传资料,但已由项目负责人明确确认。生成会采用,来源不是独立外部核验。');
  } else {
    tier = 'will_be_dropped';
    reasons.push('答案没有当前资料支撑,也没有有效的项目负责人审批记录,生成时会被丢弃。请完成确认或补充资料。');
  }

  // 新档的首句已经说了引用失效,再追加一条就是同一件事说两遍。
  if (staleDeclaredEvidenceIds.length && tier !== 'evidence_stale') {
    /*
     * 不说「需要重新选择」。
     *
     * 引用批量失效的常见原因是资料存了新版本——evidenceId 含 documentId(每版新 uuid),
     * 所以一次保存就会让该文件所有引用同时失效。这种情况下逐条手工重选是错的指引:
     * markProjectStale 已经把分析打成 stale,重新分析会产出带新 evidenceId 的缺口,
     * 一次解决全部。
     */
    reasons.push(`有 ${staleDeclaredEvidenceIds.length} 条引用的证据已失效(资料存过新版本或被删除),重新分析会一并更新。`);
  }

  return {
    id: input.id,
    label: input.label,
    status: input.status,
    required: input.required,
    category: input.category,
    tier,
    sectionEvidenceIds,
    staleDeclaredEvidenceIds,
    reasons,
  };
}

/**
 * 项目分析的状态。
 *
 * 没有这个字段时,「一条缺口都没有」和「所有缺口都落实了」在数据上长得一样——两者
 * 的 tiers 全为 0、requiredOpen 为空。但含义相反:后者可以生成,前者根本还没分析,
 * prepareGenerationPlan 会直接抛「An approved project analysis is required」。
 *
 * 生成真正要求的是一条 status='approved' 的 project_intelligence,所以按它取值。
 */
export type AnalysisState =
  /** 从没分析过。上传完资料的下一步就是它。 */
  | 'missing'
  /** 分析跑完了,但还没确认。 */
  | 'draft'
  /** 已确认,可以生成。 */
  | 'approved'
  /** 资料变动后失效,要重新分析。 */
  | 'stale';

export interface PreflightSummary {
  analysis: AnalysisState;
  /** 所有必答缺口都站得住。与 engine.ts:892 同判据。分析未就绪时恒为 false。 */
  canGenerate: boolean;
  /**
   * 站不住的必答缺口,**只含 status='approved' 的行**(见 blocksGeneration)。
   *
   * `blank` / `will_be_dropped` 会让生成时正文出现「关于X我还没问明白」;
   * `evidence_stale` 不会(答案仍被采用),但它的结论无法用当前资料复核,
   * 同样不该就这么生成。
   */
  requiredOpen: Array<{ id: string; label: string; tier: PreflightTier }>;
  tiers: Record<PreflightTier, number>;
  /** 按缺口分类看覆盖:总数答得多但全挤在一个维度,和均匀覆盖不是一回事。 */
  byCategory: Array<{ category: string; total: number; settled: number }>;
}

/** 一条缺口是否算「站得住」:生成端会保留它的答案。 */
function settled(tier: PreflightTier): boolean {
  return tier === 'evidence_backed' || tier === 'approved_only';
}

/**
 * 这一行会不会真的进生成。
 *
 * 预检取数不过滤 status(stale 的缺口恰恰最该提醒用户),但生成端只消费
 * status='approved' 的行(intelligence.service.approvedRows)。所以「挣住生成」
 * 只能由 approved 行决定,否则会造出一个用户消不掉的错误结论:
 * insertAnalyzedGap 只插入、从不清理被取代的旧行,一条 status='stale' 的必答缺口
 * 会永远显示「还不能生成」,而重新分析也清不掉它。
 *
 * 注意:分档计数与 byCategory 仍统计全部行——用户要看见知识库全貌,
 * 被裁掉的只有 requiredOpen 这个硬门。
 */
function blocksGeneration(row: PreflightGapResult): boolean {
  return row.status === 'approved' && row.required && !settled(row.tier);
}

/**
 * 把 project_intelligence.status 映射成分析状态。
 *
 * 认不出的取值一律当 'missing':宁可提示用户去分析一次,也不要因为多了一个未知状态
 * 就显示成「可以生成」。
 */
export function analysisStateFrom(status: string | undefined | null): AnalysisState {
  if (status === 'approved') return 'approved';
  if (status === 'stale') return 'stale';
  if (status === 'draft') return 'draft';
  return 'missing';
}

export function summarize(
  rows: readonly PreflightGapResult[],
  analysis: AnalysisState = 'missing',
): PreflightSummary {
  const tiers: Record<PreflightTier, number> = {
    evidence_backed: 0,
    approved_only: 0,
    evidence_stale: 0,
    will_be_dropped: 0,
    blank: 0,
  };
  for (const row of rows) tiers[row.tier] += 1;

  const requiredOpen = rows
    .filter(blocksGeneration)
    .map((row) => ({ id: row.id, label: row.label, tier: row.tier }));

  const byCategoryMap = new Map<string, { total: number; settled: number }>();
  for (const row of rows) {
    const key = row.category || '未分类';
    const entry = byCategoryMap.get(key) ?? { total: 0, settled: 0 };
    entry.total += 1;
    if (settled(row.tier)) entry.settled += 1;
    byCategoryMap.set(key, entry);
  }

  return {
    analysis,
    /*
     * 分析没就绪时一律 false。此前只看 requiredOpen 是否为空,于是刚上传完资料、
     * 一条缺口都还没有的项目会被判成「可以生成」——那时候生成必然被拦。
     */
    canGenerate: analysis === 'approved' && requiredOpen.length === 0,
    requiredOpen,
    tiers,
    byCategory: [...byCategoryMap.entries()]
      .map(([category, value]) => ({ category, ...value }))
      .sort((left, right) => left.category.localeCompare(right.category, 'zh-CN')),
  };
}

/**
 * 随预检结果一起返回的口径说明。
 *
 * 不能让这个结论被当成「知识库质量分」:分档判的是答案有没有证据站得住,不是内容好不好。
 * 而且它是保守下界(见文件头)。这两点必须写在返回体里,不能只写在文档里。
 */
export const PREFLIGHT_NOTE = '本预检与生成端同一判据(证据是否支撑答案),纯本地计算,不调用模型。'
  + '它判断的是答案能否被生成采用,不是内容质量评分。'
  + '因为部分证据路径依赖生成时的上下文,结论是保守下界:显示有资料支撑的一定有。'
  // 不写「重新分析重建引用」:资料被整份删掉时重建不出来(实测有活的知识文件为 0
  // 而大批缺口落在本档的项目)。只承诺「一并更新」,并点出删除后要重新上传。
  + '标为「引用已失效」的仍会被生成采用,但没有当前资料为它作证:重新分析会一并更新引用,'
  + '若原资料已删除,要重新上传才能再有出处。';

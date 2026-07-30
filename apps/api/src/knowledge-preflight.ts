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
 * 能复刻到什么程度:`bindGapEvidence` 走三条证据路径——
 *   1. findSupportingSectionEvidenceIds(知识分节)
 *   2. taskEvidenceSupports(生成配置里的项目卖点/任务主题)
 *   3. planningEvidenceSupports(已批准的规划上下文)
 * 路径 2、3 依赖生成时才存在的 ResolvedGenerationConfig 与 planningContext,知识库
 * 层面拿不到,所以本模块只精确复刻路径 1,对路径 3 做保守复刻(只判断「格式会不会
 * 破坏自证」)。
 * 结论是**保守下界**:预检说有资料支撑的一定有;说会被丢的,极少数情况下可能被
 * 路径 2 救回。另有一档 `evidence_stale` 是「生成时会被采用,但没有当前资料为它
 * 作证」——站得住不等于可复核,这一档说的是后者。
 */

/** 缺口答案的证据强度分档。 */
export type PreflightTier =
  /** 有上传资料的分节支撑。最强,任何证据路径都成立。 */
  | 'evidence_backed'
  /** 无资料支撑,但答案能经已批准的规划上下文自证。生成会采用,依据是「有人填了并批准」。 */
  | 'approved_only'
  /**
   * 分析器判定资料里有出处,但那些引用已经失效(资料存过新版本或被删除)。
   *
   * 生成时答案仍会被采用(靠规划上下文自证),但**没有任何当前资料为它作证**——
   * 结论不可复核。所以它既不是 evidence_backed,也不该谎报成「你填写并确认过」。
   */
  | 'evidence_stale'
  /** 无资料支撑,且格式破坏了自证。生成会静默丢弃这条答案。 */
  | 'will_be_dropped'
  /** 没有答案。 */
  | 'blank';

/**
 * 复刻 planningEvidenceSupports 的归一化(engine.ts:527)。
 *
 * 两边必须逐字一致,否则预检结论和生成行为会分叉。
 */
export function normalizeForSelfProof(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

/**
 * 答案能否经规划上下文自证。
 *
 * planningEvidenceSupports 把 informationGaps 自己序列化进证据源,所以答案本来必然
 * 命中自己——除非 JSON 转义在中间插了字符:换行变成字面 `\n` 两字符、半角双引号变成
 * `\"`,而被比对的语句经 `\s+` 归一后没有那个反斜杠,子串匹配就落空。
 *
 * 「已有批准答案」输入框是 textarea,多行是常态,所以这一档在真实使用里并不罕见。
 * 实测:单行纯文本、中文标点、中文引号「」都能自证;含换行、含半角 `"` 不能。
 */
export function selfProofSurvives(answer: string): boolean {
  const statement = normalizeForSelfProof(answer.trim());
  if (statement.length < 2) return false;
  // 复刻真实链路:答案先随缺口一起被 JSON.stringify,再对结果做同样的归一。
  const serialized = normalizeForSelfProof(JSON.stringify({ answer }));
  return serialized.includes(statement);
}

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
  } else if (
    /*
     * 三个条件都必需:
     * - supplied_fact:分析器当初给过出处。
     * - 有失效引用:那个出处**确实断了**的实证。只看 sourceStatus 会替一个可能已
     *   过时的判定作保——资料被整份删掉时,说「重新分析会重建引用」是空头承诺。
     * - selfProofSurvives:格式坏的答案是真会被丢弃,得留给 will_be_dropped 去说
     *   清是哪个字符;重新分析修不了换行。
     */
    input.sourceStatus === 'supplied_fact'
    && staleDeclaredEvidenceIds.length > 0
    && selfProofSurvives(proposed)
  ) {
    tier = 'evidence_stale';
    /*
     * 不承诺「会重建引用」。资料被整份删掉时重建不出来——实测项目「眼袋王」活的知识
     * 文件为 0、47 条缺口落在本档,重新分析没有任何资料可引。措辞与 :174 那条通用提示
     * 取同一口径:把「存过新版本」和「被删除」两种可能都说出来,只承诺「一并更新」。
     */
    reasons.push('原本有资料出处,但引用已失效(资料存过新版本或被删除)。重新分析会一并更新;资料已删除的,要重新上传才能再有出处。');
  } else if (selfProofSurvives(proposed)) {
    tier = 'approved_only';
    reasons.push('答案没有对应的上传资料,依据是你填写并确认过。生成会采用,但它不是来自资料的事实。');
  } else {
    tier = 'will_be_dropped';
    reasons.push('答案没有对应的上传资料,而且格式会让它在生成时被丢弃。');
    /*
     * 这一档的价值全在「怎么办」,所以要指名道姓说清是哪种字符。
     * 会破坏自证的都是 JSON 转义会插入反斜杠的字符,实测:换行、制表符、半角双引号、
     * 反斜杠本身。中文引号「」和中文标点不受影响。
     */
    if (/[\n\r]/u.test(proposed)) reasons.push('答案里有换行——改成一行,或把这段内容作为资料上传。');
    if (/\t/u.test(proposed)) reasons.push('答案里有制表符——换成空格,或把这段内容作为资料上传。');
    if (proposed.includes('"')) reasons.push('答案里有半角双引号 " ——换成中文引号「」,或把这段内容作为资料上传。');
    if (proposed.includes('\\')) reasons.push('答案里有反斜杠 \\ ——去掉它,或把这段内容作为资料上传。');
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
  + '标为「引用已失效」的仍会被生成采用,但没有当前资料为它作证,需要重新分析重建引用。';

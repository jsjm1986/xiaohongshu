import type { KnowledgeFile, KnowledgePreflight, KnowledgePreflightTier } from '../types';

/**
 * 知识库页面仪表盘的取数逻辑。
 *
 * 两件事在这里修:
 *
 * 1. **份数按文件算,不按版本算。** `/api/knowledge` 返回同名文件的**全部版本**
 *    (knowledge.service.list 是 `ORDER BY category, filename, version`,不折叠),
 *    而页面此前直接对它 `files.length`、`reduce(size)`、`filter(kind)`。于是一份资料
 *    被 AI 补充过一次,就显示成「文件总数 2 份」「已知事实 1 份 + 推理与猜想 1 份」,
 *    字节数也是两版相加。实测线上项目正是这个现象。
 *
 * 2. **「已知事实 N 份」会指向已经不生效的版本。** 生成只读最新版
 *    (generation.service.loadKnowledge 的 window function),而补充保存的新版本
 *    evidenceStatus 强制落「猜想」。原文 v1 是「已知事实」时,旧算法把它计进
 *    「可直接引用」,但真正进生成的是 v2(猜想)。折叠后这个数字会如实变化。
 */

/** 同名取最高版本。生成端 loadKnowledge / evidenceSections 都是这个语义。 */
export function latestFiles(files: readonly KnowledgeFile[]): KnowledgeFile[] {
  const byName = new Map<string, KnowledgeFile>();
  for (const file of files) {
    const previous = byName.get(file.name);
    // version 缺省视作 1:后端 NOT NULL DEFAULT 1,这里只防御异常载荷。
    if (!previous || (file.version ?? 1) > (previous.version ?? 1)) byName.set(file.name, file);
  }
  return [...byName.values()];
}

/** 某个文件名的历史版本(不含最新版),新的在前。供详情弹窗做版本回看。 */
export function historyVersions(files: readonly KnowledgeFile[], name: string): KnowledgeFile[] {
  const sameName = files.filter((file) => file.name === name)
    .sort((left, right) => (right.version ?? 1) - (left.version ?? 1));
  return sameName.slice(1);
}

export interface FileStats {
  /** 资料份数(按文件名去重后)。 */
  fileCount: number;
  /** 全部版本的行数。和 fileCount 不等时说明有历史版本。 */
  versionCount: number;
  /** 生效版本的字节合计——旧算法把各版本相加,会虚高近一倍。 */
  totalBytes: number;
  fact: number;
  reasoning: number;
  banned: number;
}

export function fileStats(all: readonly KnowledgeFile[]): FileStats {
  const latest = latestFiles(all);
  return {
    fileCount: latest.length,
    versionCount: all.length,
    totalBytes: latest.reduce((sum, file) => sum + (file.size || 0), 0),
    fact: latest.filter((file) => file.kind === '已知事实').length,
    reasoning: latest.filter((file) => file.kind === '方法论推理' || file.kind === '猜想').length,
    banned: latest.filter((file) => file.kind === '禁止表达').length,
  };
}

export const TIER_LABEL: Record<KnowledgePreflightTier, string> = {
  evidence_backed: '有资料支撑',
  approved_only: '仅人工确认',
  evidence_stale: '引用已失效',
  will_be_dropped: '生成会丢弃',
  blank: '还没有答案',
};

/**
 * 每一档的说明。措辞是这个功能的全部价值所在,不能含糊:
 * `approved_only` 必须让用户看出「它不是来自你上传的资料」,
 * `will_be_dropped` 必须让用户知道这条会被静默丢掉,
 * `evidence_stale` 不能沿用「你填写并确认过」——那批答案是分析器给的,用户没填过。
 */
export const TIER_NOTE: Record<KnowledgePreflightTier, string> = {
  evidence_backed: '答案能在你上传的资料里找到出处',
  approved_only: '你填写并确认过,生成会用;但它不是资料里的事实',
  evidence_stale: '出处随资料新版本失效,重新分析会重建',
  will_be_dropped: '生成时会被丢掉,需要改格式或补资料',
  blank: '需要你补充真实资料',
};

export type InstrumentTone = 'ok' | 'warn' | 'error' | 'ai' | 'blue';

export const TIER_TONE: Record<KnowledgePreflightTier, InstrumentTone> = {
  evidence_backed: 'ok',
  approved_only: 'ai',
  // 用 warn 而非 danger:它可修复,且重新分析就能自愈,与 blank 同级。
  evidence_stale: 'warn',
  will_be_dropped: 'error',
  blank: 'warn',
};

export interface PreflightHeadline {
  /** 主结论文案。 */
  text: string;
  tone: InstrumentTone;
  /** 需要用户处理的条数(会丢弃 + 引用失效 + 无答案)。 */
  actionable: number;
  /** 下一步该做什么。没有明确下一步时为空。 */
  nextStep: string;
  /** 下一步是否是「去分析」——决定要不要给跳转按钮。 */
  needsAnalysis: boolean;
}

/**
 * 主结论。用绝对条数,不用「16/17」这种比率——分母是模型每轮随机产出的
 * (阶段 2 提示词写的是「Produce 12 to 18 diverse information gaps」),跨轮不可比,
 * 拿它当完整度会让用户以为覆盖了 94%。
 */
export function preflightHeadline(preflight: KnowledgePreflight | null): PreflightHeadline | null {
  if (!preflight) return null;
  const { tiers, requiredOpen, canGenerate, analysis } = preflight;
  /*
   * 引用失效同样需要用户动手(去重新分析),所以计入。
   *
   * 但这个数字和 actionableGaps 的清单长度**并不相等**,别当成同一口径:
   * 那个 filter 还会收纳「档位已落实、可引用却有失效引用」的缺口
   * (evidence_backed / approved_only 带 staleDeclaredEvidenceIds),
   * 实测 8 个项目共 35 行属于这种——它们会被列出但不计入本数。
   *
   * 可以接受:本数回答「有多少条答案生成时立不住」,清单回答「有多少条值得你去看」,
   * 后者本就该更宽。要紧的是别反过来——列表里少于计数才是藏问题。
   */
  const actionable = tiers.will_be_dropped + tiers.evidence_stale + tiers.blank;
  const base = { actionable, needsAnalysis: false };

  /*
   * 分析状态优先判,而且必须先判。
   *
   * 刚上传完资料时缺口数为 0,tiers 全为 0、requiredOpen 为空——和「所有缺口都落实」
   * 在数据上完全一样。此前只看后者,于是显示「可以生成,缺口都已落实」,而那时
   * prepareGenerationPlan 会直接抛「An approved project analysis is required」。
   * 用户上传完看不到任何下一步提示,正是这个原因。
   */
  /*
   * 指路要说用户在侧栏看得见的名字(「内容生成」),不是路由或内部组件名。
   * 分析、蓝图确认、缺口池都在那个频道里(GeneratorPage 默认 simple 模式)。
   */
  if (analysis === 'missing') {
    return {
      ...base,
      text: '下一步:做项目分析',
      tone: 'warn',
      nextStep: '资料已就位。到「内容生成」跑一次项目分析,它会读这些资料,产出蓝图、还缺什么、以及可写的选题。',
      needsAnalysis: true,
    };
  }
  if (analysis === 'stale') {
    return {
      ...base,
      text: '下一步:重新分析',
      tone: 'warn',
      // 必须点明「一并更新」:用户看到满屏「引用已失效」的第一反应是去逐条重选证据,
      // 而 evidenceId 含 documentId,一次保存就让该文件所有引用同时失效——手工重选
      // 是白做工,重新分析才是一次解决的路径。
      nextStep: '资料改动过,之前的分析已失效。到「内容生成」重新分析——缺口和证据引用会一并更新,不需要你逐条重选。',
      needsAnalysis: true,
    };
  }
  if (analysis === 'draft') {
    return {
      ...base,
      text: '下一步:确认分析结果',
      tone: 'warn',
      nextStep: '分析已完成但还没确认。到「内容生成」确认情报与蓝图模块后才会进入生成。',
      needsAnalysis: true,
    };
  }

  // 分析已确认,往下才是缺口层面的结论
  if (!canGenerate) {
    /*
     * 引用失效要单独说。实测存在 analysis='approved' 而引用全失效的项目
     * (零个知识文件 + 49 条 supplied_fact 缺口),此时旧文案让用户「改掉会被
     * 丢弃的答案格式」——改格式没用,要做的是重新分析重建引用。
     */
    const staleOpen = requiredOpen.filter((gap) => gap.tier === 'evidence_stale').length;
    if (staleOpen === requiredOpen.length) {
      return {
        ...base,
        text: `还不能生成:${requiredOpen.length} 条必答缺口的引用已失效`,
        tone: 'error',
        nextStep: '这些答案的资料出处已随新版本失效。到「内容生成」重新分析,引用会一并重建。',
        needsAnalysis: true,
      };
    }
    return {
      ...base,
      text: `还不能生成:${requiredOpen.length} 条必答缺口没落实`,
      tone: 'error',
      nextStep: staleOpen > 0
        ? `补上缺资料的那几条,或改掉会被丢弃的答案格式;其中 ${staleOpen} 条是引用失效,重新分析会一并重建。`
        : '补上这几条的真实资料,或改掉会被丢弃的答案格式。',
      // needsAnalysis 是必填 boolean,不能条件展开。混合情形也给 true:
      // 重新分析是其中一部分缺口的唯一出路,不给跳转等于藏起出路。
      needsAnalysis: staleOpen > 0,
    };
  }
  if (tiers.will_be_dropped > 0) {
    return {
      ...base,
      text: `可以生成,但 ${tiers.will_be_dropped} 条答案会被丢弃`,
      tone: 'warn',
      nextStep: '这些答案生成时用不上,按下面的提示改格式或补资料。',
    };
  }
  if (tiers.blank > 0) {
    return {
      ...base,
      text: `可以生成,还有 ${tiers.blank} 条缺口没答案`,
      tone: 'warn',
      nextStep: '补上这些缺口的真实资料,文案能更有依据。',
    };
  }
  return { ...base, text: '可以生成,缺口都已落实', tone: 'ok', nextStep: '' };
}

/** 按分类的覆盖,只回有缺口的分类,`settled < total` 的排前面——那才是要看的。 */
export function categoryCoverage(preflight: KnowledgePreflight | null): KnowledgePreflight['byCategory'] {
  if (!preflight) return [];
  return [...preflight.byCategory].sort((left, right) => {
    const leftOpen = left.total - left.settled;
    const rightOpen = right.total - right.settled;
    if (leftOpen !== rightOpen) return rightOpen - leftOpen;
    return left.category.localeCompare(right.category, 'zh-CN');
  });
}

/** 需要用户动手的缺口,会丢弃的排在无答案之前——前者是隐性故障,更急。 */
export function actionableGaps(preflight: KnowledgePreflight | null): KnowledgePreflight['gaps'] {
  if (!preflight) return [];
  // 会丢弃的最急(隐性故障);引用失效次之(答案会被采用,但结论无法复核);
  // 再是无答案;仅人工确认与有资料支撑排最后。
  const weight: Record<KnowledgePreflightTier, number> = {
    will_be_dropped: 0,
    evidence_stale: 1,
    blank: 2,
    approved_only: 3,
    evidence_backed: 4,
  };
  return preflight.gaps
    .filter((gap) => gap.tier === 'will_be_dropped' || gap.tier === 'blank' || gap.staleDeclaredEvidenceIds.length > 0)
    .sort((left, right) => {
      // 必答的先看
      if (left.required !== right.required) return left.required ? -1 : 1;
      return weight[left.tier] - weight[right.tier];
    });
}

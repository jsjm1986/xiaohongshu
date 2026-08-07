import type { ContentPreset, GenerationJob, TopicOpportunity } from '../types';
import type { SimpleSettingOverrides } from './simple-generation';
import { extractRecipe, resolveRecipeTargets, type RetryPublishingContract } from './quick-recipe';

/**
 * 批量重试的规划层。
 *
 * 为什么需要它:单条重试(BatchBoard.retry)每次要 4 个请求——选题列表、预设列表、
 * 审批、建批次。实测有 70 条失败,逐条点就是 ~280 个请求,而且同一配方会被重复提交、
 * 白烧额度。这里把 N 条失败先规划成一次批次提交,并如实报告哪些重试不了。
 *
 * 只做规划,不发请求:请求交给调用方(便于用 node:test 直接测)。
 */

export interface RetryTarget {
  opportunityId: string;
  presetId: string | undefined;
  overrides: SimpleSettingOverrides;
  imageAssetIds: string[];
  publishing: RetryPublishingContract;
  /** 归并到这个目标的原任务 id(去重后可能多于一个) */
  jobIds: string[];
}

export interface RetrySkip {
  jobId: string;
  topic: string;
  reason: string;
}

export interface BatchRetryPlan {
  retryable: RetryTarget[];
  skipped: RetrySkip[];
  /** 因配方重复而被合并掉的任务数 */
  deduped: number;
  /** 回落提示(如预设已删除),已去重 */
  warnings: string[];
}

/** 规划批量重试:只处理 status==='failed' 的任务。 */
export function planBatchRetry(
  jobs: GenerationJob[],
  opportunities: TopicOpportunity[],
  presets: ContentPreset[],
): BatchRetryPlan {
  const byKey = new Map<string, RetryTarget>();
  const skipped: RetrySkip[] = [];
  const warnings = new Set<string>();
  let deduped = 0;

  for (const job of jobs) {
    if (job.status !== 'failed') continue;

    const targets = resolveRecipeTargets(extractRecipe(job), opportunities, presets);
    for (const w of targets.warnings) warnings.add(w);

    if (!targets.opportunityId) {
      // 孤儿任务:选题已从池中删除。必须报出来,不能少重试一条还不说。
      skipped.push({
        jobId: job.id,
        topic: job.topic || '未命名选题',
        reason: targets.warnings[0] ?? '原选题已不在选题池，无法重试',
      });
      continue;
    }

    // 发布视角和真实作者事实也是配方真值。机构稿、用户稿或不同作者素材
    // 即使选题/预设相同也绝不能合并成一次重试。
    const key = JSON.stringify([
      targets.opportunityId,
      targets.presetId ?? "",
      targets.overrides,
      targets.imageAssetIds,
      targets.publishing,
    ]);
    const existing = byKey.get(key);
    if (existing) {
      existing.jobIds.push(job.id);
      deduped += 1;
      continue;
    }
    byKey.set(key, {
      opportunityId: targets.opportunityId,
      presetId: targets.presetId,
      overrides: targets.overrides,
      imageAssetIds: targets.imageAssetIds,
      publishing: targets.publishing,
      jobIds: [job.id],
    });
  }

  return { retryable: [...byKey.values()], skipped, deduped, warnings: [...warnings] };
}

// ---- 失败原因汇总 ----

export interface FailureGroup {
  label: string;
  count: number;
  /** true 表示这类问题重试也解决不了,需要先处理外部条件 */
  blocking: boolean;
}

export interface FailureDigest {
  total: number;
  groups: FailureGroup[];
  /** 命中 blocking 原因的任务数:这些重试也会再失败,且每次都扣额度 */
  blockingCount: number;
}

/**
 * 错误原文 → 可读原因。原文是英文模型层报错混中文前缀,直接展示给运营没有意义。
 * blocking=true 的几类重试也没用(余额、密钥),必须先解决外部条件——
 * 否则用户会反复点重试反复失败。
 */
const PATTERNS: Array<{ match: RegExp; label: string; blocking: boolean }> = [
  // 后端 generation.service.ts:216——启动时把仍在 queued/running 的任务标失败。
  // 实测这是最主要的失败原因(21 条里 11 条),重试完全可恢复,必须单独归类,
  // 否则会混进「未归类」里显示成一串原文。
  { match: /应用重启导致任务中断/, label: '服务重启中断，重试即可恢复', blocking: false },
  // 后端快失败写入的中文原因(provider-outage.ts)。必须排在英文余额规则**之前**:
  // 「无可用账号」「凭据冷却」这两条不含 balance 字样,若靠下面的英文规则兜不住,
  // 会掉进「未归类」显示成一长串原文。
  { match: /余额不足/, label: '模型账户余额不足，充值后再重试', blocking: true },
  { match: /暂无可用账号/, label: '模型服务暂无可用账号，稍后重试', blocking: false },
  { match: /凭据全部在冷却中/, label: '模型服务凭据冷却中，稍后重试', blocking: false },
  { match: /Insufficient Balance|insufficient_quota|balance/i, label: '模型账户余额不足，充值后再重试', blocking: true },
  { match: /invalid[_ ]api[_ ]key|unauthorized|401/i, label: '模型密钥无效或已过期', blocking: true },
  { match: /rate[_ ]limit|429|too many requests/i, label: '被模型服务限流，稍后重试', blocking: false },
  { match: /response_format/i, label: '模型不支持所需的返回格式，需换模型', blocking: true },
  { match: /unexpected EOF|ECONNRESET|socket hang up|timeout/i, label: '模型响应中断，重试通常可恢复', blocking: false },
  { match: /did not contain a complete JSON|JSON/i, label: '模型输出不完整，重试通常可恢复', blocking: false },
  { match: /expected \d+|returned \d+ threads/i, label: '生成结构不符合编排要求，重试可能仍失败', blocking: false },
];

/**
 * 单条失败原因 → 可读说明 + 该不该重试。
 *
 * 与 failureDigest 共用同一张 PATTERNS 表。分出来是因为实测缺口:批次摘要里显示的是
 * 归类好的中文(「模型账户余额不足,充值后再重试」),而**单条失败行**直接把原文摊出来
 * ——付费用户在产出区看到的是
 * 「生成失败：模型候选 1 生成失败,任务已停止且未生成可发布降级稿：Model provider
 * rejected the request: Insufficient Balance」。
 *
 * 归不了类时保留原文:排查全靠它,不能吞掉信息。
 */
export function failureReason(error: string | undefined | null): { label: string; blocking: boolean; raw: string } {
  const raw = (error ?? '').trim();
  const hit = PATTERNS.find((p) => p.match.test(raw));
  if (hit) return { label: hit.label, blocking: hit.blocking, raw };
  return { label: raw || '未记录失败原因', blocking: false, raw };
}

export function failureDigest(jobs: GenerationJob[]): FailureDigest {
  const counts = new Map<string, FailureGroup>();

  for (const job of jobs) {
    const error = job.error ?? '';
    const hit = PATTERNS.find((p) => p.match.test(error));
    // 归不了类的保留原文摘要,不吞掉信息——排查全靠它
    const label = hit?.label ?? (error.trim() ? `未归类：${error.trim().slice(0, 40)}` : '未记录失败原因');
    const blocking = hit?.blocking ?? false;
    const current = counts.get(label);
    if (current) current.count += 1;
    else counts.set(label, { label, count: 1, blocking });
  }

  const groups = [...counts.values()].sort((a, b) => b.count - a.count);
  return {
    total: jobs.length,
    groups,
    blockingCount: groups.filter((g) => g.blocking).reduce((sum, g) => sum + g.count, 0),
  };
}

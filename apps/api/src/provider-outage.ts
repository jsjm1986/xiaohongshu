/**
 * 供应商级故障的识别与快失败。
 *
 * 起因是实测:86 篇失败里 52 篇挂在供应商,其中 42 篇是同一个 Insufficient Balance——
 * 而且集中在 4 个批次(各 10 篇全灭)。每一篇都要先跑完知识加载、规划、写作,
 * **平均 983 秒(16 分钟)**才撞上那个错误;配额在创建时就已经扣掉了。
 *
 * 也就是说:余额一旦耗尽,后面排队的每一篇都注定失败,却还要各花 16 分钟去证明
 * 这件事。对按次计费的产品,这是把用户的钱和时间同时烧掉。
 *
 * 这里区分两类错误:
 * - **供应商级(outage)**:余额不足、无可用账号、凭据全部冷却。换一篇内容不会改变
 *   结果,后面排队的应当立刻判失败并说明原因,而不是逐个重试。
 * - **单篇级**:模型输出解析失败、单次断流、超时。这些换一次调用就可能成功,
 *   照旧交给 retryModelProvider 处理,不触发快失败。
 */

/** 供应商级故障的类型。文案与出路各不相同,所以分开而不是一个布尔。 */
export type ProviderOutageKind = 'insufficient_balance' | 'no_account' | 'cooling_down';

interface OutagePattern {
  kind: ProviderOutageKind;
  match: RegExp;
  /** 给用户看的原因,替代原始英文错误 */
  reason: string;
}

/**
 * 取自实测的真实错误文本(apps/api 的 generation_jobs.error 列)。
 * 只匹配"换一篇也没用"的那几类;拿不准的一律不算 outage——误判会把本可成功的
 * 任务一并判死,比多跑几篇的代价大得多。
 */
const PATTERNS: readonly OutagePattern[] = [
  {
    kind: 'insufficient_balance',
    match: /Insufficient Balance|insufficient[_ ]quota|billing.*(?:hard limit|not active)|exceeded your current quota/i,
    reason: '模型账户余额不足，本项目排队中的任务已停止，充值后可在产出区批量重试',
  },
  {
    kind: 'no_account',
    match: /No available accounts|no available channel|无可用(?:账号|渠道)/i,
    reason: '模型服务暂无可用账号，本项目排队中的任务已停止，稍后可在产出区批量重试',
  },
  {
    kind: 'cooling_down',
    match: /All credentials are temporarily cooling down|credentials.*cooling down/i,
    reason: '模型服务的凭据全部在冷却中，本项目排队中的任务已停止，稍后可在产出区批量重试',
  },
];

export interface ProviderOutage {
  kind: ProviderOutageKind;
  reason: string;
}

/**
 * 判断一条错误消息是否属于供应商级故障。不是则返回 null。
 *
 * 刻意只看消息文本而不看 HTTP 状态码:实测本地中继把余额不足包装成各种状态
 * (含 200 体内报错),状态码不可靠。
 */
export function detectProviderOutage(message: string | undefined | null): ProviderOutage | null {
  if (!message) return null;
  for (const pattern of PATTERNS) {
    if (pattern.match.test(message)) return { kind: pattern.kind, reason: pattern.reason };
  }
  return null;
}

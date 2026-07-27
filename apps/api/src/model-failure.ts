import { AnalysisGatewayError } from './intelligence.service.js';

/**
 * 模型调用失败的分类。
 *
 * 从 intelligence.service.analysisFailureException 抽出:revise 异步化后需要同一套
 * 判据(哪些失败该退额度、该说什么),再抄一份就会漂移。分类只按「用户下一步该做
 * 什么 + 该不该退额度」分,不暴露中继地址与模型名。
 */
export type ModelFailureKind = 'unavailable' | 'credentials' | 'incomplete' | 'other';

export function classifyModelFailure(error: unknown): ModelFailureKind {
  if (!(error instanceof AnalysisGatewayError)) return 'other';
  const status = (error as { status?: number }).status;
  // 5xx / 429 / 网络层无响应(status undefined):不是用户的问题,重试即可
  if (status === undefined || status === 429 || status >= 500) return 'unavailable';
  if (status === 401 || status === 403) return 'credentials';
  // 模型返回了但内容不合契约:采样波动,重试一次多半能好
  if (/omitted required|invalid JSON|empty planning resources/i.test(error.message)) return 'incomplete';
  return 'other';
}

/**
 * 该不该退还额度。
 *
 * 原则与既有实现一致:只在**确认无产出**时退。前三类用户什么都没拿到;other 是
 * 校验不通过一类,消耗了真实算力并产出了可判定结果,不退。
 */
export function shouldRefundQuota(kind: ModelFailureKind): boolean {
  return kind !== 'other';
}

/**
 * 用户可见文案。action 是动作名(「分析」/「修改」),让同一份文案服务两个调用方。
 * 退额度的分类必须把这件事说出来,否则用户以为白花了一次。
 */
export function modelFailureMessage(kind: ModelFailureKind, action: string, raw: string): string {
  switch (kind) {
    case 'unavailable':
      return `模型服务暂时不可用，${action}没有完成。已退还本次额度，请稍后重试；若持续失败请联系客服。`;
    case 'credentials':
      return `模型服务凭据异常，${action}没有完成。已退还本次额度，请联系客服处理。`;
    case 'incomplete':
      return `模型这次返回的结果不完整，${action}没有完成。已退还本次额度，直接重试一次通常就好了。`;
    default:
      return `${action}失败：${raw}`;
  }
}

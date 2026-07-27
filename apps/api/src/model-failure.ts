import { ModelProviderError } from '@content-agent/agent-core';

/**
 * 分析路径的网关错误。
 *
 * 类定义放在这个叶子模块而不是 intelligence.service:分类判据要 instanceof 它,而
 * intelligence.service 又要 import 本模块的 classifyModelFailure,反向 import 会形成
 * 环——一个纯工具模块因此拖着 sharp + agent-core + Nest 的胖 service。运行期当前不炸
 * (两侧都不在模块求值期互相触碰),但方向是错的,而且下一个在本模块顶层求值的常量
 * 就会踩到。intelligence.service 原地重新导出这个名字,所以外部 import 点一个都不用改。
 */
export class AnalysisGatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * 模型调用失败的分类。
 *
 * 从 intelligence.service.analysisFailureException 抽出:revise 异步化后需要同一套
 * 判据(哪些失败该退额度、该说什么),再抄一份就会漂移。分类只按「用户下一步该做
 * 什么 + 该不该退额度」分,不暴露中继地址与模型名。
 */
export type ModelFailureKind = 'unavailable' | 'credentials' | 'incomplete' | 'other';

/**
 * 「这是一次模型网关失败」的判据。
 *
 * 两条路径抛的是不同的类,没有继承关系:分析走 AnalysisGatewayError,生成与改稿走
 * agent-core 的 ModelProviderError(OpenAICompatibleClient 抛的)。只认前者会让
 * revise 的**每一种**模型失败都落进 other——退额度成为死代码,用户还会看到英文原文。
 *
 * 用显式类名单而不是「有 status 字段就算」:Nest 的每个 HttpException 都带
 * status,`consumePlatformQuota` 的额度用尽是 ForbiddenException(status=403),
 * 鸭子类型会把它判成「凭据异常」并对用户说凭据坏了。加第三个 provider 错误类时
 * 在这里加一行即可。
 */
function modelGatewayStatus(error: unknown): { gateway: boolean; status?: number; message: string } {
  if (error instanceof AnalysisGatewayError || error instanceof ModelProviderError) {
    return { gateway: true, status: error.status, message: error.message };
  }
  return { gateway: false, message: error instanceof Error ? error.message : String(error) };
}

export function classifyModelFailure(error: unknown): ModelFailureKind {
  const { gateway, status, message } = modelGatewayStatus(error);
  if (!gateway) return 'other';
  // 5xx / 429 / 网络层无响应(status undefined:超时、连接失败、响应体读不出来):
  // 不是用户的问题,重试即可。判据顺序保持原样——把契约不符提到前面会改掉分析路径
  // 既有的分类结果(500 + 坏 JSON 现在是 unavailable),那不在本次范围。
  if (status === undefined || status === 429 || status >= 500) return 'unavailable';
  if (status === 401 || status === 403) return 'credentials';
  // 模型返回了但内容不合契约:采样波动,重试一次多半能好
  if (/omitted required|invalid JSON|empty planning resources|not a JSON object|non-JSON response|did not contain output text/i.test(message)) {
    return 'incomplete';
  }
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

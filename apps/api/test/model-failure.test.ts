import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalysisGatewayError } from '../src/intelligence.service.js';
import { classifyModelFailure, modelFailureMessage, shouldRefundQuota } from '../src/model-failure.js';

/**
 * 模型失败分类。抽出来是因为 intelligence.service 已经有一份完整实现,revise
 * 要用同一套判据——再抄一份就开始漂移。
 *
 * 分类只按「用户下一步该做什么 + 该不该退额度」分,不暴露中继地址与模型名。
 */
function gatewayError(message: string, status?: number): AnalysisGatewayError {
  const error = new AnalysisGatewayError(message);
  (error as { status?: number }).status = status;
  return error;
}

test('5xx / 429 / 网络层无响应都算服务不可用,要退额度', () => {
  for (const status of [undefined, 429, 500, 502, 503]) {
    const kind = classifyModelFailure(gatewayError('上游失败', status));
    assert.equal(kind, 'unavailable', `status=${status} 应判 unavailable`);
    assert.equal(shouldRefundQuota(kind), true);
  }
});

test('401 / 403 算凭据异常,同样退额度', () => {
  for (const status of [401, 403]) {
    const kind = classifyModelFailure(gatewayError('unauthorized', status));
    assert.equal(kind, 'credentials');
    assert.equal(shouldRefundQuota(kind), true);
  }
});

test('契约不符(JSON 坏、缺模块)算 incomplete,退额度', () => {
  for (const message of ['invalid JSON at line 3', 'omitted required module', 'empty planning resources']) {
    const kind = classifyModelFailure(gatewayError(message, 200));
    assert.equal(kind, 'incomplete', `${message} 应判 incomplete`);
    assert.equal(shouldRefundQuota(kind), true);
  }
});

test('非网关错误算 other,不退额度', () => {
  // 校验不通过、指令非法这类:消耗了真实算力且产出了可判定结果。
  const kind = classifyModelFailure(new Error('候选未通过事实校验'));
  assert.equal(kind, 'other');
  assert.equal(shouldRefundQuota(kind), false);
});

test('文案带上动作名,并在退额度时明说', () => {
  const unavailable = modelFailureMessage('unavailable', '修改', '上游失败');
  assert.match(unavailable, /模型服务暂时不可用/u);
  assert.match(unavailable, /修改没有完成/u);
  assert.match(unavailable, /已退还本次额度/u);

  const analysis = modelFailureMessage('unavailable', '分析', '上游失败');
  assert.match(analysis, /分析没有完成/u);

  // other 不退,文案里不能出现「已退还」——那会是假承诺。
  const other = modelFailureMessage('other', '修改', '候选未通过事实校验');
  assert.ok(!other.includes('已退还'), `other 文案不该承诺退额度：${other}`);
  assert.match(other, /候选未通过事实校验/u, 'other 要透出原文,至少给一点线索');
});

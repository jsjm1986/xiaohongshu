import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { ModelProviderError } from '@content-agent/agent-core';
import { AnalysisGatewayError as ReExported } from '../src/intelligence.service.js';
import {
  AnalysisGatewayError, classifyModelFailure, modelFailureMessage, shouldRefundQuota,
} from '../src/model-failure.js';

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

/*
 * 生成与改稿路径抛的是 agent-core 的 ModelProviderError,与分析路径的
 * AnalysisGatewayError 没有继承关系。只认后者会让 revise 的每一种模型失败都落进
 * other:退额度成死代码(用户模型故障也扣钱),报错还是英文原文。
 */
test('ModelProviderError 与 AnalysisGatewayError 同等分类', () => {
  for (const status of [500, 502, 503, 429, undefined]) {
    const kind = classifyModelFailure(new ModelProviderError('Model provider rejected the request: Bad gateway', status));
    assert.equal(kind, 'unavailable', `status=${status} 应判 unavailable`);
    assert.equal(shouldRefundQuota(kind), true, `status=${status} 该退额度`);
  }
  for (const status of [401, 403]) {
    const kind = classifyModelFailure(new ModelProviderError('Model provider rejected the request: invalid key', status));
    assert.equal(kind, 'credentials');
    assert.equal(shouldRefundQuota(kind), true);
  }
  // 契约不符:agent-core 在读响应体阶段抛,带 200 或不带 status
  assert.equal(classifyModelFailure(new ModelProviderError('Model response was not a JSON object.', 200)), 'incomplete');
  assert.equal(classifyModelFailure(new ModelProviderError('Model response did not contain output text.', 200)), 'incomplete');
});

test('502 的用户文案是中文且明说退了额度,不是英文原文', () => {
  const error = new ModelProviderError('Model provider rejected the request: Bad gateway', 502);
  const kind = classifyModelFailure(error);
  const message = modelFailureMessage(kind, '修改', error.message);
  assert.match(message, /模型服务暂时不可用/u);
  assert.match(message, /修改没有完成/u);
  assert.match(message, /已退还本次额度/u);
  assert.ok(!message.includes('rejected the request'), `不该把英文原文塞给用户：${message}`);
});

/*
 * 不按「有 status 字段就算网关失败」判:Nest 的每个 HttpException 都带 status,
 * 额度用尽是 ForbiddenException(403),鸭子类型会把它判成 credentials 并对用户说
 * 凭据坏了——而且它会触发退额度,把刚扣的那次白送回去。
 */
test('带 status 的非模型错误仍是 other:Nest 异常不冒充网关失败', () => {
  const quotaExhausted = new ForbiddenException('平台测试额度已用完');
  assert.equal((quotaExhausted as { status?: number }).status, 403, '前提:Nest 异常确实带 status');
  const kind = classifyModelFailure(quotaExhausted);
  assert.equal(kind, 'other');
  assert.equal(shouldRefundQuota(kind), false, '额度用尽时根本没扣成功,不该退');
});

/*
 * 依赖方向:本模块是叶子,不许反向 import 那个胖 service。
 *
 * 分类判据要 instanceof AnalysisGatewayError,而 intelligence.service 又要用本模块的
 * classifyModelFailure——类定义留在 service 里就形成循环 import,一个纯工具模块因此拖着
 * sharp + agent-core + Nest。运行期当前不炸(两侧都不在模块求值期互相触碰),但下一个在
 * 本模块顶层求值的常量就会踩到。修法是类定义搬到本模块,service 原地重新导出。
 */
test('model-failure 不 import intelligence.service:方向是叶子指向上层的反面', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'model-failure.ts'), 'utf8');
  assert.ok(
    !/from\s+'\.\/intelligence\.service\.js'/.test(source),
    '循环 import 回来了:AnalysisGatewayError 的定义该留在 model-failure.ts',
  );
});

test('intelligence.service 重新导出同一个类:外部 import 点不用改', () => {
  // 同一性而不是同名:重新导出若变成"再定义一个同名类",instanceof 会在两条路径之间
  // 静默失效——分析路径的失败会全部落进 other,退额度重新变成死代码。
  assert.equal(ReExported, AnalysisGatewayError, '必须是同一个类对象,不能是各自定义的同名类');
  assert.equal(classifyModelFailure(new ReExported('boom', 502)), 'unavailable');
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

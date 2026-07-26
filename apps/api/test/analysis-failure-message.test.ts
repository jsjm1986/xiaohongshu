import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AnalysisGatewayError, analysisFailureException } from '../src/intelligence.service.js';

/**
 * 分析失败的报错话术。
 *
 * 起因是端到端实测:真 saas 账号点「分析知识库」,中继返回 HTTP 500 之后界面上只有
 * 一句「Internal server error」——AnalysisGatewayError 是普通 Error,Nest 一律包成
 * 500 Internal server error。用户不知道发生了什么、要不要重试、是不是自己的问题。
 *
 * 分类只按「用户下一步该做什么」分,并且不得泄露中继地址、模型名这些内部细节。
 */

const messageOf = (error: unknown): string => {
  const res = analysisFailureException(error).getResponse();
  return typeof res === 'string' ? res : String((res as { message?: unknown }).message ?? '');
};

test('5xx / 429 / 网络失败:告知稍后重试,并说明额度已退还', () => {
  for (const status of [500, 502, 503, 429, undefined]) {
    const ex = analysisFailureException(new AnalysisGatewayError('The analysis model returned HTTP 500.', status));
    assert.equal(ex.getStatus(), 503, `status=${String(status)} 应报 503`);
    const msg = messageOf(new AnalysisGatewayError('x', status));
    assert.match(msg, /稍后重试|联系客服/);
    assert.match(msg, /已退还/, '必须说清额度退了,否则用户以为白花了');
  }
});

test('凭据异常(401/403):指向客服,而不是让用户干等', () => {
  for (const status of [401, 403]) {
    const msg = messageOf(new AnalysisGatewayError('unauthorized', status));
    assert.match(msg, /凭据/);
    assert.match(msg, /客服/);
    assert.match(msg, /已退还/);
  }
});

test('模型返回不合契约:告知重试一次通常就好', () => {
  const cases = [
    'The analysis model omitted required project blueprint modules: a, b.',
    'The analysis model returned invalid JSON.',
    'The analysis model produced empty planning resources: informationGaps 为空;',
  ];
  for (const raw of cases) {
    const msg = messageOf(new AnalysisGatewayError(raw, 200));
    assert.match(msg, /结果不完整|重试/, raw);
    assert.match(msg, /已退还/);
  }
});

// 行为反转,专门锁死:原来这里给的是一句无信息的 "Internal server error"
test('任何分支都不再返回裸的 Internal server error', () => {
  for (const error of [
    new AnalysisGatewayError('boom', 500),
    new AnalysisGatewayError('bad json', 200),
    new Error('unexpected'),
  ]) {
    assert.doesNotMatch(messageOf(error), /^Internal server error$/);
  }
});

// 内部细节不能进用户可见文本
test('不泄露中继地址、模型名等内部细节', () => {
  const msg = messageOf(new AnalysisGatewayError('connect ECONNREFUSED 127.0.0.1:9090 model=claude-opus', 500));
  assert.doesNotMatch(msg, /127\.0\.0\.1|9090|claude|ECONNREFUSED/i);
});

// 已经是 HttpException 的(配额 403、参数 400)要原样透出,不能被裹成 503
test('已有的 HttpException 原样透出,不被覆盖', () => {
  const forbidden = new ForbiddenException('额度已用完，请添加客服微信');
  assert.equal(analysisFailureException(forbidden), forbidden);
  const bad = new BadRequestException('Configure a model API key before running analysis.');
  assert.equal(analysisFailureException(bad), bad);
});

test('非网关错误保留原文,至少比 Internal server error 多一点线索', () => {
  const msg = messageOf(new Error('something broke in stage 2'));
  assert.match(msg, /something broke in stage 2/);
});

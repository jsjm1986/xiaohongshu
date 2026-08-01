import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blueprintEvidenceIssues, validateAnalysisEvidence } from '../src/analysis-evidence.js';

const evidence = [{ id: 'e-price', text: '标准套餐价格为 980 元，以当期确认为准。', sourceStatus: 'supplied_fact' as const }];

test('verifiedFacts 只有台账、状态、证据 ID 和原文支持全部有效时保留', () => {
  const result = validateAnalysisEvidence({
    intelligence: {
      verifiedFacts: ['标准套餐价格为 980 元', '模型猜测很受欢迎', '价格为 1980 元'],
      evidenceLedger: [
        { statement: '标准套餐价格为 980 元', sourceStatus: 'supplied_fact', evidenceIds: ['e-price'] },
        { statement: '模型猜测很受欢迎', sourceStatus: 'inference', evidenceIds: [] },
        { statement: '价格为 1980 元', sourceStatus: 'supplied_fact', evidenceIds: ['e-price'] },
      ],
    },
    blueprintModules: {},
    evidence,
  });
  assert.deepEqual(result.intelligence.verifiedFacts, ['标准套餐价格为 980 元']);
  assert.deepEqual(result.issues.map((issue) => issue.reason), ['invalid_source_status', 'unsupported_statement']);
});

test('verifiedFacts 没有台账或引用未知证据时降级并记录原因', () => {
  const result = validateAnalysisEvidence({
    intelligence: {
      verifiedFacts: ['没有台账', '未知引用'],
      evidenceLedger: [{ statement: '未知引用', sourceStatus: 'supplied_fact', evidenceIds: ['missing'] }],
    },
    blueprintModules: {},
    evidence,
  });
  assert.deepEqual(result.intelligence.verifiedFacts, []);
  assert.deepEqual(result.issues.map((issue) => issue.reason), ['missing_ledger', 'unknown_evidence']);
});

test('模型蓝图的虚假 supplied_fact 自动降为 inference 并清空引用', () => {
  const result = validateAnalysisEvidence({
    intelligence: { verifiedFacts: [], evidenceLedger: [] },
    blueprintModules: {
      audience_model: {
        states: [{ label: '所有用户都喜欢低价', source: { status: 'supplied_fact', evidenceIds: ['e-price'] } }],
      },
    },
    evidence,
  });
  const state = (result.blueprintModules.audience_model as any).states[0];
  assert.equal(state.source.status, 'inference');
  assert.deepEqual(state.source.evidenceIds, []);
  assert.equal(result.issues[0]?.reason, 'unsupported_statement');
});

test('人工编辑蓝图后，无效 supplied_fact 可由审批校验器明确拒绝', () => {
  const issues = blueprintEvidenceIssues({
    moduleKey: 'role_model',
    data: { roles: [{ displayRole: '全国第一专家', source: { status: 'supplied_fact', evidenceIds: ['missing'] } }] },
    evidence,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.path, 'blueprintModules.role_model.roles[0].source');
  assert.equal(issues[0]?.reason, 'unknown_evidence');
});


test('声明来源状态必须与证据目录状态一致', () => {
  const result = validateAnalysisEvidence({
    intelligence: {
      verifiedFacts: ['标准套餐价格为 980 元'],
      evidenceLedger: [{ statement: '标准套餐价格为 980 元', sourceStatus: 'approved_observation', evidenceIds: ['e-price'] }],
    },
    blueprintModules: {},
    evidence,
  });
  assert.deepEqual(result.intelligence.verifiedFacts, []);
  assert.equal(result.issues[0]?.reason, 'invalid_source_status');
});


test('推断或未知知识不能被提升为 supplied_fact', () => {
  const result = validateAnalysisEvidence({
    intelligence: {
      verifiedFacts: ['标准套餐价格为 980 元'],
      evidenceLedger: [{ statement: '标准套餐价格为 980 元', sourceStatus: 'supplied_fact', evidenceIds: ['e-inferred'] }],
    },
    blueprintModules: {},
    evidence: [{ id: 'e-inferred', text: '标准套餐价格为 980 元', sourceStatus: 'inference' }],
  });
  assert.deepEqual(result.intelligence.verifiedFacts, []);
  assert.equal(result.issues[0]?.reason, 'invalid_source_status');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysisEvidenceSupportsStatement, blueprintEvidenceIssues, validateAnalysisEvidence } from '../src/analysis-evidence.js';

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


test('复合机构事实使用公开证据联合支持，内部治理条款不造成极性误判', () => {
  const source = [
    '| 机构定位 | 专注眼周年轻化，尤其擅长眼袋；机构类型为门诊；机构全称不对外公开（内部须知） |',
    '| 地址 | 成都锦江区，锦华万达附近 |',
  ].join('\n');
  assert.equal(analysisEvidenceSupportsStatement(
    '机构类型为门诊，专注眼周年轻化，地址在成都锦江区锦华万达附近。',
    source,
  ), true);
  assert.equal(analysisEvidenceSupportsStatement('地址在锦华万达A座12楼', source), false);
  assert.equal(analysisEvidenceSupportsStatement('地铁2号线直达并提供免费停车', source), false);
});


test('公开体验改写不能靠整段模糊相似度冒充逐原子证据', () => {
  const source = '打麻药的时候有短暂的进针刺痛感，之后操作无痛感，些许人会有酸胀、牵拉或压迫感；过程中可沟通并根据情况调整节奏，客户常常睡着或在聊天中结束。';
  assert.equal(analysisEvidenceSupportsStatement(
    '打麻药时有短暂进针刺痛感，之后操作无痛感，部分人有酸胀、牵拉或压迫感；过程中可沟通调整节奏，常有人睡着或聊天中结束。',
    source,
  ), false);
});

test('治理条款自身仍可走保守兼容路径', () => {
  assert.equal(analysisEvidenceSupportsStatement(
    '机构全称不对外公开',
    '机构全称不对外公开（内部须知）',
  ), true);
});

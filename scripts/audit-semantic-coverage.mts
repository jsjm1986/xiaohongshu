/**
 * 语义校验覆盖抽样审计(离线,只读生产库)。
 *
 * 回答三个问题:
 * 1. 公式诊断(F 系)在真实产出里的实际执行率——哪些公式从未出现过?
 * 2. 校验 issue 的分布——哪些 code 高频出现,严重度/处置是什么?
 * 3. 模型质量护栏的失败痕迹(判官失败/台账失败/修复失败)有多少,
 *    重试改造(2026-08-13)前后是否收敛?
 *
 * 产出: docs/audits/semantic-coverage-<date>.md(整改清单在文末)
 * 运行: npx tsx scripts/audit-semantic-coverage.mts [db路径,默认 data/app.db]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// 直接吃权威注册表(先 npm run build -w @content-agent/agent-core):
// 每条公式的 implementationStatus/stages 是代码里维护的实现审查结论。
import { FORMULA_EXECUTION_HANDLER_REGISTRY } from '../packages/agent-core/dist/formula.js';

const dbPath = process.argv[2] ?? resolve(import.meta.dirname, '../data/app.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

interface Row { id: string; created_at: string; content_json: string }
const rows = db.prepare('SELECT id, created_at, content_json FROM content_packages ORDER BY created_at').all() as Row[];

const RETRY_FIX_DATE = '2026-08-13T00:00:00.000Z';

const formulaCounts = new Map<string, number>();
const issueCounts = new Map<string, { count: number; severities: Set<string>; dispositions: Set<string> }>();
const qualityCounts = new Map<string, number>();
const modeCounts = new Map<string, number>();
const guardFailures = { before: new Map<string, number>(), after: new Map<string, number>() };
const GUARD_CODES = new Set(['model_claim_judge_failed', 'model_ledger_failed', 'repair_parse_failed', 'model_comment_plan_failed']);
let parsed = 0;
let corrupt = 0;
let totalBefore = 0;
let totalAfter = 0;

for (const row of rows) {
  let content: any;
  try {
    content = JSON.parse(row.content_json);
    parsed += 1;
  } catch {
    corrupt += 1;
    continue;
  }
  const bucket = row.created_at < RETRY_FIX_DATE ? 'before' : 'after';
  if (bucket === 'before') totalBefore += 1; else totalAfter += 1;

  for (const diagnostic of content.diagnostics ?? []) {
    // 无 formulaId 的是聚合视图(hard_constraints/review_warnings),不是公式,
    // 按 name 单独归类,不污染公式执行率。
    const id = String(diagnostic.formulaId ?? `聚合:${diagnostic.name ?? 'unnamed'}`);
    formulaCounts.set(id, (formulaCounts.get(id) ?? 0) + 1);
  }
  // qualityStatus/generationMode 是后加字段:老包缺失记为「字段前时代」,
  // 与「值为 unknown」区分开,否则误读成六成包状态不明。
  const quality = String(content.validation?.qualityStatus ?? (content.validation?.valid ? 'passed(旧包按 valid 推导)' : '字段前时代(旧包)'));
  qualityCounts.set(quality, (qualityCounts.get(quality) ?? 0) + 1);
  const mode = String(content.generationMode ?? content.artifactRealization?.mode ?? '字段前时代(旧包)');
  modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);

  for (const issue of content.validation?.issues ?? []) {
    const code = String(issue.code ?? 'unknown');
    const entry = issueCounts.get(code) ?? { count: 0, severities: new Set<string>(), dispositions: new Set<string>() };
    entry.count += 1;
    entry.severities.add(String(issue.severity ?? '-'));
    entry.dispositions.add(String(issue.disposition ?? '-'));
    issueCounts.set(code, entry);
    if (GUARD_CODES.has(code)) {
      guardFailures[bucket].set(code, (guardFailures[bucket].get(code) ?? 0) + 1);
    }
  }
}

// 包级 diagnostics 按设计只由 F32/F33(分项检查清单)与两个聚合视图产出;
// 其余公式的执行痕迹在 planning/generation/validation 的代码路径里,不落
// 包级诊断。所以「诊断覆盖」只对 F32/F33 有缺口语义;全公式盘点走注册表
// 的实现状态(active/partial/conditional/protocol-only/not_executed)。
const registryEntries = Object.values(FORMULA_EXECUTION_HANDLER_REGISTRY) as Array<{
  formulaId: string; implementationStatus: string; stages: readonly string[];
}>;
const byStatus = new Map<string, string[]>();
for (const entry of registryEntries) {
  const list = byStatus.get(entry.implementationStatus) ?? [];
  list.push(entry.formulaId);
  byStatus.set(entry.implementationStatus, list);
}

const sortedIssues = [...issueCounts.entries()].sort((a, b) => b[1].count - a[1].count);
const sortedFormulas = [...formulaCounts.entries()].sort((a, b) => b[1].count - a[1].count);

const percent = (count: number, total: number) => total ? `${(count * 100 / total).toFixed(1)}%` : '-';
const date = new Date().toISOString().slice(0, 10);

const lines: string[] = [];
lines.push(`# 语义校验覆盖抽样审计 ${date}`);
lines.push('');
lines.push(`> 只读扫描 \`${dbPath}\`;包总数 ${rows.length},可解析 ${parsed},损坏 ${corrupt}。`);
lines.push(`> 护栏失败按重试改造日(${RETRY_FIX_DATE.slice(0, 10)})分桶:之前 ${totalBefore} 包,之后 ${totalAfter} 包。`);
lines.push('');
lines.push('## 1. 质量状态与生成模式分布');
lines.push('');
lines.push('| 质量状态 | 包数 | 占比 |');
lines.push('|---|---|---|');
for (const [status, count] of [...qualityCounts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${status} | ${count} | ${percent(count, parsed)} |`);
}
lines.push('');
lines.push('| 生成模式 | 包数 | 占比 |');
lines.push('|---|---|---|');
for (const [mode, count] of [...modeCounts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${mode} | ${count} | ${percent(count, parsed)} |`);
}
lines.push('');
lines.push('## 2. 公式覆盖:包级诊断实测 + 全公式实现状态');
lines.push('');
lines.push('包级 diagnostics 按设计只由 F32/F33 与两个聚合视图产出,其余公式的执行');
lines.push('痕迹在规划/生成/校验代码路径里。诊断实测:');
lines.push('');
lines.push('| 诊断 | 出现包数 | 占比 |');
lines.push('|---|---|---|');
for (const [id, count] of sortedFormulas) {
  lines.push(`| ${id} | ${count} | ${percent(count, parsed)} |`);
}
lines.push('');
lines.push('全公式实现状态(注册表口径,代码内维护的实现审查结论):');
lines.push('');
lines.push('| 实现状态 | 数量 | 公式 |');
lines.push('|---|---|---|');
for (const [status, ids] of [...byStatus.entries()].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`| ${status} | ${ids.length} | ${ids.sort().join(', ')} |`);
}
lines.push('');
lines.push('> `protocol-only` = 文档/合同承诺但不在运行时执行;`not_executed` = 声明了但');
lines.push('> 未接线。对外描述能力时必须按 active/partial 口径,不要把 protocol-only 说成已执行。');
lines.push('');
lines.push('## 3. 校验 issue 分布(前 30)');
lines.push('');
lines.push('| code | 次数 | severity | disposition |');
lines.push('|---|---|---|---|');
for (const [code, entry] of sortedIssues.slice(0, 30)) {
  lines.push(`| ${code} | ${entry.count} | ${[...entry.severities].join('/')} | ${[...entry.dispositions].join('/')} |`);
}
lines.push('');
lines.push('## 4. 模型护栏失败痕迹(重试改造前后)');
lines.push('');
lines.push('| code | 改造前 | 改造后 |');
lines.push('|---|---|---|');
for (const code of GUARD_CODES) {
  lines.push(`| ${code} | ${guardFailures.before.get(code) ?? 0} | ${guardFailures.after.get(code) ?? 0} |`);
}
lines.push('');
lines.push('## 5. 自动生成的整改线索');
lines.push('');
const topIssue = sortedIssues[0];
if (topIssue) lines.push(`- 最高频 issue \`${topIssue[0]}\`(${topIssue[1].count} 次):优先分析它是规则过严还是内容真缺陷。`);
const protocolOnly = byStatus.get('protocol-only') ?? [];
if (protocolOnly.length) lines.push(`- ${protocolOnly.length} 条公式是 protocol-only(承诺但不执行):销售与文档措辞按 active/partial 口径收口。`);
const notExecuted = byStatus.get('not_executed') ?? [];
if (notExecuted.length) lines.push(`- ${notExecuted.length} 条声明未接线(${notExecuted.join(', ')}):要么接线要么从对外能力清单摘除。`);
const afterGuardTotal = [...guardFailures.after.values()].reduce((a, b) => a + b, 0);
if (afterGuardTotal) lines.push(`- 重试改造后仍有 ${afterGuardTotal} 次护栏失败:检查是否为持续性网关质量问题(而非瞬时抖动)。`);
else lines.push('- 重试改造后护栏失败为 0:瞬时故障重试策略生效,保持观察。');
lines.push('');

const outDir = resolve(import.meta.dirname, '../docs/audits');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `semantic-coverage-${date}.md`);
writeFileSync(outPath, lines.join('\n'));
console.log(`审计完成: ${outPath}`);
console.log(`包 ${parsed}/${rows.length} | 诊断种类 ${formulaCounts.size} | issue 种类 ${issueCounts.size}`);
db.close();

/**
 * 对真实项目数据跑一次完善度预检,人工核对分档是否合理。
 *
 * 直接调服务层,不走 HTTP —— 只为免掉登录态,判定逻辑与线上路由完全同一条。
 * 用法(在 apps/api 下跑,tsconfig 在那里):
 *   cd apps/api && CONTENT_AGENT_DATA_DIR=<数据副本> MASTER_ENCRYPTION_KEY=<key> \
 *     node --import tsx ../../scripts/preflight-probe.mts <projectId>
 *
 * 只读:不写库、不调模型。请对数据副本运行,不要指向线上数据目录 —— 启动会开 WAL,
 * 和线上进程抢同一个库文件。
 */
import '../apps/api/node_modules/reflect-metadata/Reflect.js';
import { createApplication } from '../apps/api/src/app.js';
import { KnowledgeService } from '../apps/api/src/knowledge.service.js';

const projectId = process.argv[2];
if (!projectId) {
  console.error('用法: node --import tsx scripts/preflight-probe.mts <projectId>');
  process.exit(1);
}

const app = await createApplication({ logger: false });
try {
  const knowledge = app.get(KnowledgeService);
  const result = await knowledge.preflight(projectId) as Record<string, any>;

  console.log(`\n可以生成: ${result.canGenerate ? '是' : `否 —— ${result.requiredOpen.length} 条必答缺口没落实`}`);
  console.log(`分档: 有资料支撑 ${result.tiers.evidence_backed} · 仅人工确认 ${result.tiers.approved_only}`
    + ` · 会被丢弃 ${result.tiers.will_be_dropped} · 无答案 ${result.tiers.blank}`);
  console.log(`缺口总数 ${result.gaps.length}`);
  if (result.warnings.length) console.log(`告警: ${result.warnings.join(' / ')}`);

  const dropped = result.gaps.filter((gap: any) => gap.tier === 'will_be_dropped');
  if (dropped.length) {
    console.log(`\n【会被生成丢弃的答案】${dropped.length} 条 —— 这是当前界面完全看不见的一档`);
    for (const gap of dropped.slice(0, 8)) {
      console.log(`  · ${gap.label}${gap.required ? '(必答)' : ''}`);
      for (const reason of gap.reasons) console.log(`      ${reason}`);
    }
  }

  const backed = result.gaps.filter((gap: any) => gap.tier === 'evidence_backed');
  if (backed.length) {
    console.log(`\n【有上传资料支撑】${backed.length} 条,示例:`);
    for (const gap of backed.slice(0, 3)) {
      console.log(`  · ${gap.label} —— 命中 ${gap.sectionEvidenceIds.length} 处分节`);
    }
  }

  const stale = result.gaps.filter((gap: any) => gap.staleDeclaredEvidenceIds.length);
  if (stale.length) {
    console.log(`\n【引用了已失效证据】${stale.length} 条`);
    for (const gap of stale.slice(0, 5)) {
      console.log(`  · ${gap.label} —— ${gap.staleDeclaredEvidenceIds.length} 条引用失效`);
    }
  }

  console.log(`\n按分类覆盖:`);
  for (const row of result.byCategory) {
    console.log(`  ${row.category}: ${row.settled}/${row.total} 站得住`);
  }
} finally {
  await app.close();
}

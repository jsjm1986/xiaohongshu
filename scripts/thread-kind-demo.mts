/**
 * 读者互动层三类线程演示脚本(确定性,无模型调用):
 *   npx tsx scripts/thread-kind-demo.mts
 * 用固定夹具跑一次 ContentGenerationAgent 引擎,打印每个候选包里
 * T1 机构问答 / T2 读者互聊 / T3 漂浮短反应 的样本线程。
 */
import {
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
} from "../packages/agent-core/src/index.js";
import type { CommentReferenceThread } from "../packages/agent-core/src/index.js";

const project = {
  id: "p1",
  name: "演示项目",
  domain: "决策信息",
  productPoints: ["资料中确认了产品要点"],
  organizationPoints: ["资料中确认了服务边界"],
  cities: ["上海"],
  doctors: [],
};

const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
config.task.theme = "方案选择";
config.task.city = "上海";
config.informationWindow.gaps = ["适合谁", "如何比较", "价格区间"];
config.informationWindow.boundaries = ["不能保证个体结果"];
config.content.bodyMinChars = 120;
config.content.bodyMaxChars = 800;
config.content.hashtagMin = 3;
config.content.hashtagMax = 6;
config.content.commentThreadMin = 3;
config.content.commentThreadMax = 5;
config.content.followUpDepth = 2;
config.content.commentMultiTurnGrowthEnabled = true;

const knowledge = [
  indexKnowledgeSource({ projectId: "p1", id: "d1", path: "INDEX.md", content: "# 索引\n- facts.md" }),
  indexKnowledgeSource({ projectId: "p1", id: "d2", path: "facts.md", content: "# 已知事实\n项目资料只确认这些信息，并要求保留适用边界。" }),
];

const KIND_LABEL: Record<string, string> = {
  org_answer: "T1 机构问答",
  reader_exchange: "T2 读者互聊",
  organic_reaction: "T3 漂浮短反应",
};

// 形态由 hashUnit 种子确定性分配(不设死比例):扫描少量 baseSeed,取首个
// 三个候选包合起来集齐 T1/T2/T3 的运行做展示;同种子重放结果必一致。
let result: Awaited<ReturnType<ContentGenerationAgent["generate"]>> | undefined;
let usedBaseSeed = 0;
for (const baseSeed of [7, 11, 21, 33, 42, 55, 68, 79, 101, 202]) {
  config.generation.baseSeed = baseSeed;
  const run = await new ContentGenerationAgent({ now: () => new Date("2026-07-12T12:00:00Z") })
    .generate({ jobId: "thread-kind-demo", config, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
  const kinds = new Set(run.packages.flatMap((pkg) =>
    pkg.content.Cref.threads.map((thread) => thread.threadKind ?? "org_answer")));
  if (kinds.size === 3) {
    result = run;
    usedBaseSeed = baseSeed;
    break;
  }
}
if (!result) {
  console.log("扫描的 baseSeed 下未集齐三种形态,请扩大扫描范围。");
  process.exit(1);
}
console.log(`baseSeed=${usedBaseSeed}(确定性:同种子重放结果必一致)`);

function printThread(thread: CommentReferenceThread): void {
  const kind = thread.threadKind ?? "org_answer";
  console.log(`\n  [${KIND_LABEL[kind]}] ${thread.id} · topology=${thread.conversationPlan?.topology ?? "-"}`);
  console.log(`    ${thread.displayName ?? "读者"}：${thread.question}`);
  if (kind === "reader_exchange") {
    console.log(`    ${thread.replyDisplayName ?? "读者B"}(接话)：${thread.answer}`);
  } else if (kind === "organic_reaction") {
    console.log(`    (无回答需求,answer=${JSON.stringify(thread.answer)})`);
  } else {
    console.log(`    ${thread.surfaceRoleCard?.replyDisplayRole ?? "机构"}(postingIdentity=${thread.postingIdentity})：${thread.answer}`);
  }
  for (const followUp of thread.followUps) {
    console.log(`    ↳ ${followUp.displayName ?? "接话"}：${followUp.question}`);
    console.log(`      回应：${followUp.answer}`);
  }
}

const seen = new Set<string>();
for (const pkg of result.packages) {
  console.log(`\n===== 候选 ${pkg.candidateIndex + 1}(${pkg.id})=====`);
  const counts: Record<string, number> = { org_answer: 0, reader_exchange: 0, organic_reaction: 0 };
  for (const thread of pkg.content.Cref.threads) counts[thread.threadKind ?? "org_answer"]! += 1;
  console.log(`  形态分布: T1=${counts.org_answer} T2=${counts.reader_exchange} T3=${counts.organic_reaction}`);
  for (const thread of pkg.content.Cref.threads) {
    const kind = thread.threadKind ?? "org_answer";
    if (seen.has(kind)) continue;
    seen.add(kind);
    printThread(thread);
  }
}
console.log(`\n已展示形态: ${[...seen].map((kind) => KIND_LABEL[kind]).join("、") || "无"}`);

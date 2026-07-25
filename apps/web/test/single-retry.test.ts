import assert from "node:assert/strict";
import { test } from "node:test";
import { retryJobOnce } from "../src/lib/single-retry.ts";
import type { ContentPreset, GenerationJob, Project, TopicOpportunity } from "../src/types.ts";

/**
 * 单篇重试原本只长在 BatchBoard 里,产出区列表的失败条目没有入口。这里锁住抽出后
 * 的行为:配方能回填就重投,选题/预设失效就明确报错而不是提交幽灵任务。
 */

const project = { id: "p-1", name: "项目", domain: "住宅装修" } as Project;

const opportunity = {
  id: "opp-1",
  projectId: "p-1",
  title: "班组更换",
  audienceStage: "comparing",
  entry: "recommendation",
  gapIds: [],
  strategyId: "s-1",
} as unknown as TopicOpportunity;

const preset = { id: "preset-1", projectId: "p-1", name: "默认", isDefault: true, values: {} } as unknown as ContentPreset;

function job(patch: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "job-1",
    projectId: "p-1",
    topic: "班组更换",
    mode: "simple",
    status: "failed",
    opportunityId: "opp-1",
    presetId: "preset-1",
    ...patch,
  } as GenerationJob;
}

function deps(overrides: {
  opps?: TopicOpportunity[];
  presets?: ContentPreset[];
} = {}) {
  const created: Array<{ projectId: string; name?: string; jobs: unknown[] }> = [];
  const approvedWith: string[][] = [];
  return {
    created,
    approvedWith,
    deps: {
      opportunities: { list: async () => ({ items: overrides.opps ?? [opportunity] }) },
      presets: { list: async () => ({ items: overrides.presets ?? [preset] }) },
      generationBatches: {
        create: async (input: { projectId: string; name?: string; jobs: unknown[] }) => {
          created.push(input);
          return { id: "batch-new" };
        },
      },
      // 审批段注入:真实实现会 import('./api'),而那个模块在加载期就读
      // document.cookie,node 测试里直接抛 ReferenceError。
      approve: async (args: { opportunityIds: string[] }) => {
        approvedWith.push(args.opportunityIds);
        return [opportunity];
      },
    },
  };
}

test("原选题已不在选题池时明确报错,不提交打向幽灵选题的任务", async () => {
  const { deps: d, created } = deps({ opps: [] });
  await assert.rejects(
    () => retryJobOnce({ project, job: job(), deps: d }),
    /原选题已不在选题池/,
  );
  assert.equal(created.length, 0, "不该提交任何批次");
});

test("原预设已不存在时报错,而且在审批之前就判掉", async () => {
  const { deps: d, created, approvedWith } = deps({ presets: [] });
  await assert.rejects(
    () => retryJobOnce({ project, job: job(), deps: d }),
    /原预设已不存在/,
  );
  assert.equal(created.length, 0);
  // 审批是一串写请求,不该为一个注定失败的重试白跑
  assert.equal(approvedWith.length, 0, "预设失效时不该发起审批");
});

test("配方齐全时重投一个单任务批次,并带上「重试 ·」名字", async () => {
  const { deps: d, created, approvedWith } = deps();
  const result = await retryJobOnce({ project, job: job(), deps: d });
  assert.equal(result.batchId, "batch-new");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.projectId, "p-1");
  assert.equal(created[0]?.name, "重试 · 班组更换");
  // 单任务:一个选题 × 一个预设
  assert.equal(created[0]?.jobs.length, 1);
  assert.deepEqual(approvedWith, [["opp-1"]]);
});

test("选题没标题时批次名不留空", async () => {
  const { deps: d, created } = deps();
  await retryJobOnce({ project, job: job({ topic: "" }), deps: d });
  assert.equal(created[0]?.name, "重试 · 选题");
});

test("原预设被删但有默认预设时回落并带出提示,不直接失败", async () => {
  // 任务记的 preset-1 已不存在,池里只有另一个默认预设 → 回落 + 提示
  const fallback = { ...preset, id: "preset-other", isDefault: true } as ContentPreset;
  const { deps: d, created } = deps({ presets: [fallback] });
  const result = await retryJobOnce({ project, job: job(), deps: d });
  assert.equal(created.length, 1, "回落成功就该真的提交");
  assert.deepEqual(result.warnings, ["原预设已删除，已回落到默认预设。"]);
});

test("预设池整个为空才判「原预设已不存在」", async () => {
  const { deps: d } = deps({ presets: [] });
  await assert.rejects(() => retryJobOnce({ project, job: job(), deps: d }), /原预设已不存在/);
});

test("任务没有 opportunityId 时也不硬提交", async () => {
  const { deps: d, created } = deps();
  await assert.rejects(
    () => retryJobOnce({ project, job: job({ opportunityId: undefined, opportunitySnapshot: undefined }), deps: d }),
    /选题/,
  );
  assert.equal(created.length, 0);
});

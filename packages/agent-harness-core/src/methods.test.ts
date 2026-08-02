import { describe, expect, it } from "vitest";
import { BUILT_IN_GENERATION_PRESETS } from "@content-agent/agent-core";
import { DEFAULT_HARNESS_METHOD_ID, HARNESS_METHOD_PROFILES, getHarnessMethodProfile, isHarnessMethodId } from "./methods.js";

const bodyLength = (maximum: unknown): "short" | "medium" | "long" => {
  const value = Number(maximum);
  return value <= 120 ? "short" : value <= 220 ? "medium" : "long";
};

describe("Agent Harness method profiles", () => {
  it("逐项覆盖旧方法的十个规范 ID、名称、说明、阶段、入口与篇幅区间", () => {
    expect(HARNESS_METHOD_PROFILES).toHaveLength(10);
    expect(HARNESS_METHOD_PROFILES.map((item) => item.id)).toEqual(BUILT_IN_GENERATION_PRESETS.map((item) => item.id));
    for (const legacy of BUILT_IN_GENERATION_PRESETS) {
      const profile = getHarnessMethodProfile(legacy.id as Parameters<typeof getHarnessMethodProfile>[0]);
      expect(profile.label).toBe(legacy.label);
      expect(profile.description).toBe(legacy.description);
      expect(profile.noviceExplanation).toBe(legacy.noviceExplanation);
      expect(profile.audienceStage).toBe(legacy.parameterValues.audience_stage);
      expect(profile.entryRoute).toBe(legacy.parameterValues.entry_route);
      expect(profile.bodyLength).toBe(bodyLength(legacy.parameterValues.body_max_chars));
      expect(profile.bodyRole.length).toBeGreaterThan(10);
      expect(profile.commentRole.length).toBeGreaterThan(10);
      expect(profile.boundaryPolicy.length).toBeGreaterThan(10);
    }
  });

  it("只有均衡信息补全是默认推荐，未知方法不能进入合同", () => {
    expect(DEFAULT_HARNESS_METHOD_ID).toBe("balanced_information");
    expect(HARNESS_METHOD_PROFILES.filter((item) => item.recommended).map((item) => item.id)).toEqual([DEFAULT_HARNESS_METHOD_ID]);
    expect(isHarnessMethodId("comparison_framework")).toBe(true);
    expect(isHarnessMethodId("invented_method")).toBe(false);
  });
});

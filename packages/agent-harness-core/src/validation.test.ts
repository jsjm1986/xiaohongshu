import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_SEEDING_MODE, type HarnessSeedingMode } from "./methods.js";

/*
  素人代发种草模式。默认开(peer_seeding),因为这个通道的实际用途就是给真人素人
  账号起草代发内容;brand_voice 保留原有的机构口吻严格校验。
*/
describe("素人代发种草模式", () => {
  it("默认模式是素人代发", () => {
    const mode: HarnessSeedingMode = DEFAULT_HARNESS_SEEDING_MODE;
    expect(mode).toBe("peer_seeding");
  });
});

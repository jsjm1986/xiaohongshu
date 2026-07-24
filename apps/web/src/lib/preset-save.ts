import { mergeCommentRichnessOverrides, type SimpleSettingOverrides } from './simple-generation';

// 把极简模式「高级设置」的覆盖项映射为可存入预设的 values(注册表参数 id)。
// 纯函数,不 import ./api,可在 Node 测试下独立 import。
// city/doctor/mustInclude/forbidden 是项目级覆盖,不进预设。
export function buildPresetValuesFromOverrides(overrides: SimpleSettingOverrides): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (overrides.audienceStage) values.audience_stage = overrides.audienceStage;
  if (overrides.entryPoint) values.entry_route = overrides.entryPoint;
  if (overrides.commentRichness) {
    Object.assign(values, mergeCommentRichnessOverrides({}, overrides.commentRichness));
  }
  return values;
}

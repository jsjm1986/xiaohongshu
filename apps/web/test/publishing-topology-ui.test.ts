import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../src/components/generation/PublishingTopologyControl.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/pages/GeneratorPage.tsx", import.meta.url), "utf8");
const simpleFlow = readFileSync(new URL("../src/pages/IntelligentSimpleFlow.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("简单模式提供自动用户视角与机构账号二选一，不显示素材输入", () => {
  assert.match(page, /function TaskPanel[\s\S]*?<PublishingTopologyControl projectId=\{projectId\}/u);
  const step3 = simpleFlow.indexOf('className="simple-key-settings panel" id="step-3"');
  const choice = simpleFlow.indexOf('className="simple-publishing-choice"', step3);
  const step4 = simpleFlow.indexOf('className="image-library panel" id="step-4"', step3);
  assert.ok(step3 > 0 && choice > step3 && step4 > choice, "简单模式应在原第 3 步显示发布视角二选一");
  assert.match(simpleFlow, /自动用户视角/u);
  assert.match(simpleFlow, /机构账号说明/u);
  assert.match(simpleFlow, /onPublishingTopology\("creative_scenario"\)/u);
  assert.match(simpleFlow, /onPublishingTopology\("institution_owned"\)/u);
  assert.doesNotMatch(simpleFlow, /PublishingTopologyControl|真实用户素材|AI 整理并填充/u);
  assert.match(page, /createSimplePublishingTopologyDraft\(simplePublishingTopology\)/u);
  assert.match(page, /publishingTopology=\{simplePublishingTopology\}/u);
  assert.match(page, /预设只保存写作方法和参数，不保存发布主体、作者事实、确认记录/u);
});

test("设置模式提供自动匹配、机构说明与真实素材三种覆盖", () => {
  assert.match(component, /选题自动匹配/u);
  assert.match(component, /机构账号说明/u);
  assert.match(component, /真实用户素材/u);
  assert.match(component, /api\.authorFacts\.organize/u);
  assert.match(component, /AI 整理并填充/u);
  assert.match(component, /高级复核：逐条编辑事实/u);
  assert.doesNotMatch(component, /className="simple-setting-field"/u);
});

test("素材或事实修改会撤销确认，空白事实不能开放总确认", () => {
  assert.match(component, /const factsReady = value\.facts\.length > 0/u);
  assert.match(component, /updateNarrative[\s\S]*?confirmed: false/u);
  assert.match(component, /updateFact[\s\S]*?confirmed: false/u);
  assert.match(component, /updateFact[\s\S]*?sourceQuote: undefined/u);
  assert.match(component, /disabled=\{!factsReady\}/u);
  assert.match(component, /表示已核对素材，不表示操作员就是文中的用户/u);
});

test("简单二选一、设置三选一和窄屏单栏都有专属样式", () => {
  assert.match(css, /\.simple-publishing-choice__options\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/su);
  assert.match(css, /\.publishing-view-options\s*\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/su);
  assert.match(css, /\.author-fact-card__body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s+minmax\(180px, 240px\)/su);
  assert.match(css, /\.author-facts-confirmation\s*\{[^}]*grid-template-columns:\s*20px\s+minmax\(0, 1fr\)/su);
  assert.match(css, /@media \(max-width:760px\)[\s\S]*?\.author-material-input\s*\{\s*grid-template-columns:1fr/u);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*?\.simple-publishing-choice__options\s*\{\s*grid-template-columns:1fr/u);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*?\.publishing-view-options\s*\{\s*grid-template-columns:1fr/u);
});

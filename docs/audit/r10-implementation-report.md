# R10 图片产物与多模态边界实施报告

## 结论

系统已把“上传图片”和“图片做完了”彻底分开。当前真实生产链是：

`来源素材 → 已审批可见观察 → ImagePlan → ImageBrief → 最终图片资产 → 真实入口截图 → 实际部署`

现有生成只完成前四步中的观察、计划与文字简报。每个新内容包都会保存 `productionArtifacts` 状态账本；当前 `finalImageAsset=absent`、`entrySnapshot=absent`、`deployment=not_deployed`。因此 F19 只完成 `EntryDraft`，F40 只完成 `OrchDraft`，不能显示为真实 Preview、最终 Img 或已发布内容。

## 状态合同

- `imageObservation`: `not_supplied | approved`。只有获批多模态分析可进入生成；仅 `observedFacts/visibleText` 可作为可见事实。
- `imagePlan`: `absent | planned`。`sourceAssetId` 只指规划参考素材；旧 `primaryAssetId` 仅兼容读取。
- `imageBrief`: `disabled | absent | drafted | contract_validated`。它始终是文字制作合同，不是像素资产。
- `finalImageAsset`: `absent | declared | verified`。声明存在不等于已核验。
- `entrySnapshot`: `absent | captured | verified`。截图存在仍需核验其入口身份和时点。
- `deployment`: `not_deployed | recorded | observed | unknown`。`deploymentPlan` 永远不能代替部署记录。

历史包没有状态账本时，UI 与导出显示 `unknown/未记录`，不会从字段缺失推断“没有发生”。

## 一致性检查

`planToCopyAlignment` 检查图片计划锚点、封面承诺、选题缺口和禁止性边界是否被 ImageBrief、标题、正文承接。中文同义改写没有词面重合时只产生人工复核警告；只有把“不得/禁止 X”明确反写成“制作/展示 X”才阻断。

`finalAssetAlignment` 和 `entrySnapshotAlignment` 在没有最终图片或真实入口截图时固定为 `not_evaluated`，不会用计划、简报或上传源图代替评价对象。

正例：计划要求“核验清单”，简报写“将适用条件整理成清单”，标题/正文继续解释核验条件；可通过保守合同检查，但仍不代表最终图片已生成。

反例：边界写“不得使用前后对比”，简报却要求“制作前后对比图并突出效果”；该候选触发硬错误。

## API、修订与界面

数据库为上传图增加受约束的 `asset_kind=source_material`。API 返回 `isFinalAsset=false`，修订时重新注入原任务获批的图片分析，避免图像依据丢失。导出始终使用真实 `content.N.imageBrief`，不会拿 `imagePlan` 顶替空简报。

结果页展示六阶段账本和三项一致性检查；图库明确只管理源素材；公式页对 F19/F40 显示“处理器启用不等于完整图片/预览/部署已落实”。

## 版本与验证

F19/F40 的方程、实际执行范围、边界、阶段和 canonical fingerprint 已更新。当前默认公式版本为 `1.4.0`，执行策略为 `3.3.0`。根级验证通过：Core 110/110、Web 36/36、API 29/29；三工作区类型检查和生产构建均通过。证据目录的 43 条编号公式与运行时方程、指纹、执行说明和边界逐条一致（0 差异）。

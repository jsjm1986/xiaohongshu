# 内容生成 Agent

一个独立于旧 Python 代码的 Node.js 应用。它用项目级 Markdown/TXT 知识库、可版本化公式和统一生成配置，产出标题、正文、标签、评论区参考范式、证据与诊断组成的完整发布包。

## 本地启动

要求 Node.js 24 或更高版本（使用内置 SQLite）。

```powershell
cd content-agent
Copy-Item .env.example .env
npm install
npm run dev
```

首次启动会根据 `.env` 创建管理员。打开 `http://127.0.0.1:5173`；生产构建由 API 在 `http://127.0.0.1:8780` 提供。

首次登录必须修改管理员密码。未配置模型密钥时，系统使用可复现的本地演示生成器完成全链路验证；配置平台密钥或工作区 BYOK 后自动改用模型。

OpenAI-compatible 的 Claude 网关可以直接使用别名变量：

```dotenv
ANTHROPIC_BASE_URL=https://gateway.example/v1
ANTHROPIC_AUTH_TOKEN=your-secret
ANTHROPIC_DEFAULT_OPUS_MODEL=provider/claude-model
OPENAI_TRANSPORT=chat_completions
```

`KNOWLEDGE_CONTEXT_TOKENS` 控制总输入预算。项目知识在安全预算内会全部注入；超过预算才读取 `INDEX.md` 或自动索引并渐进展开相关章节。

模型请求默认超时 90 秒，最多进行 6 次总尝试，按 4、8、16、32、64 秒指数退避；同时最多发出 2 个模型请求。可分别用 `CONTENT_AGENT_MODEL_TIMEOUT_MS`、`CONTENT_AGENT_MODEL_RETRY_ATTEMPTS`、`CONTENT_AGENT_MODEL_RETRY_BASE_DELAY_MS` 和 `CONTENT_AGENT_MODEL_MAX_CONCURRENT` 调整，其中尝试次数和并发数只允许 1 至 8。任务默认每 15 秒写入心跳，90 秒未更新才允许其他实例回收；`CONTENT_AGENT_JOB_CLAIM_TIMEOUT_MS` 必须严格大于 `CONTENT_AGENT_JOB_HEARTBEAT_MS`。

工作区 BYOK 地址默认只允许不含用户名、密码、查询参数或片段的公网 HTTPS URL，并在每次请求及重定向时重新校验解析结果。只有受信、隔离且由你管理的内网网关才应启用 `CONTENT_AGENT_BYOK_ALLOW_HTTP` 或 `CONTENT_AGENT_BYOK_ALLOW_PRIVATE_NETWORK`；这两个开关会削弱 SSRF 防护。

## 可调方法与预设

生成页提供简单模式和设置模式。简单模式选择内置或项目预设；设置模式可在“目标视图”和“公式视图”之间切换，调整信息窗口、正文/评论分工、证据边界、表达方式及运行参数。每个参数都包含公式关联、中文解释、调高/调低影响和认识地位说明。

提交生成前可预览最终解析配置和冲突。生成结果保存参数来源、行为指令、通道信息分配、公式计算结果及未满足项；样本统计和未标定诊断代理不会被显示成平台规律或质量总分。

内置预设不可修改，可以复制为项目预设后继续调整。项目预设只保存相对默认配置的差异，便于后续参数 Schema 升级。

如需重新计算对标语料的描述性画像：

```powershell
npm run analyze:style -- --source ..\70篇对标内容_AI提炼版.jsonl
```

该命令只输出长度分布和信息位置等描述性统计，不会把相关性自动解释为推荐或转化规律。

分类为 `reference-corpus` 的原始案例默认标记为“仅风格分析”，不会随“全部知识”进入生成提示；只有本次任务明确手选时才会注入。

```powershell
npm test
npm run typecheck
npm run build
npm start
```

修改首次登录密码并保持 API 运行后，可迁移旧资料：

```powershell
npm run import:legacy -- --source .. --username admin --password "新密码"
```

迁移命令会幂等导入 `../projects/*.json` 以及主要 Markdown/TXT 方法论文档，不执行或修改旧 Python 系统。

## 数据与备份

所有运行数据位于 `CONTENT_AGENT_DATA_DIR`：SQLite 数据库、知识原文和导出文件都在同一目录。停止应用后复制该目录即可得到一致备份；恢复时将目录放回原位置再启动。

知识库小于上下文安全预算时完整注入；超过预算时读取 `INDEX.md` 和与任务相关的章节。系统不创建向量，也不依赖 PostgreSQL、Redis 或对象存储服务。

只读集成接口位于 `/v1/projects`、`/v1/knowledge/files`、`/v1/generation-jobs` 和 `/v1/content-packages/:id`，使用工作区生成的只读 API Key。

## 研究、实验与版本治理

侧栏“研究与证据”频道独立管理理论主张、论文来源、实践数据快照、预注册实验、参数校准和发布清单。研究文字不会自动进入生成提示词；参数建议只有经过批准、绑定到发布清单并激活后才成为项目运行默认值。每次生成都会冻结所用公式、提示合同、参数策略与证据目录版本，便于后续用真实实验更新参数并复现历史结果。

完整工作流和证据边界见 [docs/research-evidence-center.md](docs/research-evidence-center.md)。

## 项目智能与多模态创作

简单模式不要求先写提示词。选择项目后，点击“分析项目”建立行业信息空间、用户决策任务、信息缺口池、表达策略池和选题卡；选择一张选题卡后，系统围绕同一主题生成三套结构明显不同的完整内容包。信息缺口与表达策略都可以新增、编辑、停用或锁定，修改会直接进入后端编排，不是仅改变界面显示。

完整内容对象按 `H + N(Img, Title, Body) + Cref + aC` 编排：标签承担入口线索，图文完成最低充分说明，评论参考问答补充正文后的条件化缺口，`aC` 给出透明发布身份、置顶顺序、回复与停止规则。评论内容是业务回复参考，不应冒充消费者或虚构第三方口碑。

项目图片支持 JPG、PNG 和 WebP，单张不超过 8 MiB。图片先由当前工作区配置的多模态模型分析，人工确认可见观察后才能作为事实依据；正式生成时系统会再次把所选原图发送给同一个模型，分析摘要不会替代原图。原图与 SQLite 数据均保存在 `CONTENT_AGENT_DATA_DIR`，不会把 Base64 图片写入生成快照。

项目知识库中的已核验内容可以作为事实；行业枚举、读者状态和模型发现的缺口默认是推理或假设。未知项保持未知，关键适用条件、风险和核验方法不能只藏在评论区。覆盖签名会记录近期选题、缺口、通道分配、表达结构和图片角色，用于降低重复，但不被解释为平台推荐规律。

## 部署

```powershell
Copy-Item .env.example .env
# 修改初始管理员密码、SESSION_SECRET 与 MASTER_ENCRYPTION_KEY
docker compose up -d --build
```

对公网部署时，必须在本应用前配置 HTTPS 反向代理，并定期备份 `data/`。生产模式会返回 HSTS，并默认给会话与 CSRF Cookie 添加 `Secure`；反向代理应只向外提供 HTTPS。若仅在可信本机通过 HTTP 调试，可显式设置 `CONTENT_AGENT_SECURE_COOKIES=false`，但不要在公网部署中关闭。

# 运营手册（RUNBOOK）

单机生产环境的日常操作、值班处置与灾难恢复。所有步骤都在本机验证过；
命令默认在仓库根目录 `content-agent/` 执行。

**环境速查**

| 项 | 值 |
|---|---|
| API 服务 | launchd `system/com.xhsai.api`，端口 8780，KeepAlive 自动拉起 |
| 前端 | 由 API 进程静态托管（同端口同源） |
| 服务日志 | `~/Library/Logs/xhsai/api.out.log` / `api.err.log` |
| 数据 | `.env` 的 `CONTENT_AGENT_DATA_DIR`（知识/图片）+ 可独立的 `CONTENT_AGENT_DB_PATH`（SQLite）；相对路径均以仓库根解析 |
| 每日备份 | launchd `com.xhsai.backup` → `~/Library/Application Support/xhsai/backups/auto/`（gzip，保留 14 天） |
| 看门狗 | launchd `com.xhsai.health-watch`，每 5 分钟探测健康、失败率与备份退出/配对/时效/完整性 |
| launchd 脚本位置 | `~/Library/Application Support/xhsai/bin/`（**不是**仓库 scripts/：macOS TCC 会拒绝 launchd 执行"桌面"路径下的脚本，exit 126。`deploy.sh` 每次部署自动刷新拷贝；仓库位置经 plist 的 `CONTENT_AGENT_ROOT` 传入） |
| 健康检查 | `curl http://127.0.0.1:8780/health` |

---

## 1. 日常：开通一个新客户

1. 用系统管理员账号登录 → 团队页。
2. 「创建账号」：填用户名 + 初始密码（≥12 字符），`userKind` 选 **saas**
   （saas 用户登录后进极简创作界面，看不到专家页面）。
3. 建工作区（或把账号加进既有工作区）。角色枚举是 `Owner / Admin /
   KnowledgeEditor / ContentEditor / Viewer`；独立客户管自己的空间给
   `Admin`，客户团队里的写手给 `ContentEditor`。
4. 设额度：设置页 → 平台额度（或 `PATCH /api/settings`，body
   `{"workspaceId":"...","monthlyQuota":100}`，需要 `quota.manage` 权限）。
   注意：额度语义是**总上限**，用完需手工调高，不会按月自动恢复。
5. 客户首次登录会被强制改密。

对账：设置页看余量；账单明细走 `GET /api/settings/quota/ledger?workspaceId=...`
（按月汇总 + 每笔扣退流水，含关联任务 id）。

## 2. 日常：客户忘记密码

1. 核实身份（微信/电话——链接就是登录凭证，发错人等于交出账号）。
2. 团队页 → 该成员行 → 「重置链接」→ 链接已复制。
3. 通过可信渠道发给客户。链接 24 小时有效、用一次即废；重新生成会作废旧链接。
4. 客户自设新密码后，其所有旧会话自动下线。

## 3. 值班：告警种类与处置

告警来源：macOS 桌面通知 + `~/Library/Logs/xhsai/alerts.log` + 可选 IM webhook。同类告警
30 分钟内只发一次。webhook、公网 URL 与异地备份目标只写入仓库外的权限
`600` 运维文件，禁止写进仓库、plist 或命令历史：

```bash
install -d -m 700 "$HOME/Library/Application Support/xhsai"
install -m 600 /dev/null "$HOME/Library/Application Support/xhsai/ops.env"
# 用本机编辑器写入需要的项，不要在终端粘贴真实秘密：
# ALERT_WEBHOOK=...
# ALERT_WEBHOOK_KIND=feishu|dingtalk|generic
# PUBLIC_HEALTH_URL=https://域名/health
# BACKUP_REMOTE=user@host:/安全的专用目录/
# BACKUP_MAX_AGE_HOURS=48
OPS_ENV_FILE="$HOME/Library/Application Support/xhsai/ops.env" \
  bash scripts/health-watch.sh --test
```

`--test` 输出只会显示 webhook“已配置/未配置”，不会回显地址。

| 告警 | 含义 | 处置 |
|---|---|---|
| `service_down` | 本机 /health 无响应 | `tail -50 ~/Library/Logs/xhsai/api.err.log` 找崩溃原因；launchd 会自动拉起，若 crash-loop 看是否坏发布 → 回滚（见 §5） |
| `service_db_unwritable` | 本机数据库不可写 | 大概率磁盘满或库损坏。`df -h /` 查磁盘；损坏则走恢复（见 §6） |
| `service_degraded` | 本机 /health 非 ok，或 HTTP 响应不符合健康 JSON 协议 | 查看 HTTP 状态、响应体及结构化健康响应中的磁盘、队列和数据库字段 |
| `public_down` / `public_degraded` | 本机正常但公网入口异常 | 先查 DNS/TLS，再查 tunnel 进程与 `~/Library/Logs/xhsai/tunnel.err.log`；不要盲目重启正常的 API |
| `public_db_unwritable` | 公网入口报告数据库不可写 | 按本机数据库故障处理，同时确认公网没有命中旧实例 |
| `failure_rate` | 最近 1 小时生成失败 ≥3 且占比 ≥50% | 疑似网关断供或坏发布。查产出区最新失败任务的错误信息；网关断供时系统会自动清队退款 |
| `failure_rate_unavailable` | 无法从仓库 `.env` 解析真实数据库路径 | 检查 `.env`、Node 与 `prepare-backup.mjs`；看门狗不会回退查询旧的 `data/app.db` |
| `backup_failed` | `com.xhsai.backup` 最近一次退出非零 | 查 `backup.err.log` 与 `launchctl print system/com.xhsai.backup` |
| `backup_missing` | 自动备份目录没有归档（运行中的备份不会触发） | 立即手工运行备份并排查 launchd 调度 |
| `backup_unpaired` | 最新数据库包与文件包缺一份或时间戳不同 | 不要用孤立归档恢复；查中断、磁盘空间与备份日志 |
| `backup_stale` | 最新备份超过 `BACKUP_MAX_AGE_HOURS`（默认 48） | 手工触发备份并确认每日任务仍在运行 |
| `backup_corrupt` | gzip/tar 损坏、不可读取或 tar 缺少 `.env` | 保留坏归档取证，检查磁盘后重新备份并验证 |

## 4. 变更：部署新版本

首次把服务切到可复现的系统级守护前：

```bash
source "$HOME/.nvm/nvm.sh"
nvm install 24
nvm use 24
npm ci
npx playwright install chromium
npm run build
NODE_BIN="$(nvm which 24)"
env TARGET_USER="$USER" CONTENT_AGENT_ROOT="$PWD" NODE_BIN="$NODE_BIN" \
  bash ops/launchd/install.sh
bash ops/launchd/verify.sh
```

安装器必须从普通用户阶段进入：它会先把模板和自身复制到
`~/Library/Application Support/xhsai/launchd-installer/`，再请求 sudo；不要直接
`sudo bash ops/launchd/install.sh`，否则 macOS TCC 可能拒绝特权进程读取 Desktop。
安装器会先保存旧 plist、运维脚本与 `launchctl print` 到
`~/Library/Application Support/xhsai/launchd-backups/launchd.<随机后缀>/`。三个新
LaunchDaemon 全部加载、结构化健康通过、备份/看门狗首次运行成功且备份对可读后，
才卸载历史 LaunchAgent 并移除 `~/Library/LaunchAgents/` 下的原 plist；失败会恢复
原 plist 和运维脚本，且只重新加载安装前确实 loaded 的旧 GUI job。plist 不保存
webhook 或异地地址，只引用权限 `600` 的 `ops.env`。首次任务默认最多等待 3600
秒；超大图片目录或慢速异地同步确需更长时间时，通过
`CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS` 显式调高。

常规部署：

```bash
bash scripts/deploy.sh
```

脚本只接受与 `origin/main` 一致的干净 `main`，且必须使用 Node 24。固定顺序为：
确认该 SHA 的 GitHub Actions `CI` 已成功 → 在隔离目录严格 `npm ci` → build → typecheck → 全量测试 → 供应锁文件版本的 Chromium → 浏览器
冒烟 → 上线前备份 → 清理残留 GUI API LaunchAgent → 把隔离产物换入活树 → 重启 → 确认旧 PID 退出且新 PID 监听 → 结构化健康 → 本机黑盒。任一门禁失败即
退出，不提供跳过测试开关；隔离构建失败时活树与 API 保持原样。换入运行时之后若失败，会先通过 launchd 停止 API，再把旧运行时完整
解压到隔离目录，恢复旧 `dist`、`node_modules` 与已安装运维脚本，并显式
bootstrap/kickstart 旧 API。只有旧 API 重新出现监听且结构化健康满足 `status=ok`
和 `databaseWritable=true` 后才删除临时回滚目录；恢复本身失败时会保留回滚证据。

配置 `PUBLIC_SMOKE_BASE_URL=https://域名` 后会追加公网黑盒；设置
`REQUIRE_PUBLIC_SMOKE=1` 可把“未配置公网地址”也视为部署失败。

首次安装后验收定时备份：

```bash
sudo launchctl kickstart -k system/com.xhsai.backup
# 等 backup 任务退出后：
BACKUP_DIR="$HOME/Library/Application Support/xhsai/backups/auto"
ls -l "$BACKUP_DIR"/app-*.db.gz "$BACKUP_DIR"/files-*.tar.gz
gzip -t "$(ls -t "$BACKUP_DIR"/app-*.db.gz | sed -n '1p')"
tar -tzf "$(ls -t "$BACKUP_DIR"/files-*.tar.gz | sed -n '1p')"
bash ops/launchd/verify.sh
```

文件包清单必须包含 `.env`，并在对应目录存在时包含 `data/knowledge/` 与
`data/images/`；数据库与文件包权限均应为 `600`。备份先由 Node 24 将桌面路径
中的一致快照复制到 `Application Support` 隔离区，再由 gzip/tar 归档；这是为了
适配 LaunchDaemon 的 macOS TCC 边界，不需要给 `/bin/bash`、`sqlite3` 或 `tar`
授予全磁盘访问权限。脚本以目录锁拒绝并发任务，先写隐藏临时文件并校验，再原子
改名为同时间戳的数据库/文件包；中断不会把半个归档冒充最新备份。

备份脚本与失败率巡检都由 Node 安全解析仓库 `.env`，不执行 `source .env`：
`CONTENT_AGENT_DATA_DIR` 和可选的 `CONTENT_AGENT_DB_PATH` 使用与 API 相同的路径
规则（相对仓库根、绝对路径原样保留）。数据库独立放置时，归档仍把真实 dataDir
中的 `knowledge/`、`images/` 放到文件包的 `data/` 下。路径解析失败或配置数据库
不存在会直接让备份失败，绝不回退到旧的 `data/app.db`。

看门狗每 5 分钟检查最近退出状态、最新同时间戳归档对、时效和完整性；同类告警
30 分钟去重。每轮先用 Node 24 计算两个归档的 SHA-256，权限 `600` 的
`~/Library/Application Support/xhsai/.backup-verification-cache` 只缓存
“文件名 + 内容哈希 + 上次深检结果”。内容哈希未变化时不反复解压；任一字节变化
都会重新执行 gzip/tar 与 `.env` 检查。

## 5. 变更：回滚

```bash
git switch -c rollback/<坏提交短号>
git revert <坏提交>
# 按仓库授权流程推送回滚分支；受保护主线必须走审批合并，不绕过保护规则。
git push -u origin HEAD
# 将回滚分支合并到 origin/main，并等待该 main 提交的 CI 全部通过。
git switch main
git fetch origin main
git merge --ff-only origin/main
bash scripts/deploy.sh
```

顺序必须是 `revert → push/授权合并到 origin/main → 等待 CI → deploy`。生产机上的
本地回滚提交不等于已发布主线；不得为绕过这一步而放宽 deploy 对 origin/main 完全一致和干净 main 的门禁。

数据库迁移不可自动回滚：新版本若加过列/表（v30 物化列、v31 重置令牌等），
回滚代码到旧版本通常兼容（旧代码不读新列）；跨大版本回滚前先做一次
`bash scripts/backup-production.sh`。

## 6. 灾难：从备份恢复数据库

```bash
# 1) 停服务（KeepAlive 会拉起普通 kill，必须 bootout）
sudo launchctl bootout system/com.xhsai.api

# 2) 保护现场 + 恢复快照（下列为默认路径；自定义路径按 .env 替换）
mv data/app.db data/app.db.broken-$(date +%s)
rm -f data/app.db-wal data/app.db-shm
BACKUP_DIR="$HOME/Library/Application Support/xhsai/backups/auto"
gunzip -kc "$BACKUP_DIR/app-<最近一份>.db.gz" > data/app.db

# 3) 在隔离目录检查同时间戳文件包，再恢复知识、图片与环境
RESTORE_DIR="$(mktemp -d)"
tar -xzf "$BACKUP_DIR/files-<同一时间戳>.tar.gz" -C "$RESTORE_DIR"
[ ! -d "$RESTORE_DIR/data/knowledge" ] || rsync -a "$RESTORE_DIR/data/knowledge/" data/knowledge/
[ ! -d "$RESTORE_DIR/data/images" ] || rsync -a "$RESTORE_DIR/data/images/" data/images/
cp .env ".env.before-restore-$(date +%s)"
install -m 600 "$RESTORE_DIR/.env" .env

# 4) 拉起并验证
sudo launchctl bootstrap system /Library/LaunchDaemons/com.xhsai.api.plist
curl http://127.0.0.1:8780/health
rm -rf "$RESTORE_DIR"
```

RPO = 上次备份时间（每日一次；关键操作前手工跑一次备份脚本可缩短）。

> 恢复流程于 2026-08-13 用当日备份完整演练过一次:临时实例六表计数与
> 生产一致、知识原文按库内路径可读、/health ok。注意 files 包解出的是
> `data/knowledge/`、`data/images/` 与 `.env`(相对仓库根),恢复目标必须让数据目录落在
> `<dataDir>/knowledge/`——生产 dataDir 就是 `data/`,按上述命令 `-C .`
> 解到仓库根即正确;往别的 dataDir 恢复时需要相应挪位。

异地目标启用前先确认它是专用非根目录，且账号只能写该目录。用本地临时目录或
测试桶执行一次 `BACKUP_REMOTE=... bash scripts/backup-production.sh`，确认数据库、
文件包均到达且目标里预先放置的 `keep.txt` 未被删除，再写入 `ops.env`。脚本不会
使用 `rsync --delete`；远端过期策略必须在目标端独立配置。

## 7. 安全：master key 轮换（BYOK 加密钥）

1. `.env`：新钥写 `MASTER_ENCRYPTION_KEY`，旧钥挪到
   `MASTER_ENCRYPTION_KEY_PREVIOUS`（逗号分隔可多个）。
2. 重启服务（`bash scripts/deploy.sh` 或 kill 进程）。
3. 重加密存量：`npx tsx --tsconfig apps/api/tsconfig.json scripts/rotate-byok-keys.mts`
   （幂等，可在服务运行时执行）。
4. 输出「可以移除 PREVIOUS」后，从 `.env` 删掉旧钥再重启一次。

若脚本报某工作区密文解不开：该客户需重新录入 BYOK key。

## 8. 合规：客户要数据 / 要求删除

```bash
# 导出（全量结构化 JSON，知识原文内联；动作写审计）
GET /api/admin/workspaces/:id/export

# 物理清除（二段式：必须先在界面软删工作区，再执行）
DELETE /api/admin/workspaces/:id/purge
```

物理清除会级联硬删全部业务数据并删除盘上知识文件；审计日志刻意保留
（删除动作本身必须可追溯）。两端点都仅限系统管理员。

## 9. 定期巡检（建议每周一次）

- `bash scripts/production-blackbox-smoke.sh` —— 18 项黑盒检查（健康/静态面/认证边界/V1/错误卫生），公网加 `BASE=https://xhsai.maycran.com`
- 大版本发布前跑真实模型全链路：`SMOKE_PROJECT_ID=<项目ID> npm run smoke:full`。
  脚本与备份 helper 共用 Node `.env` 路径解析：SQLite 必须从
  `CONTENT_AGENT_DB_PATH` 克隆，knowledge/images 必须从
  `CONTENT_AGENT_DATA_DIR` 复制；两者可独立配置，相对路径均以仓库根解析，绝不回退
  到旧的 `ROOT/data/app.db`。默认把这些真实源数据克隆到 `.tmp-test/`，不改生产库，
  但会真实调用模型并产生费用。`SMOKE_TEST_SOURCE_DATA_DIR` 与
  `SMOKE_TEST_SOURCE_DATABASE_PATH` 等 `SMOKE_TEST_*` 变量只供 `NODE_ENV=test` 的
  子进程安全测试，不能作为运维改源开关；非测试环境会失败关闭。
  正常结束、失败或收到 `SIGINT` / `SIGTERM` / `SIGHUP` 时都会先等待 SQLite
  备份及 knowledge/images 复制稳定，再关闭应用、恢复网络拦截、删除克隆
  `data/`，最后写权限 `600` 的结果；信号清理后会向自身重发原信号，因此调用方
  仍能识别真实的信号退出。排障确需保留克隆时才显式设置
  `SMOKE_KEEP_CLONE_DATA=true`；只有明确接受修改开发库时才可设置
  `SMOKE_PERSIST_DEVELOPMENT_DATA=true`。
  每次运行还会写权限 `600` 的 owner marker，其中包含密码学随机 `runToken`，以及
  带 `kind/backend/value` 的结构化进程启动标识。Linux 的 boot ID、btime 和 macOS
  `ps` 是互不混用的后端，复核 marker 时只重读原后端；原后端暂时不可读会标记为
  unknown 并 fail-safe 保留，而不会切换后端误判 PID 复用。`ps` 路径固定为 UTC/C
  locale，避免调用者时区或语言环境影响结果。启动时默认只回收超过 24 小时、
  owner 已死亡或 PID 已复用、且未声明 keep 的历史运行目录中的 `data/`，报告目录
  会保留取证；无 marker 的旧目录只有在可读结果明确为已完成/已失败且
  `keptByRequest=false` 时才回收，缺失或未结束报告一律保留。新鲜、仍有同一启动
  进程存活或显式 keep 的克隆不会删除。宽限期可用
  `SMOKE_STALE_CLONE_GRACE_MS` 调整，但不得低于 60000 毫秒。
  单任务超时默认 45 分钟（2026-08-13 实测 simple 9m37s、advanced
  23m47s；旧 12 分钟默认会误报高级模式超时）。
- `curl http://127.0.0.1:8780/health` —— status 应为 `ok`
- `ls -lh "$HOME/Library/Application Support/xhsai/backups/auto/"` —— 备份在产出且是 `.gz`
- `tail -20 "$HOME/Library/Logs/xhsai/alerts.log"` —— 有没有被漏掉的告警
- `df -h /` —— 磁盘余量 > 10GB
- `npx tsx scripts/audit-semantic-coverage.mts` —— 语义覆盖月报（产出到 `docs/audits/`）
- 抽查复制 Markdown、单篇 Markdown/DOCX/PDF 与批量 Markdown/清单：文件离开界面后
  仍须显式带 `validation.qualityStatus` 的同源中文状态。只有 `passed` 是“通过”；
  `needs_review` 是“建议复核（可复制导出）”；`blocked` 明确“不可交付”。只有历史包
  缺少该字段时才按 `valid` 回退。

## 10. 已知边界（对外沟通口径）

- 额度是总上限，不按月自动恢复（文案与实现一致）。
- 43 条公式的真实实现口径：active 7 / partial 19 / conditional 3 /
  protocol-only 14——对外描述能力按 active/partial 说，protocol-only
  是文档承诺、运行时不执行（清单见 `docs/audits/semantic-coverage-*.md`）。
- 系统验证过的是「AI 判官认为更有说服力」，未验证真实触达/转化，
  不得对客户承诺爆款、流量或转化效果。
- 单机部署：并发 2，批量任务平均约 1 小时/篇收敛；排队位次在界面可见。

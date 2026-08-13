# 运营手册（RUNBOOK）

单机生产环境的日常操作、值班处置与灾难恢复。所有步骤都在本机验证过；
命令默认在仓库根目录 `content-agent/` 执行。

**环境速查**

| 项 | 值 |
|---|---|
| API 服务 | launchd `system/com.xhsai.api`，端口 8780，KeepAlive 自动拉起 |
| 前端 | 由 API 进程静态托管（同端口同源） |
| 服务日志 | `~/Library/Logs/xhsai/api.out.log` / `api.err.log` |
| 数据 | `data/app.db`（SQLite）+ `data/knowledge/`（知识原文）+ `.env` |
| 每日备份 | launchd `com.content-agent.backup` → `data/backups/auto/`（gzip，保留 14 天） |
| 看门狗 | launchd `com.content-agent.health-watch`，每 5 分钟探活 + 失败率聚合 |
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

告警来源：macOS 桌面通知 + `data/logs/alerts.log` + 可选 IM webhook
（配置见 `scripts/health-watch.sh` 头部注释；`--test` 参数发测试消息验证通路）。
同类告警 30 分钟内只发一次。

| 告警 | 含义 | 处置 |
|---|---|---|
| `service_down` | /health 无响应 | `tail -50 ~/Library/Logs/xhsai/api.err.log` 找崩溃原因；launchd 会自动拉起，若 crash-loop 看是否坏发布 → 回滚（见 §5） |
| `db_unwritable` | 数据库写入失败 | 大概率磁盘满或库损坏。`df -h /` 查磁盘；损坏则走恢复（见 §6） |
| `disk_low` | 磁盘余量 < 1GiB | 清理：`data/backups/` 旧手工快照、`~/Library/Caches`（Cursor ShipIt 更新残留常见 1GB+）、`npm cache clean --force`。2026-08-13 实战案例：满盘由系统 purgeable + 冗余手工备份叠加导致 |
| `failure_rate` | 最近 1 小时生成失败 ≥3 且占比 ≥50% | 疑似网关断供或坏发布。查产出区最新失败任务的错误信息；网关断供时系统会自动清队退款 |

## 4. 变更：部署新版本

```bash
bash scripts/deploy.sh
```

拉代码 → 装依赖 → 构建 → **全量测试（不过不上线）** → 重启 → 60 秒探活。
紧急场景可 `SKIP_TESTS=1`（平时禁止）。

浏览器冒烟（可选加验）：`npm run smoke:browser`。

## 5. 变更：回滚

```bash
git revert <坏提交>   # 或 git reset --hard <好提交>（未推送时）
bash scripts/deploy.sh
```

数据库迁移不可自动回滚：新版本若加过列/表（v30 物化列、v31 重置令牌等），
回滚代码到旧版本通常兼容（旧代码不读新列）；跨大版本回滚前先做一次
`bash scripts/backup-production.sh`。

## 6. 灾难：从备份恢复数据库

```bash
# 1) 停服务（KeepAlive 会拉起普通 kill，必须 bootout）
sudo launchctl bootout system/com.xhsai.api

# 2) 保护现场 + 恢复快照
mv data/app.db data/app.db.broken-$(date +%s)
rm -f data/app.db-wal data/app.db-shm
gunzip -kc data/backups/auto/app-<最近一份>.db.gz > data/app.db

# 3) 知识原文（如也损坏）
tar -xzf data/backups/auto/files-<同一时间戳>.tar.gz -C .

# 4) 拉起并验证
sudo launchctl bootstrap system /Library/LaunchDaemons/com.xhsai.api.plist
curl http://127.0.0.1:8780/health
```

RPO = 上次备份时间（每日一次；关键操作前手工跑一次备份脚本可缩短）。

> 恢复流程于 2026-08-13 用当日备份完整演练过一次:临时实例六表计数与
> 生产一致、知识原文按库内路径可读、/health ok。注意 files 包解出的是
> `data/knowledge/`(相对仓库根),恢复目标必须让知识目录落在
> `<dataDir>/knowledge/`——生产 dataDir 就是 `data/`,按上述命令 `-C .`
> 解到仓库根即正确;往别的 dataDir 恢复时需要相应挪位。

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

- `curl http://127.0.0.1:8780/health` —— status 应为 `ok`
- `ls -lh data/backups/auto/ | tail -4` —— 备份在产出且是 `.gz`
- `tail -20 data/logs/alerts.log` —— 有没有被漏掉的告警
- `df -h /` —— 磁盘余量 > 10GB
- `npx tsx scripts/audit-semantic-coverage.mts` —— 语义覆盖月报（产出到 `docs/audits/`）

## 10. 已知边界（对外沟通口径）

- 额度是总上限，不按月自动恢复（文案与实现一致）。
- 43 条公式的真实实现口径：active 7 / partial 19 / conditional 3 /
  protocol-only 14——对外描述能力按 active/partial 说，protocol-only
  是文档承诺、运行时不执行（清单见 `docs/audits/semantic-coverage-*.md`）。
- 系统验证过的是「AI 判官认为更有说服力」，未验证真实触达/转化，
  不得对客户承诺爆款、流量或转化效果。
- 单机部署：并发 2，批量任务平均约 1 小时/篇收敛；排队位次在界面可见。

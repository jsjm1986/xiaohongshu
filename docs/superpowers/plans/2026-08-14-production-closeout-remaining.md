# 生产收口剩余两项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐中断会话留下的备份提交指纹、隔离构建/运行时切换、旧 GUI API 残留和 CI 凭证门禁，使现有 WIP 可以提交、等 CI 绿后干净部署。

**Architecture:** 备份 manifest 升到 v2，写入 git HEAD；`deploy.sh` 在回滚目录里隔离 `npm ci/build/test`，通过后再把 dist/node_modules 换进活树；构建失败不得停 API。verify/deploy 拒绝仍 loaded 的 GUI `com.xhsai.api`。CI workflow 最小权限，部署前用 GitHub Actions API 确认该 SHA 的 CI 已成功。

**Tech Stack:** bash, Node 24, GitHub Actions, launchd, node:test

## Global Constraints

- 文档、注释、提交说明用中文。
- 先写失败测试再改生产代码。
- 不把 webhook / 异地地址写入仓库。
- 生产进程在验证通过并部署前保持运行。
- 不提供 SKIP_TESTS。

---

### Task 1: 备份 manifest 写入 git 提交

**Files:**
- Modify: `scripts/backup-manifest.mjs`
- Modify: `scripts/backup-production.sh`
- Modify: `apps/api/test/operations-scripts.test.ts`

**Interfaces:**
- Consumes: `git -C "$ROOT" rev-parse HEAD`
- Produces: `writeManifest(stamp, db, files, output, gitCommit)`；schema `content-agent-backup/v2`；`gitCommit` 为 40 位 hex 或 `null`

- [ ] **Step 1–4:** 失败测试：无 git 仓库时 schema=v2 且 `gitCommit=null`；有 git 仓库时写入 HEAD。实现后旧 v1 manifest 仍可 inspect。
- [ ] **Step 5:** 不单独提交，并入收口 PR。

### Task 2: 隔离构建与运行时切换

**Files:**
- Modify: `scripts/deploy.sh`
- Modify: `apps/api/test/launchd-deploy-contract.test.ts`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Produces: `$ROLLBACK_DIR/build` 源码副本（不含活树 `dist`/`node_modules`/`data`）；门禁在副本内跑；`SERVICE_TOUCHED=1` 仅在换入运行时之前；构建失败直接退出且不 bootout。

- [ ] **Step 1–4:** 静态合同断言隔离构建目录；`typecheck-fails` 夹具下活树 marker 仍为 `old` 且无 kickstart。实现 copy → isolated npm → swap。
- [ ] **Step 5:** 并入收口 PR。

### Task 3: 旧 GUI API 与 CI 凭证门禁

**Files:**
- Modify: `scripts/deploy.sh`
- Modify: `ops/launchd/verify.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/api/test/launchd-deploy-contract.test.ts`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Produces: `launchctl print gui/$UID/com.xhsai.api` 若 loaded 则 bootout；verify 失败关闭。CI `permissions.contents: read` + `persist-credentials: false`。部署在 `npm ci` 前确认该 SHA 的 workflow `CI` 为 `completed/success`。

- [ ] **Step 1–4:** 静态断言 + `ci-red` 夹具拒绝部署。实现后夹具默认 GitHub 返回 success。
- [ ] **Step 5:** 本地全量验证后按主题提交/PR。

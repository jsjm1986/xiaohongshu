#!/bin/bash
#
# 生产部署一键脚本:拉代码 → 装依赖 → 构建 → 全量测试 → 重启 → 探活。
# 任何一步失败即中止,服务保持旧版本继续跑——测试不过不上线。
#
# 用法(在任意目录):
#   bash "/Users/a1234/Desktop/开发项目/小红书创作/文案/content-agent/scripts/deploy.sh"
# 可选:
#   SKIP_TESTS=1  跳过测试(仅限紧急回滚等特殊场景,平时别用)
#
# 重启方式:kill 进程,由 launchd(com.xhsai.api, KeepAlive)拉起新代码。
# kickstart 需要 sudo,而 kill 属主进程不需要——这是无人值守下最稳的路径。
set -euo pipefail

REPO_DIR="/Users/a1234/Desktop/开发项目/小红书创作/文案/content-agent"
PORT=8780
HEALTH_URL="http://127.0.0.1:${PORT}/health"

# 构建与测试需要 devDependencies:NODE_ENV=production 会让 npm ci 悄悄跳过
# 它们(tsc/vitest/playwright 全消失,报 127)。shell 里 source 过生产 .env
# 就会踩中。运行时的 NODE_ENV 由 launchd plist 提供,与本脚本无关。
unset NODE_ENV

cd "${REPO_DIR}"

echo "==> [1/6] 拉取 main 最新代码"
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "${LOCAL}" = "${REMOTE}" ]; then
  echo "    已是最新 (${LOCAL:0:8})，继续执行以重建/重启"
else
  git pull --ff-only origin main
  echo "    ${LOCAL:0:8} -> $(git rev-parse --short HEAD)"
fi

echo "==> [2/6] 安装依赖(锁文件为准)"
npm ci --silent 2>/dev/null || npm install --silent

echo "==> [3/6] 构建"
npm run build

if [ "${SKIP_TESTS:-0}" = "1" ]; then
  echo "==> [4/6] 跳过测试(SKIP_TESTS=1)"
else
  echo "==> [4/6] 全量测试(不过不上线)"
  npm test
fi

echo "==> [5/6] 重启服务(kill 后由 launchd KeepAlive 拉起)"
OLD_PID=$(lsof -ti :${PORT} || true)
if [ -n "${OLD_PID}" ]; then
  kill "${OLD_PID}"
  echo "    已终止旧进程 ${OLD_PID}"
else
  echo "    端口 ${PORT} 无进程(可能已停),等 launchd 拉起"
fi

echo "==> [6/6] 探活(最多等 60 秒)"
for i in $(seq 1 30); do
  sleep 2
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "${HEALTH_URL}" || true)
  if [ "${STATUS}" = "200" ]; then
    echo "    健康检查通过:"
    curl -s "${HEALTH_URL}" | head -c 300; echo
    echo "==> 部署完成 $(git rev-parse --short HEAD)"
    exit 0
  fi
done

echo "!! 探活超时:服务未在 60 秒内恢复,请查日志:" >&2
echo "   tail -50 ~/Library/Logs/xhsai/api.err.log" >&2
exit 1

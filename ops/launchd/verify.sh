#!/bin/bash
# 校验已安装的系统级服务、运行用户、Node 版本、健康响应和最近备份。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${CONTENT_AGENT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
TARGET_USER="${TARGET_USER:-${SUDO_USER:-$(id -un)}}"
TARGET_HOME="${TARGET_HOME:-$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory | awk '{print $2}')}"
SUPPORT_DIR="$TARGET_HOME/Library/Application Support/xhsai"
OPS_ENV="$SUPPORT_DIR/ops.env"
LABELS=(com.xhsai.api com.xhsai.backup com.xhsai.health-watch)

for label in "${LABELS[@]}"; do
  plist="/Library/LaunchDaemons/$label.plist"
  [ -f "$plist" ] || { echo "缺少 $plist" >&2; exit 1; }
  plutil -lint "$plist" >/dev/null
  launchctl print "system/$label" >/dev/null
done

TARGET_UID="$(id -u "$TARGET_USER")"
if launchctl print "gui/$TARGET_UID/com.xhsai.api" >/dev/null 2>&1; then
  echo "历史 GUI API 仍 loaded: gui/$TARGET_UID/com.xhsai.api" >&2
  exit 1
fi

API_PLIST="/Library/LaunchDaemons/com.xhsai.api.plist"
PLIST_USER="$(/usr/libexec/PlistBuddy -c 'Print :UserName' "$API_PLIST")"
NODE_BIN="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$API_PLIST")"
ENV_ARG="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$API_PLIST")"
NODE_ENV_VALUE="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:NODE_ENV' "$API_PLIST")"
[ "$PLIST_USER" = "$TARGET_USER" ] || { echo "API UserName 错误: $PLIST_USER" >&2; exit 1; }
[ "$ENV_ARG" = "--env-file=$REPO/.env" ] || { echo "API 未严格加载目标 .env" >&2; exit 1; }
[ "$NODE_ENV_VALUE" = "production" ] || { echo "API NODE_ENV 不是 production" >&2; exit 1; }
case "$("$NODE_BIN" --version)" in
  v24.*) ;;
  *) echo "API 未使用 Node 24: $NODE_BIN" >&2; exit 1 ;;
esac

BODY="$(curl -fsS --max-time 5 http://127.0.0.1:8780/health)"
printf '%s' "$BODY" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
if payload.get("status") != "ok" or payload.get("databaseWritable") is not True:
    raise SystemExit(f"health 未就绪: {payload}")
'

API_PIDS=($(lsof -tiTCP:8780 -sTCP:LISTEN 2>/dev/null || true))
[ "${#API_PIDS[@]}" -eq 1 ] || { echo "8780 监听进程数量异常: ${#API_PIDS[@]}" >&2; exit 1; }
API_PID="${API_PIDS[0]}"
PROCESS_USER="$(ps -o user= -p "$API_PID" | tr -d ' ')"
[ "$PROCESS_USER" = "$TARGET_USER" ] || { echo "API 进程用户错误: $PROCESS_USER" >&2; exit 1; }

[ -f "$OPS_ENV" ] || { echo "缺少仓库外运维环境接口" >&2; exit 1; }
OPS_MODE="$(stat -f '%Lp' "$OPS_ENV" 2>/dev/null || stat -c '%a' "$OPS_ENV" 2>/dev/null || true)"
[ "$OPS_MODE" = "600" ] || { echo "ops.env 权限不是 600: $OPS_MODE" >&2; exit 1; }
cmp -s "$REPO/scripts/backup-production.sh" "$SUPPORT_DIR/bin/backup-production.sh"
cmp -s "$REPO/scripts/health-watch.sh" "$SUPPORT_DIR/bin/health-watch.sh"
cmp -s "$REPO/scripts/prepare-backup.mjs" "$SUPPORT_DIR/bin/prepare-backup.mjs"
cmp -s "$REPO/scripts/backup-manifest.mjs" "$SUPPORT_DIR/bin/backup-manifest.mjs"
cmp -s "$REPO/scripts/storage-paths.mjs" "$SUPPORT_DIR/bin/storage-paths.mjs"

BACKUP_PLIST="/Library/LaunchDaemons/com.xhsai.backup.plist"
WATCH_PLIST="/Library/LaunchDaemons/com.xhsai.health-watch.plist"
BACKUP_NODE="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CONTENT_AGENT_NODE_BIN' "$BACKUP_PLIST")"
BACKUP_HELPER="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CONTENT_AGENT_BACKUP_HELPER' "$BACKUP_PLIST")"
BACKUP_DIR="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CONTENT_AGENT_BACKUP_DIR' "$BACKUP_PLIST")"
WATCH_NODE="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CONTENT_AGENT_NODE_BIN' "$WATCH_PLIST")"
[ "$BACKUP_NODE" = "$NODE_BIN" ] || { echo "备份服务未使用 API 同源 Node 24" >&2; exit 1; }
[ "$WATCH_NODE" = "$NODE_BIN" ] || { echo "看门狗未使用 API 同源 Node 24" >&2; exit 1; }
[ "$BACKUP_HELPER" = "$SUPPORT_DIR/bin/prepare-backup.mjs" ] || { echo "备份 helper 路径错误" >&2; exit 1; }

for label in com.xhsai.backup com.xhsai.health-watch; do
  LAST_EXIT="$(launchctl print "system/$label" | awk -F'= ' '/last exit code =/{gsub(/[[:space:]]/, "", $2); print $2; exit}')"
  [ -z "$LAST_EXIT" ] || [ "$LAST_EXIT" = "0" ] || {
    echo "$label 最近一次运行失败，exit=$LAST_EXIT" >&2
    exit 1
  }
done

BACKUP_INSPECTION="$("$NODE_BIN" "$SUPPORT_DIR/bin/backup-manifest.mjs" --inspect-lines "$BACKUP_DIR")"
{
  IFS= read -r BACKUP_POLICY
  IFS= read -r BACKUP_STAMP
  IFS= read -r LATEST_BACKUP
  IFS= read -r FILES_BACKUP
  IFS= read -r MANIFEST_BACKUP
  IFS= read -r UNCOMMITTED_COUNT
} <<EOF
$BACKUP_INSPECTION
EOF
[ "$LATEST_BACKUP" != "-" ] || { echo "没有可恢复的自动数据库备份" >&2; exit 1; }
[ "$UNCOMMITTED_COUNT" = "0" ] || { echo "存在无 complete manifest 的未提交归档" >&2; exit 1; }
gzip -t "$LATEST_BACKUP"
tar -tzf "$FILES_BACKUP" >/dev/null
tar -xOf "$FILES_BACKUP" .env >/dev/null
BACKUP_MODE="$(stat -f '%Lp' "$LATEST_BACKUP" 2>/dev/null || stat -c '%a' "$LATEST_BACKUP")"
FILES_MODE="$(stat -f '%Lp' "$FILES_BACKUP" 2>/dev/null || stat -c '%a' "$FILES_BACKUP")"
[ "$BACKUP_MODE" = "600" ] || { echo "数据库备份权限不是 600: $BACKUP_MODE" >&2; exit 1; }
[ "$FILES_MODE" = "600" ] || { echo "文件备份权限不是 600: $FILES_MODE" >&2; exit 1; }
if [ "$BACKUP_POLICY" = "manifest" ]; then
  MANIFEST_MODE="$(stat -f '%Lp' "$MANIFEST_BACKUP" 2>/dev/null || stat -c '%a' "$MANIFEST_BACKUP")"
  [ "$MANIFEST_MODE" = "600" ] || { echo "备份 manifest 权限不是 600: $MANIFEST_MODE" >&2; exit 1; }
fi

if [ "${SKIP_BACKUP_AGE:-0}" != "1" ]; then
  NOW="$(date +%s)"
  MODIFIED="$(stat -f '%m' "$LATEST_BACKUP" 2>/dev/null || stat -c '%Y' "$LATEST_BACKUP")"
  [ $((NOW - MODIFIED)) -le 172800 ] || { echo "最近自动备份超过 48 小时" >&2; exit 1; }
fi

echo "LaunchDaemon 校验通过：三个服务均在 system 域，API 使用 Node 24 且数据库可写"

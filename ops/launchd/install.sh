#!/bin/bash
# 将 API、每日备份和看门狗安装为系统级 LaunchDaemon。
# 请以普通用户执行；脚本先把安装资产移出 Desktop，再通过 sudo 进入特权阶段。
set -Eeuo pipefail
umask 077

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
ONESHOT_TIMEOUT_SECONDS="${CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS:-3600}"
case "$ONESHOT_TIMEOUT_SECONDS" in
  ''|*[!0-9]*) echo "CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS 必须是正整数" >&2; exit 1 ;;
esac
[ "$ONESHOT_TIMEOUT_SECONDS" -gt 0 ] || {
  echo "CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS 必须大于 0" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  REPO="${CONTENT_AGENT_ROOT:-$(cd "$SOURCE_DIR/../.." && pwd)}"
  TARGET_USER="${TARGET_USER:-$(id -un)}"
  TARGET_HOME="${TARGET_HOME:-$HOME}"
  NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
  STAGED_DIR="$TARGET_HOME/Library/Application Support/xhsai/launchd-installer"
  [ -x "$NODE_BIN" ] || { echo "未找到 Node 24，请先执行 nvm install 24" >&2; exit 1; }
  install -d -m 700 "$STAGED_DIR"
  "$NODE_BIN" -e '
const { chmodSync, copyFileSync } = require("node:fs");
const { join } = require("node:path");
const [source, target] = process.argv.slice(1);
for (const name of [
  "install.sh",
  "com.xhsai.api.plist.template",
  "com.xhsai.backup.plist.template",
  "com.xhsai.health-watch.plist.template",
]) {
  copyFileSync(join(source, name), join(target, name));
  chmodSync(join(target, name), name === "install.sh" ? 0o700 : 0o600);
}
' "$SOURCE_DIR" "$STAGED_DIR"
  if [ "${CONTENT_AGENT_INSTALL_STAGE_ONLY:-0}" = "1" ]; then
    echo "安装资产已暂存到 $STAGED_DIR"
    exit 0
  fi
  cd "$STAGED_DIR"
  exec sudo /usr/bin/env TARGET_USER="$TARGET_USER" TARGET_HOME="$TARGET_HOME" \
    CONTENT_AGENT_ROOT="$REPO" NODE_BIN="$NODE_BIN" \
    CONTENT_AGENT_LAUNCHD_ONESHOT_TIMEOUT_SECONDS="$ONESHOT_TIMEOUT_SECONDS" \
    /bin/bash "$STAGED_DIR/install.sh"
fi

SCRIPT_DIR="$SOURCE_DIR"
REPO="${CONTENT_AGENT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$SCRIPT_DIR"
TARGET_USER="${TARGET_USER:-${SUDO_USER:-}}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  echo "必须通过 TARGET_USER 指定运行服务的普通用户" >&2
  exit 1
fi
TARGET_HOME="${TARGET_HOME:-$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory | awk '{print $2}')}"
case "$SCRIPT_DIR" in
  "$TARGET_HOME"/Desktop/*)
    echo "拒绝从 Desktop 直接执行特权阶段；请退出 sudo 后以普通用户运行安装器" >&2
    exit 1
    ;;
esac
TARGET_GROUP="${TARGET_GROUP:-$(id -gn "$TARGET_USER")}"
TARGET_UID="$(id -u "$TARGET_USER")"
SUPPORT_DIR="$TARGET_HOME/Library/Application Support/xhsai"
BIN_DIR="$SUPPORT_DIR/bin"
OPS_ENV="$SUPPORT_DIR/ops.env"
LOG_DIR="$TARGET_HOME/Library/Logs/xhsai"
ROLLBACK_ROOT="$SUPPORT_DIR/launchd-backups"
ROLLBACK_DIR=""
STAGE="$(mktemp -d)"
LABELS=(com.xhsai.api com.xhsai.backup com.xhsai.health-watch)
LEGACY_LABELS=(com.content-agent.backup com.content-agent.health-watch)

if [ -n "${NODE_BIN:-}" ]; then
  NODE_BIN="$NODE_BIN"
else
  NODE_CANDIDATES=("$TARGET_HOME"/.nvm/versions/node/v24.*/bin/node)
  NODE_BIN="${NODE_CANDIDATES[${#NODE_CANDIDATES[@]}-1]}"
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "未找到 Node 24，请先执行 nvm install 24" >&2
  exit 1
fi
NODE_VERSION="$("$NODE_BIN" --version)"
case "$NODE_VERSION" in
  v24.*) ;;
  *) echo "LaunchDaemon 只允许 Node 24，当前为 $NODE_VERSION" >&2; exit 1 ;;
esac
NODE_DIR="$(dirname "$NODE_BIN")"

# 管理员授权 helper 没有桌面目录的 TCC 权限；所有仓库读取都切回登录用户
# bootstrap 上下文。LaunchDaemon 本身也使用同一个普通用户。
run_as_user() {
  /bin/launchctl asuser "$TARGET_UID" /usr/bin/sudo -u "$TARGET_USER" \
    /usr/bin/env HOME="$TARGET_HOME" "$@"
}

gui_job_status() {
  local label="$1" output_file="$2" status
  if run_as_user /bin/launchctl print "gui/$TARGET_UID/$label" > "$output_file" 2>&1; then
    return 0
  else
    status=$?
  fi
  if [ "$status" = "113" ]; then
    return 1
  fi
  echo "无法确认 gui/$TARGET_UID/$label 状态，launchctl exit=$status" >&2
  return 2
}

# BEGIN launchd lifecycle helpers
initialize_rollback_state() {
  ROLLBACK_DIR="$(mktemp -d "$ROLLBACK_ROOT/launchd.XXXXXX")"
  BIN_BACKUP_DIR="$ROLLBACK_DIR/bin-backups"
  LEGACY_BACKUP_DIR="$ROLLBACK_DIR/legacy-launchagents"
  chmod 700 "$ROLLBACK_DIR"
  chown "$TARGET_USER:$TARGET_GROUP" "$ROLLBACK_DIR"
  mkdir -p "$BIN_BACKUP_DIR" "$LEGACY_BACKUP_DIR"
  chmod 700 "$BIN_BACKUP_DIR" "$LEGACY_BACKUP_DIR"
  : > "$ROLLBACK_DIR/loaded-labels.txt"
  : > "$ROLLBACK_DIR/loaded-legacy-labels.txt"
  chown -R "$TARGET_USER:$TARGET_GROUP" "$ROLLBACK_DIR"
}

job_pid_from_file() {
  local file="$1"
  awk -F'= ' '/^[[:space:]]*pid = / {
    gsub(/[[:space:]]/, "", $2)
    print $2
    exit
  }' "$file"
}

process_start_id() {
  local pid="$1"
  ps -o lstart= -p "$pid" 2>/dev/null | awk '{$1=$1; print}'
}

process_matches_start_id() {
  local pid="$1" expected="$2" current
  [ -n "$pid" ] && [ -n "$expected" ] || return 1
  current="$(process_start_id "$pid")"
  [ -n "$current" ] && [ "$current" = "$expected" ]
}

capture_job_start_id() {
  local state_file="$1" start_file="$2" pid start_id
  : > "$start_file"
  pid="$(job_pid_from_file "$state_file")"
  [ -n "$pid" ] || return 0
  case "$pid" in *[!0-9]*|0) return 1 ;; esac
  start_id="$(process_start_id "$pid")"
  [ -n "$start_id" ] || return 1
  printf '%s\n' "$start_id" > "$start_file"
}

wait_for_original_pid_exit() {
  local pid="$1" start_id="$2" max_checks="$3" context="$4" checked=0
  while [ "$checked" -lt "$max_checks" ]; do
    if ! process_matches_start_id "$pid" "$start_id"; then
      return 0
    fi
    sleep 0.2
    checked=$((checked + 1))
  done
  echo "$context 原 PID ${pid} 未按时退出" >&2
  return 1
}

legacy_label_was_loaded() {
  local expected="$1"
  awk -v expected="$expected" '
    $0 == expected { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$ROLLBACK_DIR/loaded-legacy-labels.txt"
}

restore_loaded_legacy_jobs() {
  local label legacy_plist restore_failed=0
  for label in "${LEGACY_LABELS[@]}"; do
    legacy_label_was_loaded "$label" || continue
    legacy_plist="$TARGET_HOME/Library/LaunchAgents/$label.plist"
    if [ ! -f "$legacy_plist" ]; then
      restore_failed=1
      continue
    fi
    if run_as_user /bin/launchctl bootstrap "gui/$TARGET_UID" "$legacy_plist" \
      >> "$ROLLBACK_DIR/$label.gui-rollback-bootstrap.txt" 2>&1; then
      run_as_user /bin/launchctl print "gui/$TARGET_UID/$label" \
        >> "$ROLLBACK_DIR/$label.gui-rollback-after.txt" 2>&1 \
        || restore_failed=1
    else
      restore_failed=1
    fi
  done
  [ "$restore_failed" = "0" ]
}
# END launchd lifecycle helpers

system_job_status() {
  local label="$1" output_file="$2" status
  if launchctl print "system/$label" > "$output_file" 2>&1; then
    return 0
  else
    status=$?
  fi
  [ "$status" = "113" ] && return 1
  echo "无法确认 system/$label 状态，launchctl exit=$status" >&2
  return 2
}

run_as_user /bin/test -f "$REPO/.env" || { echo "缺少生产环境文件 $REPO/.env" >&2; exit 1; }
run_as_user /bin/test -f "$REPO/apps/api/dist/main.js" || { echo "缺少 API 构建产物，请先 npm run build" >&2; exit 1; }
run_as_user "$NODE_BIN" --env-file="$REPO/.env" -e 'if (process.env.NODE_ENV !== "production") process.exit(2)' \
  || { echo ".env 必须显式设置 NODE_ENV=production" >&2; exit 1; }

install -d -m 700 -o "$TARGET_USER" -g "$TARGET_GROUP" "$SUPPORT_DIR" "$BIN_DIR" "$LOG_DIR" "$ROLLBACK_ROOT"
initialize_rollback_state
if [ ! -e "$OPS_ENV" ]; then
  install -m 600 -o "$TARGET_USER" -g "$TARGET_GROUP" /dev/null "$OPS_ENV"
fi
[ ! -L "$OPS_ENV" ] || { echo "拒绝使用符号链接 OPS_ENV_FILE" >&2; exit 1; }
chown "$TARGET_USER:$TARGET_GROUP" "$OPS_ENV"
chmod 600 "$OPS_ENV"

python3 - "$SCRIPT_DIR" "$STAGE" "$TARGET_USER" "$TARGET_GROUP" "$TARGET_HOME" \
  "$REPO" "$NODE_BIN" "$NODE_DIR" "$BIN_DIR" "$OPS_ENV" "$LOG_DIR" "$SUPPORT_DIR" <<'PY'
from pathlib import Path
from xml.sax.saxutils import escape
import sys

template_dir, output_dir, user, group, home, repo, node, node_dir, bin_dir, ops_env, log_dir, support_dir = sys.argv[1:]
replacements = {
    "__USER__": user,
    "__GROUP__": group,
    "__HOME__": home,
    "__REPO__": repo,
    "__NODE_BIN__": node,
    "__NODE_DIR__": node_dir,
    "__BIN_DIR__": bin_dir,
    "__OPS_ENV__": ops_env,
    "__LOG_DIR__": log_dir,
    "__SUPPORT_DIR__": support_dir,
}
for template in Path(template_dir).glob("*.plist.template"):
    text = template.read_text(encoding="utf-8")
    for token, value in replacements.items():
        text = text.replace(token, escape(value))
    target = Path(output_dir, template.name.removesuffix(".template"))
    target.write_text(text, encoding="utf-8")
PY

for plist in "$STAGE"/*.plist; do
  plutil -lint "$plist"
done

for filename in backup-production.sh health-watch.sh prepare-backup.mjs backup-manifest.mjs storage-paths.mjs; do
  if [ -f "$BIN_DIR/$filename" ]; then
    cp -p "$BIN_DIR/$filename" "$BIN_BACKUP_DIR/$filename"
  fi
done
for label in "${LABELS[@]}"; do
  target="/Library/LaunchDaemons/$label.plist"
  if [ -f "$target" ]; then
    cp -p "$target" "$ROLLBACK_DIR/$label.plist"
  fi
  : > "$ROLLBACK_DIR/$label.before.start-id"
  if launchctl print "system/$label" > "$ROLLBACK_DIR/$label.before.txt" 2>&1; then
    capture_job_start_id "$ROLLBACK_DIR/$label.before.txt" \
      "$ROLLBACK_DIR/$label.before.start-id"
    echo "$label" >> "$ROLLBACK_DIR/loaded-labels.txt"
  fi
done
for label in "${LEGACY_LABELS[@]}"; do
  legacy_plist="$TARGET_HOME/Library/LaunchAgents/$label.plist"
  if [ -f "$legacy_plist" ]; then
    cp -p "$legacy_plist" "$LEGACY_BACKUP_DIR/$label.plist"
  fi
  : > "$ROLLBACK_DIR/$label.gui-before.start-id"
  if gui_job_status "$label" "$ROLLBACK_DIR/$label.gui-before.txt"; then
    capture_job_start_id "$ROLLBACK_DIR/$label.gui-before.txt" \
      "$ROLLBACK_DIR/$label.gui-before.start-id"
    echo "$label" >> "$ROLLBACK_DIR/loaded-legacy-labels.txt"
  else
    gui_status=$?
    [ "$gui_status" = "1" ] || exit "$gui_status"
  fi
done
chown -R "$TARGET_USER:$TARGET_GROUP" "$ROLLBACK_DIR"

# BEGIN launchd bootout helpers
api_port_is_clear() {
  local api_pids=()
  api_pids=($(lsof -tiTCP:8780 -sTCP:LISTEN 2>/dev/null || true))
  [ "${#api_pids[@]}" -eq 0 ]
}

wait_for_unloaded() {
  local label="$1" old_pid="${2:-}" old_start="${3:-}" status api_pids=()
  for _ in $(seq 1 50); do
    if system_job_status "$label" "$ROLLBACK_DIR/$label.system-wait.txt"; then
      :
    else
      status=$?
      if [ "$status" = "1" ] \
        && wait_for_original_pid_exit "$old_pid" "$old_start" 1 "system/$label" 2>/dev/null; then
        if [ "$label" = "com.xhsai.api" ]; then
          api_port_is_clear && return 0
        else
          return 0
        fi
      elif [ "$status" != "1" ]; then
        return "$status"
      fi
    fi
    sleep 0.2
  done
  echo "等待 system/$label 卸载及原 PID 退出超时" >&2
  return 1
}

wait_for_gui_unloaded() {
  local label="$1" old_pid="${2:-}" old_start="${3:-}" status
  for _ in $(seq 1 50); do
    if gui_job_status "$label" "$ROLLBACK_DIR/$label.gui-wait.txt"; then
      :
    else
      status=$?
      if [ "$status" = "1" ] \
        && wait_for_original_pid_exit "$old_pid" "$old_start" 1 "gui/$TARGET_UID/$label" 2>/dev/null; then
        return 0
      elif [ "$status" != "1" ]; then
        return "$status"
      fi
    fi
    sleep 0.2
  done
  echo "等待 gui/$TARGET_UID/$label 卸载及原 PID 退出超时" >&2
  return 1
}

bootout_system_job() {
  local label="$1" evidence_prefix="$2" snapshot_file="${3:-}" snapshot_start_file="${4:-}"
  local state_file="$evidence_prefix.before-bootout.txt"
  local status pid="" start_id="" snapshot_pid="" snapshot_start="" wait_pid="" wait_start=""
  local loaded=0 bootout_status=0
  if [ -n "$snapshot_file" ] && [ -f "$snapshot_file" ]; then
    snapshot_pid="$(job_pid_from_file "$snapshot_file")"
    if [ -n "$snapshot_pid" ]; then
      case "$snapshot_pid" in *[!0-9]*|0) return 1 ;; esac
      [ -n "$snapshot_start_file" ] && [ -f "$snapshot_start_file" ] \
        && snapshot_start="$(cat "$snapshot_start_file")"
      [ -n "$snapshot_start" ] || return 1
    fi
  fi
  : > "$state_file"
  if system_job_status "$label" "$state_file"; then
    loaded=1
    pid="$(job_pid_from_file "$state_file")"
    if [ -n "$pid" ]; then
      case "$pid" in *[!0-9]*|0) return 1 ;; esac
      start_id="$(process_start_id "$pid")"
      [ -n "$start_id" ] || return 1
    fi
  else
    status=$?
    [ "$status" = "1" ] || return "$status"
  fi
  if [ "$loaded" = "1" ]; then
    launchctl bootout "system/$label" > "$evidence_prefix.bootout.txt" 2>&1 \
      || bootout_status=$?
  fi
  wait_pid="$pid"
  wait_start="$start_id"
  if [ -z "$wait_pid" ]; then
    wait_pid="$snapshot_pid"
    wait_start="$snapshot_start"
  fi
  wait_for_unloaded "$label" "$wait_pid" "$wait_start" || return 1
  if [ -n "$snapshot_pid" ] \
    && { [ "$snapshot_pid" != "$wait_pid" ] || [ "$snapshot_start" != "$wait_start" ]; }; then
    wait_for_original_pid_exit "$snapshot_pid" "$snapshot_start" 50 "system/$label" || return 1
  fi
  if [ "$bootout_status" != "0" ]; then
    echo "system/$label bootout 返回 ${bootout_status}，但已确认卸载"
  fi
  return 0
}

bootout_gui_job() {
  local label="$1" evidence_prefix="$2" snapshot_file="${3:-}" snapshot_start_file="${4:-}"
  local state_file="$evidence_prefix.before-bootout.txt"
  local status pid="" start_id="" snapshot_pid="" snapshot_start="" wait_pid="" wait_start=""
  local loaded=0 bootout_status=0
  if [ -n "$snapshot_file" ] && [ -f "$snapshot_file" ]; then
    snapshot_pid="$(job_pid_from_file "$snapshot_file")"
    if [ -n "$snapshot_pid" ]; then
      case "$snapshot_pid" in *[!0-9]*|0) return 1 ;; esac
      [ -n "$snapshot_start_file" ] && [ -f "$snapshot_start_file" ] \
        && snapshot_start="$(cat "$snapshot_start_file")"
      [ -n "$snapshot_start" ] || return 1
    fi
  fi
  : > "$state_file"
  if gui_job_status "$label" "$state_file"; then
    loaded=1
    pid="$(job_pid_from_file "$state_file")"
    if [ -n "$pid" ]; then
      case "$pid" in *[!0-9]*|0) return 1 ;; esac
      start_id="$(process_start_id "$pid")"
      [ -n "$start_id" ] || return 1
    fi
  else
    status=$?
    [ "$status" = "1" ] || return "$status"
  fi
  if [ "$loaded" = "1" ]; then
    run_as_user /bin/launchctl bootout "gui/$TARGET_UID/$label" \
      > "$evidence_prefix.bootout.txt" 2>&1 || bootout_status=$?
  fi
  wait_pid="$pid"
  wait_start="$start_id"
  if [ -z "$wait_pid" ]; then
    wait_pid="$snapshot_pid"
    wait_start="$snapshot_start"
  fi
  wait_for_gui_unloaded "$label" "$wait_pid" "$wait_start" || return 1
  if [ -n "$snapshot_pid" ] \
    && { [ "$snapshot_pid" != "$wait_pid" ] || [ "$snapshot_start" != "$wait_start" ]; }; then
    wait_for_original_pid_exit "$snapshot_pid" "$snapshot_start" 50 \
      "gui/$TARGET_UID/$label" || return 1
  fi
  if [ "$bootout_status" != "0" ]; then
    echo "gui/$TARGET_UID/$label bootout 返回 ${bootout_status}，但已确认卸载"
  fi
  return 0
}
# END launchd bootout helpers

verify_rollback_health() {
  local body
  for _ in $(seq 1 45); do
    body="$(curl -fsS --max-time 3 http://127.0.0.1:8780/health 2>/dev/null || true)"
    if printf '%s' "$body" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if data.get("status") == "ok" and data.get("databaseWritable") is True else 1)
'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  previous_status=$?
  code="${1:-$previous_status}"
  trap - ERR HUP INT TERM
  set +e
  rollback_failed=0
  old_api_was_loaded=0
  echo "安装失败，恢复 $ROLLBACK_DIR" >&2
  for label in "${LABELS[@]}"; do
    bootout_system_job "$label" "$ROLLBACK_DIR/$label.system-rollback" \
      "$ROLLBACK_DIR/$label.installed.txt" "$ROLLBACK_DIR/$label.installed.start-id" \
      || rollback_failed=1
    rm -f "/Library/LaunchDaemons/$label.plist" || rollback_failed=1
    if [ -f "$ROLLBACK_DIR/$label.plist" ]; then
      install -m 644 -o root -g wheel \
        "$ROLLBACK_DIR/$label.plist" "/Library/LaunchDaemons/$label.plist" \
        || rollback_failed=1
    fi
  done
  for filename in backup-production.sh health-watch.sh prepare-backup.mjs backup-manifest.mjs storage-paths.mjs; do
    if [ -f "$BIN_BACKUP_DIR/$filename" ]; then
      cp -p "$BIN_BACKUP_DIR/$filename" "$BIN_DIR/$filename" || rollback_failed=1
    else
      rm -f "$BIN_DIR/$filename" || rollback_failed=1
    fi
  done
  for label in "${LEGACY_LABELS[@]}"; do
    legacy_plist="$TARGET_HOME/Library/LaunchAgents/$label.plist"
    bootout_gui_job "$label" "$ROLLBACK_DIR/$label.gui-rollback" \
      "$ROLLBACK_DIR/$label.gui-before.txt" "$ROLLBACK_DIR/$label.gui-before.start-id" \
      || rollback_failed=1
    if [ -f "$LEGACY_BACKUP_DIR/$label.plist" ]; then
      if [ ! -d "$TARGET_HOME/Library/LaunchAgents" ]; then
        install -d -m 700 -o "$TARGET_USER" -g "$TARGET_GROUP" \
          "$TARGET_HOME/Library/LaunchAgents" || rollback_failed=1
      fi
      cp -p "$LEGACY_BACKUP_DIR/$label.plist" "$legacy_plist" \
        || rollback_failed=1
      chown "$TARGET_USER:$TARGET_GROUP" "$legacy_plist" \
        || rollback_failed=1
    else
      rm -f "$legacy_plist" || rollback_failed=1
    fi
  done
  restore_loaded_legacy_jobs || rollback_failed=1
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    [ "$label" != "com.xhsai.api" ] || old_api_was_loaded=1
    if [ "$label" = "com.xhsai.api" ] && ! api_port_is_clear; then
      echo "8780 仍被旧或未知进程监听，拒绝 bootstrap 旧 API" >&2
      rollback_failed=1
      continue
    fi
    launchctl bootstrap system "/Library/LaunchDaemons/$label.plist" >/dev/null 2>&1 \
      || rollback_failed=1
  done < "$ROLLBACK_DIR/loaded-labels.txt"
  if [ "$old_api_was_loaded" = "1" ]; then
    launchctl print system/com.xhsai.api >/dev/null 2>&1 || rollback_failed=1
    verify_rollback_health || rollback_failed=1
  fi
  rm -rf "$STAGE" || rollback_failed=1
  if [ "$rollback_failed" != "0" ]; then
    echo "安装失败且回滚不完整；保留证据：$ROLLBACK_DIR" >&2
    exit 70
  fi
  echo "安装失败；旧 LaunchDaemon 与运维脚本已恢复，证据保存在 $ROLLBACK_DIR" >&2
  exit "$code"
}
trap rollback ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM

run_as_user "$NODE_BIN" -e '
const { chmodSync, copyFileSync } = require("node:fs");
const [
  backupSource,
  watchSource,
  helperSource,
  manifestSource,
  storagePathsSource,
  backupTarget,
  watchTarget,
  helperTarget,
  manifestTarget,
  storagePathsTarget,
] = process.argv.slice(1);
copyFileSync(backupSource, backupTarget);
copyFileSync(watchSource, watchTarget);
copyFileSync(helperSource, helperTarget);
copyFileSync(manifestSource, manifestTarget);
copyFileSync(storagePathsSource, storagePathsTarget);
chmodSync(backupTarget, 0o700);
chmodSync(watchTarget, 0o700);
chmodSync(helperTarget, 0o700);
chmodSync(manifestTarget, 0o700);
chmodSync(storagePathsTarget, 0o700);
' "$REPO/scripts/backup-production.sh" "$REPO/scripts/health-watch.sh" \
  "$REPO/scripts/prepare-backup.mjs" "$REPO/scripts/backup-manifest.mjs" \
  "$REPO/scripts/storage-paths.mjs" \
  "$BIN_DIR/backup-production.sh" "$BIN_DIR/health-watch.sh" \
  "$BIN_DIR/prepare-backup.mjs" "$BIN_DIR/backup-manifest.mjs" \
  "$BIN_DIR/storage-paths.mjs"

for label in "${LABELS[@]}"; do
  bootout_system_job "$label" "$ROLLBACK_DIR/$label.system-install" \
    "$ROLLBACK_DIR/$label.before.txt" "$ROLLBACK_DIR/$label.before.start-id"
  if [ "$label" = "com.xhsai.api" ]; then
    api_port_is_clear || {
      echo "8780 仍被旧或未知进程监听，拒绝 bootstrap 新 API" >&2
      false
    }
  fi
  install -m 644 -o root -g wheel "$STAGE/$label.plist" "/Library/LaunchDaemons/$label.plist"
  launchctl bootstrap system "/Library/LaunchDaemons/$label.plist"
  launchctl print "system/$label" > "$ROLLBACK_DIR/$label.installed.txt" 2>&1
  capture_job_start_id "$ROLLBACK_DIR/$label.installed.txt" \
    "$ROLLBACK_DIR/$label.installed.start-id"
done

verify_health() {
  local body
  for _ in $(seq 1 45); do
    body="$(curl -fsS --max-time 3 http://127.0.0.1:8780/health 2>/dev/null || true)"
    if printf '%s' "$body" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if data.get("status") == "ok" and data.get("databaseWritable") is True else 1)
'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_successful_oneshot() {
  local label="$1" output active runs last_exit waited=0
  while [ "$waited" -lt "$ONESHOT_TIMEOUT_SECONDS" ]; do
    output="$(launchctl print "system/$label" 2>/dev/null || true)"
    active="$(printf '%s\n' "$output" | awk -F'= ' '/active count =/{gsub(/[[:space:]]/, "", $2); print $2; exit}')"
    runs="$(printf '%s\n' "$output" | awk -F'= ' '/runs =/{gsub(/[[:space:]]/, "", $2); print $2; exit}')"
    last_exit="$(printf '%s\n' "$output" | awk -F'= ' '/last exit code =/{gsub(/[[:space:]]/, "", $2); print $2; exit}')"
    case "$runs" in ''|*[!0-9]*) runs=0 ;; esac
    if [ "$runs" -gt 0 ] && [ "${active:-1}" = "0" ]; then
      if [ "$last_exit" = "0" ]; then
        return 0
      fi
      echo "system/$label 首次运行失败，exit=${last_exit:-未知}" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "等待 system/$label 首次成功运行超时" >&2
  return 1
}

verify_latest_backup() {
  local backup_dir="$SUPPORT_DIR/backups/auto" inspection mode stamp latest files manifest uncommitted
  local db_mode files_mode manifest_mode
  inspection="$("$NODE_BIN" "$BIN_DIR/backup-manifest.mjs" --inspect-lines "$backup_dir")"
  {
    IFS= read -r mode
    IFS= read -r stamp
    IFS= read -r latest
    IFS= read -r files
    IFS= read -r manifest
    IFS= read -r uncommitted
  } <<EOF
$inspection
EOF
  [ "$mode" = "manifest" ] || { echo "新备份没有完成 manifest" >&2; return 1; }
  [ "$uncommitted" = "0" ] || { echo "新备份目录存在未提交归档" >&2; return 1; }
  gzip -t "$latest"
  tar -tzf "$files" >/dev/null
  tar -xOf "$files" .env >/dev/null
  db_mode="$(stat -f '%Lp' "$latest" 2>/dev/null || stat -c '%a' "$latest")"
  files_mode="$(stat -f '%Lp' "$files" 2>/dev/null || stat -c '%a' "$files")"
  manifest_mode="$(stat -f '%Lp' "$manifest" 2>/dev/null || stat -c '%a' "$manifest")"
  [ "$db_mode" = "600" ] && [ "$files_mode" = "600" ] && [ "$manifest_mode" = "600" ]
}

cleanup_legacy_launch_agents() {
  local label legacy_plist
  for label in "${LEGACY_LABELS[@]}"; do
    legacy_plist="$TARGET_HOME/Library/LaunchAgents/$label.plist"
    bootout_gui_job "$label" "$ROLLBACK_DIR/$label.gui-cleanup" \
      "$ROLLBACK_DIR/$label.gui-before.txt" "$ROLLBACK_DIR/$label.gui-before.start-id"
    rm -f "$legacy_plist"
    [ ! -e "$legacy_plist" ] || {
      echo "历史 LaunchAgent plist 删除失败：$legacy_plist" >&2
      return 1
    }
  done
}

verify_health
for label in "${LABELS[@]}"; do
  launchctl print "system/$label" >/dev/null
done
wait_for_successful_oneshot com.xhsai.backup
wait_for_successful_oneshot com.xhsai.health-watch
verify_latest_backup

# 新 Daemon 全部健康、一次性任务真实成功且备份对可恢复后，才移除历史任务和 plist。
cleanup_legacy_launch_agents

trap - ERR HUP INT TERM
rm -rf "$STAGE"
echo "LaunchDaemon 安装完成：Node ${NODE_VERSION}；回滚证据保存在 $ROLLBACK_DIR"

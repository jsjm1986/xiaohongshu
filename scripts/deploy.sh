#!/bin/bash
# 生产部署门禁：仅允许干净的 main，锁文件安装、全量验证、备份后才重启。
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${CONTENT_AGENT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PORT="${PORT:-8780}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
LAUNCHD_BIN="$HOME/Library/Application Support/xhsai/bin"
API_PLIST="${CONTENT_AGENT_API_PLIST:-/Library/LaunchDaemons/com.xhsai.api.plist}"
HEALTH_WAIT_SECONDS="${CONTENT_AGENT_DEPLOY_HEALTH_WAIT_SECONDS:-90}"
POLL_INTERVAL_SECONDS="${CONTENT_AGENT_DEPLOY_POLL_INTERVAL_SECONDS:-2}"
ROLLBACK_DIR=""
BUILD_DIR=""
OPS_SCRIPTS_TOUCHED=0
SERVICE_STATE_CAPTURED=0
SERVICE_TOUCHED=0
ROLLBACK_ACTIVE=0
ROLLBACK_ORIGINAL_CODE=70
OLD_API_PID=""
OLD_API_START_ID=""

unset NODE_ENV
cd "$REPO_DIR"

case "$HEALTH_WAIT_SECONDS" in
  ''|*[!0-9]*) echo "CONTENT_AGENT_DEPLOY_HEALTH_WAIT_SECONDS 必须是正整数" >&2; exit 1 ;;
esac
case "$POLL_INTERVAL_SECONDS" in
  ''|*[!0-9]*) echo "CONTENT_AGENT_DEPLOY_POLL_INTERVAL_SECONDS 必须是正整数" >&2; exit 1 ;;
esac
[ "$HEALTH_WAIT_SECONDS" -gt 0 ] \
  || { echo "CONTENT_AGENT_DEPLOY_HEALTH_WAIT_SECONDS 必须大于 0" >&2; exit 1; }
[ "$POLL_INTERVAL_SECONDS" -gt 0 ] \
  || { echo "CONTENT_AGENT_DEPLOY_POLL_INTERVAL_SECONDS 必须大于 0" >&2; exit 1; }

OPS_ENV_FILE="${OPS_ENV_FILE:-$HOME/Library/Application Support/xhsai/ops.env}"
if [ -e "$OPS_ENV_FILE" ]; then
  # GNU stat -c 必须在前：GNU -f 是 --file-system，会成功并倒出文件系统信息。
  OPS_MODE="$(stat -c '%a' "$OPS_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$OPS_ENV_FILE" 2>/dev/null || true)"
  [ "$OPS_MODE" = "600" ] || { echo "拒绝部署：ops.env 权限必须是 600" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$OPS_ENV_FILE"
  set +a
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "拒绝部署：当前分支是 $CURRENT_BRANCH，只允许 main" >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "拒绝部署：工作树有未提交或未跟踪文件" >&2
  exit 1
fi

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
  nvm use --silent 24
fi
case "$(node --version)" in
  v24.*) ;;
  *) echo "拒绝部署：必须使用 Node 24，当前为 $(node --version)" >&2; exit 1 ;;
esac

echo "==> [1/11] 同步 origin/main"
git fetch origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
if [ "$LOCAL" != "$REMOTE" ]; then
  if git merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
    git merge --ff-only "$REMOTE"
  else
    echo "拒绝部署：本地 main 超前或已分叉，请先正常合并并推送" >&2
    exit 1
  fi
fi
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || { echo "拒绝部署：HEAD 必须与 origin/main 完全一致" >&2; exit 1; }

require_origin_ci_success() {
  local origin sha owner_repo owner repo payload auth_header=""
  origin="$(git remote get-url origin 2>/dev/null || true)"
  sha="$(git rev-parse HEAD)"
  owner_repo="$(printf '%s' "$origin" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
  owner="${owner_repo%%/*}"
  repo="${owner_repo#*/}"
  if [ -z "$owner" ] || [ -z "$repo" ] || [ "$owner" = "$owner_repo" ]; then
    echo "拒绝部署：无法从 origin 解析 GitHub 仓库: ${origin:-空}" >&2
    return 1
  fi
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth_header="Authorization: Bearer $GITHUB_TOKEN"
  fi
  payload="$(curl -fsS --max-time 20 \
    -H "Accept: application/vnd.github+json" \
    ${auth_header:+-H "$auth_header"} \
    "https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=20")" || {
    echo "拒绝部署：无法读取 GitHub Actions 状态" >&2
    return 1
  }
  printf '%s' "$payload" | python3 -c '
import json, sys
sha = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit("GitHub Actions 响应不是 JSON")
runs = data.get("workflow_runs") or []
ok = any(
    run.get("name") == "CI"
    and run.get("head_sha") == sha
    and run.get("status") == "completed"
    and run.get("conclusion") == "success"
    for run in runs
)
raise SystemExit(0 if ok else 1)
' "$sha" || {
    echo "拒绝部署：HEAD ${sha} 的 GitHub Actions CI 尚未成功完成" >&2
    return 1
  }
}

echo "==> [1.5/11] 确认 origin/main 的 GitHub Actions CI 已成功"
require_origin_ci_success

# npm ci 会替换生产依赖，构建也会覆盖 dist；两者必须作为一个可运行单元回滚。
# 回滚交换文件前先通过 launchd 停 API，再显式 bootstrap/kickstart 旧运行时。
# 源码不做破坏性 reset。
ROLLBACK_DIR="$(mktemp -d "$REPO_DIR/.deploy-rollback.XXXXXX")"
ALL_RUNTIME_PATHS=(
  apps/api/dist apps/web/dist packages/agent-core/dist packages/agent-harness-core/dist \
  node_modules apps/api/node_modules apps/web/node_modules
)
RUNTIME_PATHS=()
for path in "${ALL_RUNTIME_PATHS[@]}"; do
  [ -e "$path" ] && RUNTIME_PATHS+=("$path")
done
if [ "${#RUNTIME_PATHS[@]}" -gt 0 ]; then
  tar -czf "$ROLLBACK_DIR/runtime.tar.gz" "${RUNTIME_PATHS[@]}"
fi
OPS_BIN_BACKUP="$ROLLBACK_DIR/ops-bin"
mkdir -p "$OPS_BIN_BACKUP"
for filename in backup-production.sh health-watch.sh prepare-backup.mjs backup-manifest.mjs storage-paths.mjs; do
  if [ -f "$LAUNCHD_BIN/$filename" ]; then
    cp -p "$LAUNCHD_BIN/$filename" "$OPS_BIN_BACKUP/$filename"
  fi
done

restore_ops_scripts() {
  [ "$OPS_SCRIPTS_TOUCHED" = "1" ] || return 0
  for filename in backup-production.sh health-watch.sh prepare-backup.mjs backup-manifest.mjs storage-paths.mjs; do
    if [ -f "$OPS_BIN_BACKUP/$filename" ]; then
      cp -p "$OPS_BIN_BACKUP/$filename" "$LAUNCHD_BIN/$filename" || return 1
    else
      rm -f "$LAUNCHD_BIN/$filename" || return 1
    fi
  done
  for filename in backup-production.sh health-watch.sh prepare-backup.mjs backup-manifest.mjs storage-paths.mjs; do
    if [ -f "$OPS_BIN_BACKUP/$filename" ]; then
      cmp -s "$OPS_BIN_BACKUP/$filename" "$LAUNCHD_BIN/$filename" || return 1
    else
      [ ! -e "$LAUNCHD_BIN/$filename" ] || return 1
    fi
  done
}

restore_runtime() {
  local archive="$ROLLBACK_DIR/runtime.tar.gz"
  local restore_stage="$ROLLBACK_DIR/restore-stage"
  local failed_runtime="$ROLLBACK_DIR/failed-runtime"
  local path moved_path installed_path swap_failed=0
  [ -f "$archive" ] || return 1
  tar -tzf "$archive" >/dev/null || return 1
  rm -rf "$restore_stage" "$failed_runtime"
  mkdir -p "$restore_stage" "$failed_runtime"
  tar -xzf "$archive" -C "$restore_stage" || return 1

  MOVED_CURRENT_PATHS=()
  INSTALLED_OLD_PATHS=()
  for path in "${ALL_RUNTIME_PATHS[@]}"; do
    mkdir -p "$failed_runtime/$(dirname "$path")" "$(dirname "$path")" \
      || { swap_failed=1; break; }
    if [ -e "$path" ] || [ -L "$path" ]; then
      mv "$path" "$failed_runtime/$path" || { swap_failed=1; break; }
      MOVED_CURRENT_PATHS+=("$path")
    fi
    if [ -e "$restore_stage/$path" ] || [ -L "$restore_stage/$path" ]; then
      mv "$restore_stage/$path" "$path" || { swap_failed=1; break; }
      INSTALLED_OLD_PATHS+=("$path")
    fi
  done
  if [ "$swap_failed" = "0" ]; then
    for path in "${ALL_RUNTIME_PATHS[@]}"; do
      old_path_present=0
      for restored_path in "${RUNTIME_PATHS[@]}"; do
        if [ "$restored_path" = "$path" ]; then
          old_path_present=1
          break
        fi
      done
      if [ "$old_path_present" = "1" ]; then
        [ -e "$path" ] || [ -L "$path" ] || return 1
      else
        [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
      fi
    done
    return 0
  fi

  for installed_path in "${INSTALLED_OLD_PATHS[@]}"; do
    rm -rf "$installed_path"
  done
  for moved_path in "${MOVED_CURRENT_PATHS[@]}"; do
    if [ -e "$failed_runtime/$moved_path" ] || [ -L "$failed_runtime/$moved_path" ]; then
      mkdir -p "$(dirname "$moved_path")"
      mv "$failed_runtime/$moved_path" "$moved_path" || true
    fi
  done
  return 1
}

listener_pids() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

api_has_listener() {
  local pids=()
  pids=($(listener_pids))
  [ "${#pids[@]}" -gt 0 ]
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

job_pid_from_file() {
  local file="$1"
  awk -F'= ' '/^[[:space:]]*pid = / {
    gsub(/[[:space:]]/, "", $2)
    print $2
    exit
  }' "$file"
}

health_ready() {
  local body
  body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if value.get("status") == "ok" and value.get("databaseWritable") is True else 1)
'
}

wait_for_api_listener() {
  local context="${1:-API}" waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
    if api_has_listener; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done
  echo "$context 在 ${HEALTH_WAIT_SECONDS} 秒内没有监听 PID" >&2
  return 1
}

wait_for_original_pid_exit() {
  local old_pid="$1" old_start="$2" context="${3:-API}" waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
    if ! process_matches_start_id "$old_pid" "$old_start"; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done
  echo "$context 原 PID $old_pid 在 ${HEALTH_WAIT_SECONDS} 秒内未退出" >&2
  return 1
}

wait_for_replaced_api_listener() {
  local old_pid="$1" old_start="$2" context="${3:-API}"
  local require_health="${4:-1}" waited=0
  local state_file="$ROLLBACK_DIR/api-replacement.state"
  local pids=() job_pid job_start
  while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
    : > "$state_file"
    if launchctl print system/com.xhsai.api > "$state_file" 2>&1; then
      job_pid="$(job_pid_from_file "$state_file")"
      case "$job_pid" in ''|*[!0-9]*|0) job_pid='' ;; esac
      job_start=''
      if [ -n "$job_pid" ]; then
        job_start="$(process_start_id "$job_pid")"
      fi
      pids=($(listener_pids))
      if ! process_matches_start_id "$old_pid" "$old_start" \
        && [ -n "$job_start" ] && [ "${#pids[@]}" -eq 1 ] \
        && [ "${pids[0]}" = "$job_pid" ] \
        && process_matches_start_id "$job_pid" "$job_start"; then
        if [ "$require_health" != "1" ] || health_ready; then
          return 0
        fi
      fi
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done
  echo "$context 未完成进程换代：旧 PID/启动标识仍存活，或 8780 监听 PID 未绑定 launchd job PID 并通过结构化健康" >&2
  return 1
}

wait_for_structured_health() {
  local context="${1:-API}" waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
    if health_ready; then
      echo "$context 结构化健康已就绪"
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done
  echo "$context 结构化健康等待超时：需要 status=ok 且 databaseWritable=true" >&2
  return 1
}

prepare_isolated_build() {
  local rollback_base name entry
  BUILD_DIR="$ROLLBACK_DIR/build"
  mkdir -p "$BUILD_DIR"
  rollback_base="$(basename "$ROLLBACK_DIR")"
  for entry in "$REPO_DIR"/* "$REPO_DIR"/.[!.]* "$REPO_DIR"/..?*; do
    name="${entry##*/}"
    case "$name" in
      .|..|.git|data|node_modules|"$rollback_base") continue ;;
    esac
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    cp -a "$entry" "$BUILD_DIR/$name"
  done
  rm -rf \
    "$BUILD_DIR/apps/api/node_modules" \
    "$BUILD_DIR/apps/web/node_modules" \
    "$BUILD_DIR/apps/api/dist" \
    "$BUILD_DIR/apps/web/dist" \
    "$BUILD_DIR/packages/agent-core/dist" \
    "$BUILD_DIR/packages/agent-harness-core/dist"
  [ -f "$BUILD_DIR/package.json" ] || {
    echo "隔离构建目录缺少 package.json" >&2
    return 1
  }
}

run_in_build() {
  (cd "$BUILD_DIR" && "$@")
}

install_runtime_from_build() {
  local path
  for path in "${ALL_RUNTIME_PATHS[@]}"; do
    rm -rf "$REPO_DIR/$path"
    if [ -e "$BUILD_DIR/$path" ] || [ -L "$BUILD_DIR/$path" ]; then
      mkdir -p "$(dirname "$REPO_DIR/$path")"
      cp -a "$BUILD_DIR/$path" "$REPO_DIR/$path"
    fi
  done
  for path in "${ALL_RUNTIME_PATHS[@]}"; do
    if [ -e "$BUILD_DIR/$path" ] || [ -L "$BUILD_DIR/$path" ]; then
      [ -e "$REPO_DIR/$path" ] || [ -L "$REPO_DIR/$path" ] || return 1
    fi
  done
}

clear_legacy_gui_api() {
  local uid
  uid="$(id -u)"
  if launchctl print "gui/$uid/com.xhsai.api" >/dev/null 2>&1; then
    echo "卸载残留 GUI API LaunchAgent"
    launchctl bootout "gui/$uid/com.xhsai.api" || {
      echo "无法卸载 gui/$uid/com.xhsai.api" >&2
      return 1
    }
  fi
  rm -f "$HOME/Library/LaunchAgents/com.xhsai.api.plist" \
    "$HOME/Library/LaunchAgents/com.xhsai.api.plist.disabled"
}

record_api_state() {
  local before_file="$ROLLBACK_DIR/service.before.txt"
  local before_pids=() job_pid start_id
  : > "$before_file"
  [ -f "$API_PLIST" ] || {
    echo "拒绝部署：缺少 API LaunchDaemon plist：$API_PLIST" >&2
    return 1
  }
  if launchctl print system/com.xhsai.api >> "$before_file" 2>&1; then
    printf 'loaded=1\n' >> "$before_file"
  else
    printf 'loaded=0\n' >> "$before_file"
    echo "拒绝部署：触碰新版本前 system/com.xhsai.api 未加载；状态已保存到 $before_file" >&2
    return 1
  fi
  job_pid="$(job_pid_from_file "$before_file")"
  case "$job_pid" in
    ''|*[!0-9]*|0) echo "拒绝部署：system/com.xhsai.api 没有有效运行 PID" >&2; return 1 ;;
  esac
  before_pids=($(listener_pids))
  if [ "${#before_pids[@]}" -ne 1 ] || [ "${before_pids[0]}" != "$job_pid" ]; then
    echo "拒绝部署：API job PID 与 ${PORT} 唯一监听 PID 不一致" >&2
    return 1
  fi
  start_id="$(process_start_id "$job_pid")"
  [ -n "$start_id" ] || {
    echo "拒绝部署：无法读取 API PID $job_pid 的启动标识" >&2
    return 1
  }
  OLD_API_PID="$job_pid"
  OLD_API_START_ID="$start_id"
  printf 'listener_pid=%s\nstart_id=%s\n' "$OLD_API_PID" "$OLD_API_START_ID" \
    >> "$before_file"
  SERVICE_STATE_CAPTURED=1
}

verify_recorded_api_still_current() {
  local state_file="$ROLLBACK_DIR/service.pre-restart.txt"
  local job_pid start_id pids=()
  : > "$state_file"
  launchctl print system/com.xhsai.api > "$state_file" 2>&1 || {
    echo "拒绝重启：system/com.xhsai.api 在门禁期间已卸载" >&2
    return 1
  }
  job_pid="$(job_pid_from_file "$state_file")"
  pids=($(listener_pids))
  start_id="$(process_start_id "$job_pid")"
  if [ "$job_pid" != "$OLD_API_PID" ] || [ "$start_id" != "$OLD_API_START_ID" ] \
    || [ "${#pids[@]}" -ne 1 ] || [ "${pids[0]}" != "$OLD_API_PID" ]; then
    echo "拒绝重启：API 在门禁期间 PID 或启动标识发生变化" >&2
    return 1
  fi
}

wait_for_api_unloaded() {
  local old_pid="${1:-}" old_start="${2:-}" waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
    if ! launchctl print system/com.xhsai.api >/dev/null 2>&1 \
      && ! process_matches_start_id "$old_pid" "$old_start" \
      && ! api_has_listener; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done
  echo "等待旧 API 停止超时；拒绝在进程仍使用文件时交换运行时" >&2
  return 1
}

stop_api_service_for_rollback() {
  local state_file="$ROLLBACK_DIR/rollback-api.before-bootout.txt"
  local old_pid="" old_start="" print_status=0 bootout_status=0
  echo "停止 system/com.xhsai.api 以安全恢复旧运行时"
  : > "$state_file"
  if launchctl print system/com.xhsai.api > "$state_file" 2>&1; then
    old_pid="$(job_pid_from_file "$state_file")"
    case "$old_pid" in
      ''|*[!0-9]*|0) echo "无法确认回滚前 API job PID" >&2; return 1 ;;
    esac
    old_start="$(process_start_id "$old_pid")"
    [ -n "$old_start" ] || { echo "无法确认回滚前 API 启动标识" >&2; return 1; }
    sudo launchctl bootout "system/com.xhsai.api" || bootout_status=$?
  else
    print_status=$?
    [ "$print_status" = "113" ] || return 1
  fi
  if wait_for_api_unloaded "$old_pid" "$old_start"; then
    if [ "$bootout_status" != "0" ]; then
      echo "bootout 返回 ${bootout_status}，但 job 与原 PID 已确认退出，按竞态继续恢复"
    fi
    return 0
  fi
  return 1
}

start_old_api_service() {
  local bootstrap_state="$ROLLBACK_DIR/rollback-api.after-bootstrap.txt"
  local bootstrap_pid bootstrap_start
  [ -f "$API_PLIST" ] || {
    echo "无法恢复旧 API：缺少 $API_PLIST" >&2
    return 1
  }
  sudo launchctl bootstrap system "$API_PLIST" || return 1
  wait_for_api_listener "bootstrap 后的旧 API" || return 1
  : > "$bootstrap_state"
  launchctl print system/com.xhsai.api > "$bootstrap_state" 2>&1 || return 1
  bootstrap_pid="$(job_pid_from_file "$bootstrap_state")"
  case "$bootstrap_pid" in ''|*[!0-9]*|0) return 1 ;; esac
  bootstrap_start="$(process_start_id "$bootstrap_pid")"
  [ -n "$bootstrap_start" ] || return 1
  sudo launchctl kickstart -k system/com.xhsai.api || return 1
  wait_for_replaced_api_listener "$bootstrap_pid" "$bootstrap_start" "旧 API" 0
}

rollback_dist() {
  previous_status=$?
  code="${1:-$previous_status}"
  if [ "$ROLLBACK_ACTIVE" = "1" ]; then
    exit "$ROLLBACK_ORIGINAL_CODE"
  fi
  ROLLBACK_ACTIVE=1
  ROLLBACK_ORIGINAL_CODE="$code"
  trap - ERR HUP INT TERM
  set +e
  if [ "$SERVICE_TOUCHED" != "1" ]; then
    rm -rf "$ROLLBACK_DIR"
    echo "部署失败；活树运行时与 API 未被触碰。" >&2
    exit "$code"
  fi
  rollback_service_log="$ROLLBACK_DIR/rollback-service.log"
  printf 'service_state_captured=%s\nservice_touched=%s\n' \
    "$SERVICE_STATE_CAPTURED" "$SERVICE_TOUCHED" > "$rollback_service_log"
  service_stopped=0
  ops_restored=1
  runtime_restored=1
  service_restored=1

  if [ "$SERVICE_TOUCHED" = "1" ]; then
    service_stopped=1
    stop_api_service_for_rollback >> "$rollback_service_log" 2>&1 || service_stopped=0
  fi
  restore_ops_scripts || ops_restored=0
  if [ "$service_stopped" = "1" ]; then
    restore_runtime || runtime_restored=0
  else
    runtime_restored=0
  fi

  if [ "$runtime_restored" = "1" ]; then
    start_old_api_service >> "$rollback_service_log" 2>&1 || service_restored=0
    if [ "$service_restored" = "1" ]; then
      wait_for_structured_health "旧 API" >> "$rollback_service_log" 2>&1 \
        || service_restored=0
    fi
  else
    service_restored=0
  fi

  if [ "$service_stopped" = "1" ] && [ "$ops_restored" = "1" ] \
    && [ "$runtime_restored" = "1" ] && [ "$service_restored" = "1" ]; then
    if rm -rf "$ROLLBACK_DIR"; then
      echo "部署失败；旧 runtime、node_modules、运维脚本与 API 服务均已恢复并通过结构化健康。" >&2
      exit "$code"
    fi
  fi

  echo "部署失败且自动恢复未完成；保留回滚证据：$ROLLBACK_DIR" >&2
  exit 70
}

run_step() {
  local status
  if "$@"; then
    return 0
  else
    status=$?
    rollback_dist "$status"
  fi
}

record_status=0
record_api_state || record_status=$?
if [ "$record_status" != "0" ]; then
  rm -rf "$ROLLBACK_DIR"
  exit "$record_status"
fi

trap 'rollback_dist 129' HUP
trap 'rollback_dist 130' INT
trap 'rollback_dist 143' TERM

echo "==> [2/11] 在隔离目录严格安装锁文件依赖"
run_step prepare_isolated_build
run_step run_in_build npm ci

echo "==> [3/11] 隔离构建"
run_step run_in_build npm run build

echo "==> [4/11] 类型检查"
run_step run_in_build npm run typecheck

echo "==> [5/11] 全量单元与集成测试"
run_step run_in_build npm test

echo "==> [6/11] 供应锁文件版本的 Chromium"
run_step run_in_build npx playwright install chromium

echo "==> [7/11] 浏览器冒烟"
run_step run_in_build npm run smoke:browser

echo "==> [8/11] 生成上线前一致性备份"
run_step env OPS_ENV_FILE="${OPS_ENV_FILE:-$HOME/Library/Application Support/xhsai/ops.env}" \
  bash "$REPO_DIR/scripts/backup-production.sh"

echo "==> [9/11] 刷新受 TCC 允许的运维脚本并换入新运行时后重启"
run_step install -d -m 700 "$LAUNCHD_BIN"
OPS_SCRIPTS_TOUCHED=1
run_step install -m 700 "$REPO_DIR/scripts/health-watch.sh" "$REPO_DIR/scripts/backup-production.sh" \
  "$REPO_DIR/scripts/prepare-backup.mjs" "$REPO_DIR/scripts/backup-manifest.mjs" \
  "$REPO_DIR/scripts/storage-paths.mjs" "$LAUNCHD_BIN/"
run_step verify_recorded_api_still_current
run_step clear_legacy_gui_api
SERVICE_TOUCHED=1
run_step install_runtime_from_build
run_step sudo launchctl kickstart -k system/com.xhsai.api

echo "==> [10/11] 等待监听与结构化健康并执行本机黑盒"
run_step wait_for_replaced_api_listener "$OLD_API_PID" "$OLD_API_START_ID" "新 API"
run_step env BASE="http://127.0.0.1:${PORT}" npm run smoke:production
run_step bash "$REPO_DIR/ops/launchd/verify.sh"

echo "==> [11/11] 可选公网黑盒"
PUBLIC_BASE="${PUBLIC_SMOKE_BASE_URL:-}"
if [ -z "$PUBLIC_BASE" ] && [ -n "${PUBLIC_HEALTH_URL:-}" ]; then
  PUBLIC_BASE="${PUBLIC_HEALTH_URL%/health}"
fi
if [ -n "$PUBLIC_BASE" ]; then
  run_step env BASE="$PUBLIC_BASE" npm run smoke:production
elif [ "${REQUIRE_PUBLIC_SMOKE:-0}" = "1" ]; then
  echo "REQUIRE_PUBLIC_SMOKE=1，但未配置 PUBLIC_SMOKE_BASE_URL/PUBLIC_HEALTH_URL" >&2
  run_step false
else
  echo "    未配置公网入口，本轮只验本机黑盒"
fi

trap - HUP INT TERM
rm -rf "$ROLLBACK_DIR"
echo "==> 部署完成 $(git rev-parse --short HEAD)"

#!/bin/bash
# content-agent 看门狗:每 5 分钟由 launchd 调一次。
#
# 为什么存在:此前系统零告警——服务 crash-loop、网关断供、磁盘满的发现方式
# 都是"用户来报障"。本脚本把 MTTD 变成分钟级:探活 /health(现在是真探测:
# 数据库可写性/队列/磁盘),再从生产库聚合最近一小时失败率,异常时:
#   1) 写 ~/Library/Logs/xhsai/alerts.log(留痕)
#   2) macOS 桌面通知(单机生产,值班的人就在这台机器前)
#   3) 可选 ALERT_WEBHOOK(接 IM 机器人,人不在电脑前也能收到)
# 告警去重:同类告警 30 分钟内只发一次(state 文件)。
#
# ── 远程告警配置(打开 IM 通知只需两步)────────────────────────────────
# 1. 建机器人拿 webhook 地址:
#    飞书: 群设置 → 群机器人 → 添加「自定义机器人」→ 复制 webhook 地址
#    钉钉: 群设置 → 智能群助手 → 添加「自定义」机器人(安全设置选「自定义
#          关键词」,填「告警」)→ 复制 webhook 地址
# 2. 写进权限 600 的 ~/Library/Application Support/xhsai/ops.env:
#      ALERT_WEBHOOK      = 上面复制的地址
#      ALERT_WEBHOOK_KIND = feishu | dingtalk | generic(默认,发裸 JSON)
#      PUBLIC_HEALTH_URL   = https://你的域名/health
#    验证:OPS_ENV_FILE=... bash scripts/health-watch.sh --test
set -uo pipefail
umask 077

# launchd 从 ~/Library/Application Support/xhsai/bin/ 运行本脚本的拷贝
# (macOS TCC 会拒绝 launchd 执行位于"桌面"下的脚本文件,exit 126;
# 部署方式见 RUNBOOK):此时仓库位置由 CONTENT_AGENT_ROOT 提供。
# 在仓库内直接手工执行时仍按脚本位置自动推导。
ROOT="${CONTENT_AGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

OPS_ENV_FILE="${OPS_ENV_FILE:-$HOME/Library/Application Support/xhsai/ops.env}"
if [ -e "$OPS_ENV_FILE" ]; then
  if [ ! -f "$OPS_ENV_FILE" ]; then
    echo "OPS_ENV_FILE 不是普通文件: $OPS_ENV_FILE" >&2
    exit 1
  fi
  # GNU stat -c 必须在前：GNU -f 是 --file-system，会成功并倒出文件系统信息。
  OPS_MODE="$(stat -c '%a' "$OPS_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$OPS_ENV_FILE" 2>/dev/null || true)"
  if [ "$OPS_MODE" != "600" ] && [ "$OPS_MODE" != "400" ]; then
    echo "OPS_ENV_FILE 权限必须是 600 或 400，当前为 ${OPS_MODE:-未知}" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090 -- 路径由受保护的 launchd 配置指定
  . "$OPS_ENV_FILE"
  set +a
fi

OPS_LOG_DIR="${CONTENT_AGENT_OPS_LOG_DIR:-$HOME/Library/Logs/xhsai}"
SUPPORT_DIR="${CONTENT_AGENT_SUPPORT_DIR:-$HOME/Library/Application Support/xhsai}"
BACKUP_DIR="${CONTENT_AGENT_BACKUP_DIR:-$SUPPORT_DIR/backups/auto}"
LOG="$OPS_LOG_DIR/alerts.log"
STATE="$SUPPORT_DIR/.alert-state"
BACKUP_VERIFY_CACHE="$SUPPORT_DIR/.backup-verification-cache"
NODE_BIN="${CONTENT_AGENT_NODE_BIN:-node}"
HELPER="${CONTENT_AGENT_BACKUP_HELPER:-$(cd "$(dirname "$0")" && pwd)/prepare-backup.mjs}"
MANIFEST_HELPER="${CONTENT_AGENT_BACKUP_MANIFEST_HELPER:-$(cd "$(dirname "$0")" && pwd)/backup-manifest.mjs}"
LOCAL_HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8780/health}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-}"
DEDUP_SECONDS=1800
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-48}"
case "$BACKUP_MAX_AGE_HOURS" in
  ''|*[!0-9]*) echo "BACKUP_MAX_AGE_HOURS 必须是正整数" >&2; exit 1 ;;
esac
[ "$BACKUP_MAX_AGE_HOURS" -gt 0 ] || {
  echo "BACKUP_MAX_AGE_HOURS 必须是正整数" >&2
  exit 1
}
BACKUP_MAX_AGE_SECONDS=$((BACKUP_MAX_AGE_HOURS * 60 * 60))
case "$NODE_BIN" in
  */*) ;;
  *) NODE_BIN="$(command -v "$NODE_BIN" || true)" ;;
esac
mkdir -p "$OPS_LOG_DIR" "$SUPPORT_DIR"

# IM webhook 载荷:飞书/钉钉的自定义机器人各有必须的信封格式,发错格式静默
# 丢弃(HTTP 200 但不弹消息),所以按 ALERT_WEBHOOK_KIND 显式选择。
json_string() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read(), ensure_ascii=False))'
}

send_webhook() { # $1=文本
  local text="$1" encoded payload
  [ -z "${ALERT_WEBHOOK:-}" ] && return 0
  encoded="$(json_string "$text")" || return 1
  case "${ALERT_WEBHOOK_KIND:-generic}" in
    feishu)   payload="{\"msg_type\":\"text\",\"content\":{\"text\":${encoded}}}" ;;
    dingtalk)
      encoded="$(json_string "告警 ${text}")" || return 1
      payload="{\"msgtype\":\"text\",\"text\":{\"content\":${encoded}}}"
      ;;
    *)        payload="{\"message\":${encoded}}" ;;
  esac
  if ! curl -fsS --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d "${payload}" "${ALERT_WEBHOOK}" > /dev/null; then
    echo "[$(date '+%F %T')] [webhook_failed] 远程告警发送失败" >> "$LOG"
    return 1
  fi
}

alert() { # $1=类别 $2=消息
  local kind="$1" message="$2" now last
  now="$(date +%s)"
  last="$(grep "^$kind " "$STATE" 2>/dev/null | tail -1 | awk '{print $2}')"
  if [ -n "${last:-}" ] && [ $((now - last)) -lt "$DEDUP_SECONDS" ]; then return; fi
  echo "$kind $now" >> "$STATE"
  echo "[$(date '+%F %T')] [$kind] $message" >> "$LOG"
  osascript -e "display notification \"$message\" with title \"content-agent 告警\" sound name \"Basso\"" 2>/dev/null || true
  send_webhook "[content-agent/${kind}] ${message}" || true
}

# --test:发一条测试消息验证 webhook 通路,不跑真实巡检。
if [ "${1:-}" = "--test" ]; then
  if [ -z "${ALERT_WEBHOOK:-}" ]; then
    echo "未发送测试消息(ALERT_WEBHOOK=未配置 KIND=${ALERT_WEBHOOK_KIND:-generic})"
    exit 2
  fi
  TEST_MESSAGE="${ALERT_TEST_MESSAGE:-[content-agent/test] 告警通路测试消息,收到即配置成功 $(date '+%F %T')}"
  send_webhook "$TEST_MESSAGE"
  echo "已发送测试消息(ALERT_WEBHOOK=已配置 KIND=${ALERT_WEBHOOK_KIND:-generic})"
  exit 0
fi

# 1) 探活:本机 API 与可选公网隧道分别检查。仅 HTTP 200 不够，
#    status 必须为 ok 且 databaseWritable 不能是 false。
#    变量一律 ${VAR} 花括号:macOS 自带 bash 3.2 在变量紧邻全角字符时
#    会把多字节字符吞进变量名,裸 $VAR 直接 unbound variable。
probe_health() { # $1=告警前缀 $2=名称 $3=URL
  local prefix="$1" label="$2" url="$3" body status database_writable parsed
  local response_file http_status curl_status protocol_valid
  response_file="$(mktemp "$SUPPORT_DIR/.health-response.XXXXXX")" || {
    alert "${prefix}_degraded" "${label}探活无法创建临时响应文件（${url}）"
    return
  }
  http_status="$(curl -sS --max-time 5 -o "$response_file" -w '%{http_code}' "${url}" 2>/dev/null)"
  curl_status=$?
  body="$(<"$response_file")"
  rm -f "$response_file"
  if [ "$curl_status" -ne 0 ]; then
    alert "${prefix}_down" "${label}网络不可达（${url}）"
    return
  fi
  protocol_valid=0
  if parsed="$(printf '%s' "${body}" | python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
status = payload.get("status") if isinstance(payload, dict) else None
database_writable = payload.get("databaseWritable") if isinstance(payload, dict) else None
if status not in {"ok", "degraded", "unavailable"} or not isinstance(database_writable, bool):
    raise SystemExit(1)
sys.stdout.write(f"{status}|{str(database_writable).lower()}")
')" ; then
    protocol_valid=1
  else
    parsed=""
  fi
  status="${parsed%%|*}"
  database_writable="${parsed##*|}"
  if [ "$protocol_valid" != "1" ]; then
    alert "${prefix}_degraded" "${label}健康协议异常（HTTP ${http_status}），响应不是有效健康 JSON"
  elif [ "${database_writable}" = "false" ] || [ "${status}" = "unavailable" ]; then
    alert "${prefix}_db_unwritable" "${label}数据库不可写（HTTP ${http_status}）——可能磁盘满或库损坏，立即处理"
  elif [ "${status}" != "ok" ] || ! printf '%s' "$http_status" | grep -qE '^2[0-9][0-9]$'; then
    alert "${prefix}_degraded" "${label}状态为 ${status}（HTTP ${http_status}），查看 /health 与服务日志"
  fi
}

probe_health "service" "本机 API" "$LOCAL_HEALTH_URL"
[ -n "$PUBLIC_HEALTH_URL" ] && probe_health "public" "公网入口" "$PUBLIC_HEALTH_URL"

# 2) 失败率:最近一小时终态任务里失败 ≥3 且占比 ≥50% 视为异常
#    (阈值保守:单篇偶发失败有重试与退款兜底,要抓的是断供/坏发布这类成批失败)。
DB=""
if [ -x "$NODE_BIN" ] && [ -f "$HELPER" ]; then
  DB="$("$NODE_BIN" "$HELPER" --print-database-path "$ROOT" 2>/dev/null)" || {
    DB=""
    alert "failure_rate_unavailable" "无法从仓库 .env 解析生产数据库路径，失败率巡检已关闭"
  }
else
  alert "failure_rate_unavailable" "Node 或备份 helper 不可用，失败率巡检已关闭"
fi
if [ -f "$DB" ] && [ -x "$NODE_BIN" ]; then
  ROW="$("$NODE_BIN" -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
try {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN status=? THEN 1 ELSE 0 END),0) AS failed,
           COUNT(*) AS total
    FROM generation_jobs
    WHERE completed_at >= datetime(?,?)`).get("failed", "now", "-1 hour");
  process.stdout.write(`${row.failed}|${row.total}`);
} finally {
  db.close();
}
' "$DB" 2>/dev/null)" || ROW=""
  FAILED="${ROW%%|*}"; TOTAL="${ROW##*|}"
  if [ -n "$ROW" ] && [ "${TOTAL:-0}" -gt 0 ] && [ "${FAILED:-0}" -ge 3 ] \
     && [ $((FAILED * 2)) -ge "$TOTAL" ]; then
    alert "failure_rate" "最近一小时生成失败 ${FAILED}/${TOTAL}——疑似网关断供或坏发布，查看产出区与 api.log"
  fi
fi

# 3) 备份链路:launchd 最近退出、最新归档配对、可配置新鲜度与可恢复性。
#    launchctl 不存在时（例如 Linux 测试环境）仍执行文件级巡检。
BACKUP_RUNNING=0
if command -v launchctl >/dev/null 2>&1; then
  BACKUP_JOB="$(
    launchctl print "system/com.xhsai.backup" 2>/dev/null
  )" || BACKUP_JOB=""
  ACTIVE_BACKUP_COUNT="$(
    printf '%s\n' "$BACKUP_JOB" \
      | awk -F'= ' '/active count =/{gsub(/[[:space:]]/, "", $2); print $2; exit}'
  )"
  case "$ACTIVE_BACKUP_COUNT" in
    ''|*[!0-9]*) ;;
    *) [ "$ACTIVE_BACKUP_COUNT" -eq 0 ] || BACKUP_RUNNING=1 ;;
  esac
  LAST_BACKUP_EXIT="$(
    printf '%s\n' "$BACKUP_JOB" \
      | awk -F'= ' '/last exit code =/{gsub(/[[:space:]]/, "", $2); print $2; exit}'
  )"
  case "$LAST_BACKUP_EXIT" in
    ''|0|*[!0-9]*) ;;
    *) alert "backup_failed" "自动备份最近一次运行失败，exit=${LAST_BACKUP_EXIT}" ;;
  esac
fi
if [ "$BACKUP_RUNNING" = "0" ] && [ -f "$SUPPORT_DIR/backup.lock/owner" ]; then
  LOCK_PID=""
  LOCK_STARTED=""
  LOCK_OWNER_TOKEN=""
  {
    IFS= read -r LOCK_PID || true
    IFS= read -r LOCK_STARTED || true
    IFS= read -r LOCK_OWNER_TOKEN || true
  } < "$SUPPORT_DIR/backup.lock/owner"
  case "$LOCK_PID" in
    ''|*[!0-9]*) ;;
    *)
      if kill -0 "$LOCK_PID" 2>/dev/null; then
        CURRENT_LOCK_STARTED="$(
          TZ=UTC LC_ALL=C LANG=C ps -o lstart= -p "$LOCK_PID" 2>/dev/null \
            | awk '{$1=$1; print}'
        )" || CURRENT_LOCK_STARTED=""
        if [ -z "$LOCK_STARTED" ] || [ -z "$CURRENT_LOCK_STARTED" ] \
           || [ "$CURRENT_LOCK_STARTED" = "$LOCK_STARTED" ]; then
          BACKUP_RUNNING=1
        fi
      fi
      ;;
  esac
fi

file_modified() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1" 2>/dev/null || true
}

file_content_identity() {
  local file="$1" hash
  [ -x "$NODE_BIN" ] || return 1
  hash="$("$NODE_BIN" -e '
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const stream = createReadStream(process.argv[1]);
const hash = createHash("sha256");
stream.on("data", (chunk) => hash.update(chunk));
stream.on("end", () => process.stdout.write(hash.digest("hex")));
stream.on("error", () => { process.exitCode = 1; });
' "$file" 2>/dev/null)" || return 1
  [ -n "$hash" ] || return 1
  printf '%s|%s' "${file##*/}" "$hash"
}

cache_backup_verification() { # $1=ok|corrupt $2=db identity $3=files identity
  local cache_status="$1" database_identity="$2" files_identity="$3"
  local temporary_cache="${BACKUP_VERIFY_CACHE}.$$"
  if printf '%s\n%s\n%s\n' "$cache_status" "$database_identity" "$files_identity" \
      > "$temporary_cache" \
     && chmod 600 "$temporary_cache" \
     && mv "$temporary_cache" "$BACKUP_VERIFY_CACHE" \
     && chmod 600 "$BACKUP_VERIFY_CACHE"; then
    return 0
  fi
  rm -f "$temporary_cache"
  return 1
}

LATEST_DB=""
LATEST_FILES=""
MANIFEST_POLICY=0
if [ -x "$NODE_BIN" ] && [ -f "$MANIFEST_HELPER" ]; then
  BACKUP_INSPECTION="$("$NODE_BIN" "$MANIFEST_HELPER" --inspect-lines "$BACKUP_DIR" 2>/dev/null)" || BACKUP_INSPECTION=""
  if [ -n "$BACKUP_INSPECTION" ]; then
    {
      IFS= read -r INSPECTION_MODE || true
      IFS= read -r INSPECTION_STAMP || true
      IFS= read -r INSPECTION_DB || true
      IFS= read -r INSPECTION_FILES || true
      IFS= read -r INSPECTION_MANIFEST || true
      IFS= read -r UNCOMMITTED_COUNT || true
    } <<EOF
$BACKUP_INSPECTION
EOF
    case "$UNCOMMITTED_COUNT" in ''|*[!0-9]*) UNCOMMITTED_COUNT=0 ;; esac
    if [ "$UNCOMMITTED_COUNT" -gt 0 ]; then
      MANIFEST_POLICY=1
      alert "backup_uncommitted" "发现 ${UNCOMMITTED_COUNT} 组没有完成 manifest 的备份归档"
    fi
    if [ "$INSPECTION_MODE" = "manifest" ]; then
      MANIFEST_POLICY=1
    fi
    if [ "$MANIFEST_POLICY" = "1" ] && [ "$INSPECTION_DB" != "-" ] && [ "$INSPECTION_FILES" != "-" ]; then
      LATEST_DB="$INSPECTION_DB"
      LATEST_FILES="$INSPECTION_FILES"
    fi
  else
    MANIFEST_POLICY=1
    alert "backup_corrupt" "无法读取或校验备份 complete manifest"
  fi
else
  MANIFEST_POLICY=1
  alert "backup_corrupt" "备份 manifest helper 不可用"
fi

if [ "$MANIFEST_POLICY" = "0" ]; then
  for CANDIDATE in "$BACKUP_DIR"/app-*.db.gz; do
    [ -f "$CANDIDATE" ] || continue
    if [ -z "$LATEST_DB" ] || [ "$CANDIDATE" -nt "$LATEST_DB" ]; then
      LATEST_DB="$CANDIDATE"
    fi
  done
  for CANDIDATE in "$BACKUP_DIR"/files-*.tar.gz; do
    [ -f "$CANDIDATE" ] || continue
    if [ -z "$LATEST_FILES" ] || [ "$CANDIDATE" -nt "$LATEST_FILES" ]; then
      LATEST_FILES="$CANDIDATE"
    fi
  done
fi

if [ -z "$LATEST_DB" ] && [ -z "$LATEST_FILES" ]; then
  [ "$BACKUP_RUNNING" = "1" ] \
    || alert "backup_missing" "自动备份目录没有任何数据库与文件归档：${BACKUP_DIR}"
elif [ -z "$LATEST_DB" ] || [ -z "$LATEST_FILES" ]; then
  [ "$BACKUP_RUNNING" = "1" ] \
    || alert "backup_unpaired" "最新自动备份只有数据库或文件归档，无法成对恢复"
else
  DB_NAME="${LATEST_DB##*/}"
  DB_STAMP="${DB_NAME#app-}"
  DB_STAMP="${DB_STAMP%.db.gz}"
  FILES_NAME="${LATEST_FILES##*/}"
  FILES_STAMP="${FILES_NAME#files-}"
  FILES_STAMP="${FILES_STAMP%.tar.gz}"
  if [ "$DB_STAMP" != "$FILES_STAMP" ]; then
    [ "$BACKUP_RUNNING" = "1" ] \
      || alert "backup_unpaired" "最新数据库与文件归档时间戳不一致：${DB_STAMP} / ${FILES_STAMP}"
  else
    DB_MODIFIED="$(file_modified "$LATEST_DB")"
    FILES_MODIFIED="$(file_modified "$LATEST_FILES")"
    case "$DB_MODIFIED:$FILES_MODIFIED" in
      *[!0-9:]*|:*|*:)
        alert "backup_corrupt" "无法读取最新备份对的文件时间：${DB_STAMP}"
        ;;
      *)
        PAIR_MODIFIED="$DB_MODIFIED"
        [ "$FILES_MODIFIED" -ge "$PAIR_MODIFIED" ] || PAIR_MODIFIED="$FILES_MODIFIED"
        BACKUP_AGE_SECONDS=$(( $(date +%s) - PAIR_MODIFIED ))
        if [ "$BACKUP_AGE_SECONDS" -gt "$BACKUP_MAX_AGE_SECONDS" ]; then
          alert "backup_stale" "最新自动备份已超过 ${BACKUP_MAX_AGE_HOURS} 小时：${DB_STAMP}"
        fi
        ;;
    esac
    DATABASE_IDENTITY="$(file_content_identity "$LATEST_DB")" || DATABASE_IDENTITY=""
    FILES_IDENTITY="$(file_content_identity "$LATEST_FILES")" || FILES_IDENTITY=""
    CACHED_STATUS=""
    CACHED_DATABASE_IDENTITY=""
    CACHED_FILES_IDENTITY=""
    if [ -f "$BACKUP_VERIFY_CACHE" ]; then
      {
        IFS= read -r CACHED_STATUS || true
        IFS= read -r CACHED_DATABASE_IDENTITY || true
        IFS= read -r CACHED_FILES_IDENTITY || true
      } < "$BACKUP_VERIFY_CACHE"
      chmod 600 "$BACKUP_VERIFY_CACHE" 2>/dev/null || true
    fi
    if [ -z "$DATABASE_IDENTITY" ] || [ -z "$FILES_IDENTITY" ]; then
      alert "backup_corrupt" "无法计算最新备份对的 SHA-256：${DB_STAMP}"
    elif [ "$CACHED_DATABASE_IDENTITY" = "$DATABASE_IDENTITY" ] \
       && [ "$CACHED_FILES_IDENTITY" = "$FILES_IDENTITY" ] \
       && { [ "$CACHED_STATUS" = "ok" ] || [ "$CACHED_STATUS" = "corrupt" ]; }; then
      if [ "$CACHED_STATUS" = "corrupt" ]; then
        alert "backup_corrupt" "最新自动备份损坏或文件包缺少 .env：${DB_STAMP}"
      fi
    elif ! gzip -t "$LATEST_DB" 2>/dev/null \
         || ! tar -tzf "$LATEST_FILES" >/dev/null 2>&1 \
         || ! tar -xOf "$LATEST_FILES" .env >/dev/null 2>&1; then
      cache_backup_verification "corrupt" "$DATABASE_IDENTITY" "$FILES_IDENTITY" || true
      alert "backup_corrupt" "最新自动备份损坏或文件包缺少 .env：${DB_STAMP}"
    else
      cache_backup_verification "ok" "$DATABASE_IDENTITY" "$FILES_IDENTITY" || true
    fi
  fi
fi

# 4) 日志轮转(copytruncate:launchd 持有的 fd 不受影响):单文件超 50MB 截断留一代。
#    API 服务(com.xhsai.api)的日志在 ~/Library/Logs/xhsai/——launchd 冷启动
#    解析不了中文 StandardOutPath(exit 78),所以服务日志必须落纯 ASCII 路径。
file_size() {
  stat -c '%s' "$1" 2>/dev/null || stat -f '%z' "$1" 2>/dev/null || echo 0
}

for FILE in "$HOME/Library/Logs/xhsai/api.out.log" "$HOME/Library/Logs/xhsai/api.err.log" \
            "$HOME/Library/Logs/xhsai/tunnel.err.log" \
            "$HOME/Library/Logs/xhsai/health-watch.out.log" \
            "$HOME/Library/Logs/xhsai/health-watch.err.log" \
            "$HOME/Library/Logs/xhsai/backup.log" \
            "$HOME/Library/Logs/xhsai/backup.err.log"; do
  if [ -f "${FILE}" ] && [ "$(file_size "${FILE}")" -gt 52428800 ]; then
    cp "${FILE}" "${FILE}.1" && : > "${FILE}"
    echo "[$(date '+%F %T')] [log_rotate] ${FILE##*/} 已轮转" >> "$LOG"
  fi
done

#!/bin/bash
# content-agent 看门狗:每 5 分钟由 launchd 调一次。
#
# 为什么存在:此前系统零告警——服务 crash-loop、网关断供、磁盘满的发现方式
# 都是"用户来报障"。本脚本把 MTTD 变成分钟级:探活 /health(现在是真探测:
# 数据库可写性/队列/磁盘),再从生产库聚合最近一小时失败率,异常时:
#   1) 写 data/logs/alerts.log(留痕)
#   2) macOS 桌面通知(单机生产,值班的人就在这台机器前)
#   3) 可选 ALERT_WEBHOOK(POST JSON,接 IM 机器人)
# 告警去重:同类告警 30 分钟内只发一次(state 文件)。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/data/logs/alerts.log"
STATE="$ROOT/data/logs/.alert-state"
URL="${HEALTH_URL:-http://127.0.0.1:8780/health}"
DEDUP_SECONDS=1800
mkdir -p "$ROOT/data/logs"

alert() { # $1=类别 $2=消息
  local kind="$1" message="$2" now last
  now="$(date +%s)"
  last="$(grep "^$kind " "$STATE" 2>/dev/null | tail -1 | awk '{print $2}')"
  if [ -n "${last:-}" ] && [ $((now - last)) -lt "$DEDUP_SECONDS" ]; then return; fi
  echo "$kind $now" >> "$STATE"
  echo "[$(date '+%F %T')] [$kind] $message" >> "$LOG"
  osascript -e "display notification \"$message\" with title \"content-agent 告警\" sound name \"Basso\"" 2>/dev/null || true
  if [ -n "${ALERT_WEBHOOK:-}" ]; then
    curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
      -d "{\"kind\":\"$kind\",\"message\":\"$message\"}" "$ALERT_WEBHOOK" > /dev/null || true
  fi
}

# 1) 探活:非 200 或 status 非 ok 都要叫人。
#    变量一律 ${VAR} 花括号:macOS 自带 bash 3.2 在变量紧邻全角字符时
#    会把多字节字符吞进变量名,裸 $VAR 直接 unbound variable。
BODY="$(curl -s --max-time 5 "${URL}" 2>/dev/null)" || BODY=""
STATUS="$(echo "${BODY}" | grep -oE '"status":"[a-z]+"' | head -1 | cut -d'"' -f4)"
if [ -z "${STATUS}" ]; then
  alert "service_down" "API 无响应（${URL}）——服务可能未运行或 crash-loop，查看 ~/Library/Logs/xhsai/api.err.log"
elif [ "${STATUS}" = "unavailable" ]; then
  alert "db_unwritable" "数据库不可写——可能磁盘满或库损坏，立即处理"
elif [ "${STATUS}" = "degraded" ]; then
  alert "disk_low" "磁盘余量不足 1GiB——清理或扩容，否则写入将失败"
fi

# 2) 失败率:最近一小时终态任务里失败 ≥3 且占比 ≥50% 视为异常
#    (阈值保守:单篇偶发失败有重试与退款兜底,要抓的是断供/坏发布这类成批失败)。
DB="$ROOT/data/app.db"
if [ -f "$DB" ]; then
  ROW="$(sqlite3 -readonly "$DB" "
    SELECT COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0),
           COALESCE(COUNT(*),0)
    FROM generation_jobs
    WHERE completed_at >= datetime('now','-1 hour');" 2>/dev/null)" || ROW=""
  FAILED="${ROW%%|*}"; TOTAL="${ROW##*|}"
  if [ -n "$ROW" ] && [ "${TOTAL:-0}" -gt 0 ] && [ "${FAILED:-0}" -ge 3 ] \
     && [ $((FAILED * 2)) -ge "$TOTAL" ]; then
    alert "failure_rate" "最近一小时生成失败 $FAILED/$TOTAL——疑似网关断供或坏发布，查看产出区与 api.log"
  fi
fi

# 3) 日志轮转(copytruncate:launchd 持有的 fd 不受影响):单文件超 50MB 截断留一代。
#    API 服务(com.xhsai.api)的日志在 ~/Library/Logs/xhsai/——launchd 冷启动
#    解析不了中文 StandardOutPath(exit 78),所以服务日志必须落纯 ASCII 路径。
for FILE in "$HOME/Library/Logs/xhsai/api.out.log" "$HOME/Library/Logs/xhsai/api.err.log" \
            "$ROOT/data/logs/api.log" "$ROOT/data/logs/api.err.log"; do
  if [ -f "${FILE}" ] && [ "$(stat -f%z "${FILE}")" -gt 52428800 ]; then
    cp "${FILE}" "${FILE}.1" && : > "${FILE}"
    echo "[$(date '+%F %T')] [log_rotate] ${FILE##*/} 已轮转" >> "$LOG"
  fi
done

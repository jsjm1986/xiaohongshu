#!/bin/bash
# content-agent 看门狗:每 5 分钟由 launchd 调一次。
#
# 为什么存在:此前系统零告警——服务 crash-loop、网关断供、磁盘满的发现方式
# 都是"用户来报障"。本脚本把 MTTD 变成分钟级:探活 /health(现在是真探测:
# 数据库可写性/队列/磁盘),再从生产库聚合最近一小时失败率,异常时:
#   1) 写 data/logs/alerts.log(留痕)
#   2) macOS 桌面通知(单机生产,值班的人就在这台机器前)
#   3) 可选 ALERT_WEBHOOK(接 IM 机器人,人不在电脑前也能收到)
# 告警去重:同类告警 30 分钟内只发一次(state 文件)。
#
# ── 远程告警配置(打开 IM 通知只需两步)────────────────────────────────
# 1. 建机器人拿 webhook 地址:
#    飞书: 群设置 → 群机器人 → 添加「自定义机器人」→ 复制 webhook 地址
#    钉钉: 群设置 → 智能群助手 → 添加「自定义」机器人(安全设置选「自定义
#          关键词」,填「告警」)→ 复制 webhook 地址
# 2. 写进 launchd 配置(~/Library/LaunchAgents/com.content-agent.health-watch.plist
#    的 EnvironmentVariables 区块)后 launchctl 重载:
#      ALERT_WEBHOOK      = 上面复制的地址
#      ALERT_WEBHOOK_KIND = feishu | dingtalk | generic(默认,发裸 JSON)
#    验证:ALERT_WEBHOOK=... ALERT_WEBHOOK_KIND=feishu bash scripts/health-watch.sh --test
set -uo pipefail

# launchd 从 ~/Library/Application Support/xhsai/bin/ 运行本脚本的拷贝
# (macOS TCC 会拒绝 launchd 执行位于"桌面"下的脚本文件,exit 126;
# 部署方式见 RUNBOOK):此时仓库位置由 CONTENT_AGENT_ROOT 提供。
# 在仓库内直接手工执行时仍按脚本位置自动推导。
ROOT="${CONTENT_AGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG="$ROOT/data/logs/alerts.log"
STATE="$ROOT/data/logs/.alert-state"
URL="${HEALTH_URL:-http://127.0.0.1:8780/health}"
DEDUP_SECONDS=1800
mkdir -p "$ROOT/data/logs"

# IM webhook 载荷:飞书/钉钉的自定义机器人各有必须的信封格式,发错格式静默
# 丢弃(HTTP 200 但不弹消息),所以按 ALERT_WEBHOOK_KIND 显式选择。
send_webhook() { # $1=文本
  local text="$1" payload
  [ -z "${ALERT_WEBHOOK:-}" ] && return 0
  case "${ALERT_WEBHOOK_KIND:-generic}" in
    feishu)   payload="{\"msg_type\":\"text\",\"content\":{\"text\":\"${text}\"}}" ;;
    dingtalk) payload="{\"msgtype\":\"text\",\"text\":{\"content\":\"告警 ${text}\"}}" ;;
    *)        payload="{\"message\":\"${text}\"}" ;;
  esac
  curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d "${payload}" "${ALERT_WEBHOOK}" > /dev/null || true
}

alert() { # $1=类别 $2=消息
  local kind="$1" message="$2" now last
  now="$(date +%s)"
  last="$(grep "^$kind " "$STATE" 2>/dev/null | tail -1 | awk '{print $2}')"
  if [ -n "${last:-}" ] && [ $((now - last)) -lt "$DEDUP_SECONDS" ]; then return; fi
  echo "$kind $now" >> "$STATE"
  echo "[$(date '+%F %T')] [$kind] $message" >> "$LOG"
  osascript -e "display notification \"$message\" with title \"content-agent 告警\" sound name \"Basso\"" 2>/dev/null || true
  send_webhook "[content-agent/${kind}] ${message}"
}

# --test:发一条测试消息验证 webhook 通路,不跑真实巡检。
if [ "${1:-}" = "--test" ]; then
  send_webhook "[content-agent/test] 告警通路测试消息,收到即配置成功 $(date '+%F %T')"
  echo "已发送测试消息(ALERT_WEBHOOK=${ALERT_WEBHOOK:-未配置} KIND=${ALERT_WEBHOOK_KIND:-generic})"
  exit 0
fi

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

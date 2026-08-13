#!/bin/bash
# content-agent 生产自动备份。
#
# 为什么存在:生产资产只有一份(SQLite + 知识原文 + 图片 + .env)。
# macOS LaunchDaemon 下 sqlite3/tar 直接读取“桌面”会被 TCC 拒绝；已获生产
# 运行授权的 Node 先把一致快照与文件复制到 Application Support 隔离区，
# gzip/tar 只接触隔离区，既不直拷活库，也不要求给系统 shell 全磁盘权限。
#
# 用法:
#   ./scripts/backup-production.sh            # 手工执行
#   launchd com.xhsai.backup 每日执行          # 定时(见 RUNBOOK)
# 异地副本:设置 BACKUP_REMOTE(rsync 目标,如 user@host:/backups/content-agent/
# 或挂载的外置盘路径),未设置时脚本会在日志里提醒——同盘备份防误删不防盘毁。
set -euo pipefail
umask 077

# launchd 拷贝运行时由 CONTENT_AGENT_ROOT 指定仓库(TCC 拒绝执行桌面下的
# 脚本文件,见 health-watch.sh 同款注释);仓库内手工执行自动推导。
ROOT="${CONTENT_AGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# webhook / 异地目标都属于仓库外秘密。launchd 只传这个 600 文件的路径，
# 脚本自行加载；文件缺省时仍可做本机备份。
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

SUPPORT_DIR="${CONTENT_AGENT_SUPPORT_DIR:-$HOME/Library/Application Support/xhsai}"
DEST="${CONTENT_AGENT_BACKUP_DIR:-$SUPPORT_DIR/backups/auto}"
STAGE_ROOT="$SUPPORT_DIR/backup-staging"
LOCK_DIR="$SUPPORT_DIR/backup.lock"
NODE_BIN="${CONTENT_AGENT_NODE_BIN:-node}"
HELPER="${CONTENT_AGENT_BACKUP_HELPER:-$(cd "$(dirname "$0")" && pwd)/prepare-backup.mjs}"
MANIFEST_HELPER="${CONTENT_AGENT_BACKUP_MANIFEST_HELPER:-$(cd "$(dirname "$0")" && pwd)/backup-manifest.mjs}"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
LOCK_STALE_SECONDS="${BACKUP_LOCK_STALE_SECONDS:-3600}"
STAGE=""
DB_OUT=""
FILES_OUT=""
DB_TMP=""
FILES_TMP=""
MANIFEST_OUT=""
MANIFEST_TMP=""
PENDING_MARKER=""
BACKUP_COMMITTED=0
PUBLISH_CLEANUP_OWNED=0
LOCK_HELD=0
LOCK_TOKEN=""

process_start_identity() {
  TZ=UTC LC_ALL=C LANG=C ps -o lstart= -p "$1" 2>/dev/null | awk '{$1=$1; print}'
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  rm -f "$DB_TMP" "$FILES_TMP" "$MANIFEST_TMP"
  if [ "$BACKUP_COMMITTED" != "1" ] && [ "$PUBLISH_CLEANUP_OWNED" = "1" ]; then
    rm -f "$DB_OUT" "$FILES_OUT" "$MANIFEST_OUT" "$PENDING_MARKER"
  fi
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  if [ "$LOCK_HELD" = "1" ]; then
    CURRENT_OWNER_TOKEN=""
    if [ -f "$LOCK_DIR/owner" ]; then
      {
        IFS= read -r _ || true
        IFS= read -r _ || true
        IFS= read -r CURRENT_OWNER_TOKEN || true
      } < "$LOCK_DIR/owner"
    fi
    if [ -n "$LOCK_TOKEN" ] && [ "$CURRENT_OWNER_TOKEN" = "$LOCK_TOKEN" ]; then
      rm -f "$LOCK_DIR/owner"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$NODE_BIN" in
  */*) ;;
  *) NODE_BIN="$(command -v "$NODE_BIN" || true)" ;;
esac
[ -x "$NODE_BIN" ] || { echo "Node 不可执行: $NODE_BIN" >&2; exit 1; }
[ -f "$HELPER" ] || { echo "备份 helper 不存在: $HELPER" >&2; exit 1; }
[ -f "$MANIFEST_HELPER" ] || { echo "备份 manifest helper 不存在: $MANIFEST_HELPER" >&2; exit 1; }
normalize_path() {
  "$NODE_BIN" -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$1"
}
ROOT="$(normalize_path "$ROOT")"
SUPPORT_DIR="$(normalize_path "$SUPPORT_DIR")"
DEST="$(normalize_path "$DEST")"
HOME_NORMALIZED="$(normalize_path "$HOME")"
STAGE_ROOT="$SUPPORT_DIR/backup-staging"
LOCK_DIR="$SUPPORT_DIR/backup.lock"
if [ "$DEST" = "/" ]; then
  echo "备份目录过宽或危险，拒绝使用: $DEST" >&2
  exit 1
fi
case "$DEST" in
  "$HOME_NORMALIZED"|"$SUPPORT_DIR"|"$ROOT"|"$HOME_NORMALIZED/Desktop"|"$HOME_NORMALIZED/Documents"|"$HOME_NORMALIZED/Downloads"|"$HOME_NORMALIZED/Library"|"/Users"|"/var"|"/tmp"|"/private/tmp")
    echo "备份目录过宽或危险，拒绝使用: $DEST" >&2
    exit 1
    ;;
esac
if [ -L "$DEST" ]; then
  echo "备份目录不能是符号链接: $DEST" >&2
  exit 1
fi
mkdir -p "$DEST" "$STAGE_ROOT"
DEST_SENTINEL="$DEST/.content-agent-backup-dir"
validate_destination_sentinel() {
  local sentinel_mode sentinel_content
  [ -f "$DEST_SENTINEL" ] && [ ! -L "$DEST_SENTINEL" ] || return 1
  sentinel_mode="$(stat -c '%a' "$DEST_SENTINEL" 2>/dev/null || stat -f '%Lp' "$DEST_SENTINEL" 2>/dev/null || true)"
  [ "$sentinel_mode" = "600" ] || return 1
  sentinel_content="$(command cat "$DEST_SENTINEL" 2>/dev/null || true)"
  [ "$sentinel_content" = "content-agent-backup-dir/v1" ]
}
if [ -e "$DEST_SENTINEL" ] || [ -L "$DEST_SENTINEL" ]; then
  validate_destination_sentinel || {
    echo "备份目录 sentinel 非普通 600 文件或内容无效: $DEST_SENTINEL" >&2
    exit 1
  }
else
  for EXISTING_ENTRY in "$DEST"/* "$DEST"/.[!.]* "$DEST"/..?*; do
    [ -e "$EXISTING_ENTRY" ] || [ -L "$EXISTING_ENTRY" ] || continue
    EXISTING_NAME="${EXISTING_ENTRY##*/}"
    case "$EXISTING_NAME" in
      app-*.db|app-*.db.gz|files-*.tar.gz|complete-*.json|.pending-*|.app-*.db.gz.*|.files-*.tar.gz.*|.complete-*.json.*) ;;
      *)
        echo "备份目录首次迁移发现无关顶层条目，拒绝使用: $EXISTING_ENTRY" >&2
        exit 1
        ;;
    esac
  done
  if ! (set -C; printf '%s\n' 'content-agent-backup-dir/v1' > "$DEST_SENTINEL") 2>/dev/null; then
    validate_destination_sentinel || {
      echo "备份目录 sentinel 并发创建失败: $DEST_SENTINEL" >&2
      exit 1
    }
  fi
  chmod 600 "$DEST_SENTINEL"
fi
LOCK_TOKEN="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomUUID())')"
[ -n "$LOCK_TOKEN" ] || { echo "无法生成备份锁 token" >&2; exit 1; }
case "$LOCK_STALE_SECONDS" in
  ''|*[!0-9]*) echo "BACKUP_LOCK_STALE_SECONDS 必须是正整数" >&2; exit 1 ;;
esac
[ "$LOCK_STALE_SECONDS" -gt 0 ] || { echo "BACKUP_LOCK_STALE_SECONDS 必须大于 0" >&2; exit 1; }
if ! mkdir "$LOCK_DIR"; then
  LOCK_PID=""
  LOCK_STARTED=""
  LOCK_OWNER_TOKEN=""
  if [ -f "$LOCK_DIR/owner" ]; then
    {
      IFS= read -r LOCK_PID || true
      IFS= read -r LOCK_STARTED || true
      IFS= read -r LOCK_OWNER_TOKEN || true
    } < "$LOCK_DIR/owner"
  fi
  LOCK_PID_ACTIVE=0
  case "$LOCK_PID" in
    ''|*[!0-9]*) ;;
    *)
      if kill -0 "$LOCK_PID" 2>/dev/null; then
        CURRENT_LOCK_STARTED="$(process_start_identity "$LOCK_PID")" || CURRENT_LOCK_STARTED=""
        if [ -z "$LOCK_STARTED" ] || [ -z "$CURRENT_LOCK_STARTED" ]; then
          echo "活 PID 的备份锁启动标识无法确认，本次 fail closed" >&2
          exit 75
        fi
        if [ "$CURRENT_LOCK_STARTED" = "$LOCK_STARTED" ]; then
          LOCK_PID_ACTIVE=1
        fi
      fi
      ;;
  esac
  if [ "$LOCK_PID_ACTIVE" = "1" ]; then
    echo "已有备份任务在运行（pid=${LOCK_PID}），本次拒绝并发执行" >&2
    exit 75
  fi
  LOCK_MODIFIED="$(stat -c '%Y' "$LOCK_DIR" 2>/dev/null || stat -f '%m' "$LOCK_DIR" 2>/dev/null || true)"
  case "$LOCK_MODIFIED" in
    ''|*[!0-9]*) echo "无法确认备份锁年龄，本次拒绝并发执行" >&2; exit 75 ;;
  esac
  LOCK_AGE=$(( $(date +%s) - LOCK_MODIFIED ))
  if [ "$LOCK_AGE" -lt "$LOCK_STALE_SECONDS" ]; then
    echo "备份锁尚在宽限期内（${LOCK_AGE}s），本次拒绝并发执行" >&2
    exit 75
  fi
  STALE_LOCK="$SUPPORT_DIR/.backup.lock.stale.$$"
  if ! mv "$LOCK_DIR" "$STALE_LOCK" 2>/dev/null; then
    echo "备份锁状态刚发生变化，本次拒绝并发执行" >&2
    exit 75
  fi
  rm -rf "$STALE_LOCK"
  if ! mkdir "$LOCK_DIR"; then
    echo "另一备份任务已抢先启动，本次拒绝并发执行" >&2
    exit 75
  fi
fi
LOCK_HELD=1
printf '%s\n\n%s\n' "$$" "$LOCK_TOKEN" > "$LOCK_DIR/owner"
LOCK_STARTED="$(process_start_identity "$$")" || LOCK_STARTED=""
[ -n "$LOCK_STARTED" ] || { echo "无法读取备份进程启动标识" >&2; exit 1; }
printf '%s\n%s\n%s\n' "$$" "$LOCK_STARTED" "$LOCK_TOKEN" > "$LOCK_DIR/owner"
STAGE="$(mktemp -d "$STAGE_ROOT/run.XXXXXX")"

echo "[$(date '+%F %T')] 开始备份"

# 1) Node helper 用 node:sqlite backup() 复制 WAL 一致快照，并在隔离区执行
# integrity_check / foreign_key_check；路径与 API 一样从仓库 .env 安全解析，
# 同时复制真实 dataDir 下的 knowledge、images 以及仓库 .env。
"$NODE_BIN" "$HELPER" --prepare "$ROOT" "$STAGE"

# 2) gzip/tar 只读取 Application Support 隔离区，不触碰 TCC 保护的桌面路径。
DB_OUT="$DEST/app-$STAMP.db.gz"
FILES_OUT="$DEST/files-$STAMP.tar.gz"
MANIFEST_OUT="$DEST/complete-$STAMP.json"
PENDING_MARKER="$DEST/.pending-$STAMP"
DB_TMP="$DEST/.app-$STAMP.db.gz.$$"
FILES_TMP="$DEST/.files-$STAMP.tar.gz.$$"
MANIFEST_TMP="$DEST/.complete-$STAMP.json.$$"
gzip -c "$STAGE/app.db" > "$DB_TMP"
gzip -t "$DB_TMP"
# content_json 大 JSON 压缩率高(实测 ~200MB → ~30MB),
# 14 天保留从 ~3GB 降到 ~0.5GB——这台机器磁盘打过 100%,备份不能是下一个引信。
# 恢复:gunzip 后即普通 SQLite 文件。
tar -czf "$FILES_TMP" -C "$STAGE/files" ".env" "data"
tar -tzf "$FILES_TMP" >/dev/null
chmod 600 "$DB_TMP" "$FILES_TMP"
if [ -e "$DB_OUT" ] || [ -L "$DB_OUT" ] || [ -e "$FILES_OUT" ] || [ -L "$FILES_OUT" ] \
   || [ -e "$MANIFEST_OUT" ] || [ -L "$MANIFEST_OUT" ] \
   || [ -e "$PENDING_MARKER" ] || [ -L "$PENDING_MARKER" ]; then
  echo "同时间戳备份已存在，拒绝覆盖: $STAMP" >&2
  exit 1
fi
printf '%s\n' "$STAMP" > "$PENDING_MARKER"
chmod 600 "$PENDING_MARKER"
PUBLISH_CLEANUP_OWNED=1
mv "$DB_TMP" "$DB_OUT"
if [ "${CONTENT_AGENT_BACKUP_TEST_CRASH_AT:-}" = "after_db_publish" ]; then kill -KILL "$$"; fi
mv "$FILES_TMP" "$FILES_OUT"
if [ "${CONTENT_AGENT_BACKUP_TEST_CRASH_AT:-}" = "after_files_publish" ]; then kill -KILL "$$"; fi
GIT_COMMIT=""
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
"$NODE_BIN" "$MANIFEST_HELPER" --write "$STAMP" "$DB_OUT" "$FILES_OUT" "$MANIFEST_TMP" "$GIT_COMMIT"
if [ "${CONTENT_AGENT_BACKUP_TEST_CRASH_AT:-}" = "before_manifest_publish" ]; then kill -KILL "$$"; fi
mv "$MANIFEST_TMP" "$MANIFEST_OUT"
BACKUP_COMMITTED=1
PUBLISH_CLEANUP_OWNED=0
rm -f "$PENDING_MARKER"
chmod 600 "$DB_OUT" "$FILES_OUT" "$MANIFEST_OUT"

DB_SIZE="$(du -h "$DB_OUT" | cut -f1)"
FILES_SIZE="$(du -h "$FILES_OUT" | cut -f1)"
echo "[$(date '+%F %T')] 完成: app-$STAMP.db.gz ($DB_SIZE), files-$STAMP.tar.gz ($FILES_SIZE)"

# 3) 保留策略:自动备份目录只保留最近 KEEP_DAYS 天。
#    (data/backups/ 根下的手工命名快照不受影响。)
#    app-*.db 同时匹配旧的未压缩备份,让存量自然过期。
find "$DEST" -maxdepth 1 -type f -name 'app-*.db' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'app-*.db.gz' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'files-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'complete-*.json' -mtime +"$KEEP_DAYS" -delete

# 4) 异地副本:同盘备份防误删不防盘毁/机器丢失。
if [ -n "${BACKUP_REMOTE:-}" ]; then
  # 不使用 --delete：目标写错时不能让一次备份清空远端已有归档。
  # 远端保留策略由目标端独立执行。
  rsync -a "$DEST/" "$BACKUP_REMOTE"
  echo "[$(date '+%F %T')] 已同步到异地: $BACKUP_REMOTE"
else
  echo "[$(date '+%F %T')] 提醒: 未配置 BACKUP_REMOTE,备份仍与生产同盘同机——请尽快配置异地目标"
fi

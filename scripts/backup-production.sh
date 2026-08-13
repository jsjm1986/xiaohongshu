#!/bin/bash
# content-agent 生产自动备份。
#
# 为什么存在:生产资产只有一份(SQLite 单文件 + data/knowledge/ 盘上原文),
# 此前唯一的"备份"是发布前手工 cp——实测 RPO 累积到 5 天,且活库直拷在写入
# 瞬间可产生不一致快照。本脚本用 VACUUM INTO 做在线一致快照(无需停机,
# 202MB 本地 SSD 秒级),连同知识库文件与 .env 一起归档。
#
# 用法:
#   ./scripts/backup-production.sh            # 手工执行
#   launchd com.content-agent.backup 每日执行  # 定时(见 README 运维节)
# 异地副本:设置 BACKUP_REMOTE(rsync 目标,如 user@host:/backups/content-agent/
# 或挂载的外置盘路径),未设置时脚本会在日志里提醒——同盘备份防误删不防盘毁。
set -euo pipefail

# launchd 拷贝运行时由 CONTENT_AGENT_ROOT 指定仓库(TCC 拒绝执行桌面下的
# 脚本文件,见 health-watch.sh 同款注释);仓库内手工执行自动推导。
ROOT="${CONTENT_AGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DB="$ROOT/data/app.db"
DEST="$ROOT/data/backups/auto"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

mkdir -p "$DEST"

echo "[$(date '+%F %T')] 开始备份"

# 1) 数据库在线一致快照。VACUUM INTO 在读事务里重建目标文件,
#    与 WAL 并存安全,产物是无碎片的独立库。
DB_OUT="$DEST/app-$STAMP.db"
sqlite3 "$DB" "VACUUM INTO '$DB_OUT'"
# 快照完整性自检:损坏的备份比没有备份更危险(给人虚假安全感)。
CHECK="$(sqlite3 -readonly "$DB_OUT" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "[$(date '+%F %T')] 备份完整性校验失败: $CHECK" >&2
  rm -f "$DB_OUT"
  exit 1
fi
# 校验通过后 gzip 落盘:content_json 大 JSON 压缩率高(实测 ~200MB → ~30MB),
# 14 天保留从 ~3GB 降到 ~0.5GB——这台机器磁盘打过 100%,备份不能是下一个引信。
# 恢复:gunzip 后即普通 SQLite 文件。
gzip -f "$DB_OUT"
DB_OUT="$DB_OUT.gz"

# 2) 盘上文件:知识库原文(knowledge_files.storage_path 指向的目录)与 .env。
#    只备份 app.db 的话客户知识库不完整,恢复出来的系统解不开也读不到原文。
FILES_OUT="$DEST/files-$STAMP.tar.gz"
tar -czf "$FILES_OUT" \
  -C "$ROOT" \
  $( [ -d "$ROOT/data/knowledge" ] && echo "data/knowledge" ) \
  $( [ -f "$ROOT/.env" ] && echo ".env" )
chmod 600 "$FILES_OUT"

DB_SIZE="$(du -h "$DB_OUT" | cut -f1)"
FILES_SIZE="$(du -h "$FILES_OUT" | cut -f1)"
echo "[$(date '+%F %T')] 完成: app-$STAMP.db ($DB_SIZE), files-$STAMP.tar.gz ($FILES_SIZE)"

# 3) 保留策略:自动备份目录只保留最近 KEEP_DAYS 天。
#    (data/backups/ 根下的手工命名快照不受影响。)
#    app-*.db 同时匹配旧的未压缩备份,让存量自然过期。
find "$DEST" -name 'app-*.db' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name 'app-*.db.gz' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name 'files-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

# 4) 异地副本:同盘备份防误删不防盘毁/机器丢失。
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rsync -a --delete "$DEST/" "$BACKUP_REMOTE"
  echo "[$(date '+%F %T')] 已同步到异地: $BACKUP_REMOTE"
else
  echo "[$(date '+%F %T')] 提醒: 未配置 BACKUP_REMOTE,备份仍与生产同盘同机——请尽快配置异地目标"
fi

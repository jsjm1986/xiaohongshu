import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useProjects } from '../components/ProjectContext';
import { Badge, EmptyState, Skeleton, useToast } from '../components/Ui';
import { V2Hero } from '../components/V2';
import { api } from '../lib/api';
import { auditActionCopy, auditResourceText } from '../lib/audit-copy';
import { formatDate } from '../lib/utils';
import type { AuditEntry } from '../types';

export function AuditPage() {
  const { currentProject } = useProjects();
  const workspaceId = currentProject?.workspaceId;
  const toast = useToast();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) {
      setEntries([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    api.audit
      .list(workspaceId, 100)
      .then((rows) => {
        if (active) setEntries(rows);
      })
      .catch(() => {
        if (active) {
          setEntries([]);
          toast.push('审计记录加载失败', 'error');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return (
    <div className="page audit-page">
      <V2Hero
        index="10"
        status={<>{currentProject?.name || '当前工作区'} · 操作留痕</>}
        title="操作审计"
        description="关键操作留痕：谁在什么时间对哪个资源做了什么。"
      />
      {loading ? (
        <div className="table-loading"><Skeleton lines={6} /></div>
      ) : !workspaceId ? (
        <EmptyState icon={<ShieldCheck size={24} />} title="请先选择工作区" description="选择一个项目后即可查看该工作区的操作审计记录。" />
      ) : entries.length ? (
        <div className="data-table audit-table">
          <div className="data-table__head">
            <span>时间</span>
            <span>操作人</span>
            <span>动作</span>
            <span>资源</span>
          </div>
          {entries.map((entry) => {
            const action = auditActionCopy(entry.action);
            return (
              <div className="data-table__row" key={entry.id}>
                <span>{formatDate(entry.createdAt, true)}</span>
                <span>{entry.username || '系统'}</span>
                <span className="audit-action">
                  <Badge>{action.label}</Badge>
                  {action.automatic && <em>自动</em>}
                  {/* 标识符是和后端日志、API 对得上的唯一凭据,不能只留中文 */}
                  {action.known && <code>{entry.action}</code>}
                </span>
                {/* 列表里只放短 id;完整 id 放 title,需要时可复制 */}
                <span title={entry.entityId || undefined}>{auditResourceText(entry.entityType, entry.entityId)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={<ShieldCheck size={24} />} title="暂无审计记录" description="该工作区还没有产生关键操作留痕。" />
      )}
    </div>
  );
}

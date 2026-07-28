import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { KnowledgeFile } from '../../types';

/**
 * 审查草稿时对照现有资料。
 *
 * 正文按需加载:一个项目可能有十几个文件,进来就全读会拖慢弹窗打开。
 * 第一个默认展开(所以在拿到列表后主动读它——<details open> 不会触发 onToggle)。
 */
export function OriginalKnowledgePreview({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = (id: string) => {
    setContents((current) => {
      if (current[id] !== undefined) return current;   // 已加载或加载中
      void api.knowledge.get(id)
        .then((file) => setContents((next) => ({ ...next, [id]: file.content || '(空文件)' })))
        .catch(() => setContents((next) => ({ ...next, [id]: '(读取失败)' })));
      return { ...current, [id]: '' };                  // 占位,避免重复请求
    });
  };

  useEffect(() => {
    let cancelled = false;
    setContents({});
    setLoading(true);
    api.knowledge.list(projectId)
      .then((result) => {
        if (cancelled) return;
        setFiles(result.items);
        if (result.items[0]) load(result.items[0].id);
      })
      .catch(() => { if (!cancelled) setFiles([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (loading) return <p className="qc-hint">正在读取现有资料…</p>;
  if (files.length === 0) return <p className="qc-hint">项目里还没有知识文件。</p>;

  return (
    <div className="enrich-original__list">
      {files.map((file, index) => (
        <details key={file.id} open={index === 0} onToggle={() => load(file.id)}>
          <summary>{file.name}</summary>
          <pre className="enrich-original__body">{contents[file.id] || '正在加载…'}</pre>
        </details>
      ))}
    </div>
  );
}

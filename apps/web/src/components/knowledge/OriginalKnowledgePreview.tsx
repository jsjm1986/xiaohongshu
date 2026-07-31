import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../Ui';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
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
  const [contentErrors, setContentErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [openFileIds, setOpenFileIds] = useState<string[]>([]);
  const sequence = useRef(0);
  const requestedFiles = useRef(new Set<string>());

  const load = (id: string, requestSequence = sequence.current) => {
    if (requestedFiles.current.has(id)) return;
    requestedFiles.current.add(id);
    setContents((current) => ({ ...current, [id]: '' }));
    setContentErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    void api.knowledge.get(id)
      .then((file) => {
        if (requestSequence === sequence.current) {
          setContents((current) => ({ ...current, [id]: file.content || '(空文件)' }));
        }
      })
      .catch((error) => {
        if (requestSequence === sequence.current) {
          setContentErrors((current) => ({ ...current, [id]: errorMessage(error, '文件内容读取失败') }));
        }
      });
  };

  const retryFile = (id: string) => {
    requestedFiles.current.delete(id);
    setContents((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    load(id);
  };

  useEffect(() => {
    const requestSequence = ++sequence.current;
    let cancelled = false;
    requestedFiles.current.clear();
    setContents({});
    setContentErrors({});
    setFiles([]);
    setOpenFileIds([]);
    setLoading(true);
    setListError(null);
    api.knowledge.list(projectId)
      .then((result) => {
        if (cancelled || requestSequence !== sequence.current) return;
        setFiles(result.items);
        if (result.items[0]) {
          setOpenFileIds([result.items[0].id]);
          load(result.items[0].id, requestSequence);
        }
      })
      .catch((error) => {
        if (!cancelled && requestSequence === sequence.current) {
          setListError(errorMessage(error, '现有资料列表读取失败'));
        }
      })
      .finally(() => {
        if (!cancelled && requestSequence === sequence.current) setLoading(false);
      });
    return () => {
      cancelled = true;
      sequence.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loadAttempt]);

  if (loading) return <p className="qc-hint">正在读取现有资料…</p>;
  if (listError) {
    return <div className="inline-load-error" role="alert">
      <TriangleAlert size={15} />
      <span><strong>现有资料读取失败</strong><small>{listError}</small></span>
      <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => setLoadAttempt((value) => value + 1)}>重试</Button>
    </div>;
  }
  if (files.length === 0) return <p className="qc-hint">项目里还没有知识文件。</p>;

  return (
    <div className="enrich-original__list">
      {files.map((file, index) => (
        <details
          key={file.id}
          open={openFileIds.includes(file.id)}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setOpenFileIds((current) => open
              ? current.includes(file.id) ? current : [...current, file.id]
              : current.filter((id) => id !== file.id));
            if (open) load(file.id);
          }}
        >
          <summary>{file.name}</summary>
          {contentErrors[file.id]
            ? <div className="inline-load-error" role="alert"><TriangleAlert size={14} /><span><strong>文件内容读取失败</strong><small>{contentErrors[file.id]}</small></span><Button variant="ghost" onClick={() => retryFile(file.id)}>重试</Button></div>
            : <pre className="enrich-original__body">{contents[file.id] || '正在加载…'}</pre>}
        </details>
      ))}
    </div>
  );
}

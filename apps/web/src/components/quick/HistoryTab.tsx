import { useEffect, useState } from 'react';
import { Button, useToast } from '../Ui';
import { api } from '../../lib/api';
import { quickCandidateFields } from '../../lib/quick-generation';
import type { GenerationJob, Project } from '../../types';

interface Props {
  project: Project | null;
  history: GenerationJob[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  setHistory: (h: GenerationJob[]) => void;
}

export function HistoryTab({ project, history, setBusy, fail, setHistory }: Props) {
  const toast = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const projectId = project?.id;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setBusy(true);
    api.generations.list(projectId)
      .then((res) => { if (!cancelled) { setHistory(res.items); setBusy(false); } })
      .catch((e) => { if (!cancelled) fail(e, '加载历史失败'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.push('已复制'); }
    catch { toast.push('复制失败，请手动选择文本', 'error'); }
  };

  return (
    <div className="qc-step">
      <ul className="qc-history-list">
        {history.map((job) => {
          const open = expanded === job.id;
          const views = open ? (job.candidates ?? []).map(quickCandidateFields) : [];
          return (
            <li key={job.id} className="qc-history-item">
              <div className="qc-project-row">
                <strong>{job.topic || '未命名选题'}</strong>
                <small className="qc-hint">· {job.status}{job.createdAt ? ` · ${new Date(job.createdAt).toLocaleString()}` : ''}</small>
                <Button variant="ghost" onClick={() => setExpanded(open ? null : job.id)}>{open ? '收起' : '查看'}</Button>
              </div>
              {open && views.map((v) => (
                <div key={v.id} className="qc-history-candidate">
                  <p><strong>{v.title}</strong></p>
                  <p className="quick-body">{v.body}</p>
                  <div className="qc-project-row">
                    <Button variant="ghost" onClick={() => void copy(`${v.title}\n\n${v.body}`)}>复制</Button>
                    <Button variant="ghost" onClick={() => window.open(api.generations.exportUrl(job.id, v.id, 'markdown'), '_blank')}>导出 Markdown</Button>
                  </div>
                </div>
              ))}
              {open && views.length === 0 && <p className="qc-hint">该次生成没有可展示的候选。</p>}
            </li>
          );
        })}
        {history.length === 0 && <li className="qc-hint">还没有历史产出</li>}
      </ul>
    </div>
  );
}

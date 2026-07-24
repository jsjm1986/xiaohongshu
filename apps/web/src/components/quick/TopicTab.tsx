import { useState } from 'react';
import { Field } from '../Ui';
import { Button } from '../Ui';
import { api } from '../../lib/api';
import type { ContentPreset, Project, TopicOpportunity } from '../../types';

interface Props {
  project: Project | null;
  opportunities: TopicOpportunity[];
  opportunityId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onPickTopic: (id: string, presets: ContentPreset[]) => void;
  onAnalyzed: (opps: TopicOpportunity[]) => void;
}

export function TopicTab({ project, opportunities, opportunityId, busy, setBusy, fail, onPickTopic, onAnalyzed }: Props) {
  const [guidance, setGuidance] = useState('');
  const [showGuidance, setShowGuidance] = useState(false);

  const pick = async (id: string) => {
    if (!project) return;
    setBusy(true);
    try {
      const list = await api.presets.list(project.id);
      onPickTopic(id, list.items);
      setBusy(false);
    } catch (e) { fail(e, '读取预设失败'); }
  };

  const refresh = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const opps = await api.opportunities.refresh(project.id, guidance.trim() || undefined);
      onAnalyzed(opps.items);
      setBusy(false);
    } catch (e) { fail(e, '换一批失败'); }
  };

  return (
    <div className="qc-step">
      <div className="qc-topic-list">
        {opportunities.map((o) => (
          <button key={o.id} type="button" className={`qc-topic${o.id === opportunityId ? ' selected' : ''}`} onClick={() => void pick(o.id)}>
            <span>{o.title}</span>
            {o.id === opportunityId && <small className="qc-topic__hint">已选 · 进入配置</small>}
          </button>
        ))}
        {opportunities.length === 0 && <p className="qc-hint">没有可用选题，试试换一批。</p>}
      </div>

      <details className="qc-advanced" open={showGuidance} onToggle={(e) => setShowGuidance((e.target as HTMLDetailsElement).open)}>
        <summary>换一批（可选填引导词）</summary>
        <div className="qc-advanced-grid">
          <Field label="引导词（可留空）">
            <textarea value={guidance} rows={2} maxLength={600} placeholder="例如：多一些针对术后恢复期的选题" onChange={(e) => setGuidance(e.target.value)} />
          </Field>
        </div>
      </details>
      <Button variant="secondary" loading={busy} onClick={() => void refresh()}>换一批选题</Button>
    </div>
  );
}

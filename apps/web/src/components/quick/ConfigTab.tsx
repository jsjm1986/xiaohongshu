import { useEffect, useState } from 'react';
import { RefreshCw, Star } from 'lucide-react';
import { Button, Field } from '../Ui';
import { autoApproveAndGenerate, quickCandidateFields, type QuickCandidateView } from '../../lib/quick-generation';
import type { CommentRichnessLevel, SimpleSettingOverrides } from '../../lib/simple-generation';
import type { ContentPreset, Project } from '../../types';

const STAGES: Array<{ id: string; title: string }> = [
  { id: 'discovering', title: '刚开始了解' },
  { id: 'collecting', title: '正在收集信息' },
  { id: 'comparing', title: '正在比较选择' },
  { id: 'hesitating', title: '已了解但犹豫' },
  { id: 'ready', title: '准备采取下一步' },
];

const ENTRIES: Array<{ id: string; title: string }> = [
  { id: 'search', title: '主动搜索' },
  { id: 'recommendation', title: '推荐流情景（来源未核实）' },
  { id: 'profile', title: '主页浏览' },
  { id: 'return_visit', title: '再次访问' },
];

const RICHNESS: Array<{ id: CommentRichnessLevel; title: string }> = [
  { id: 'restrained', title: '克制' },
  { id: 'balanced', title: '均衡（默认）' },
  { id: 'dense', title: '丰富' },
];

interface Props {
  project: Project | null;
  opportunityId: string;
  presets: ContentPreset[];
  presetId: string | undefined;
  overrides: SimpleSettingOverrides;
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  setPresetId: (id: string | undefined) => void;
  setOverrides: (o: SimpleSettingOverrides) => void;
  onGenerated: (results: QuickCandidateView[]) => void;
}

const GEN_STAGES = ['解析选题与已确认信息', '组织内容结构', '生成初稿', '质检与合规校验'];

export function ConfigTab({ project, opportunityId, presets, presetId, overrides, busy, setBusy, fail, setPresetId, setOverrides, onGenerated }: Props) {
  const [stageIdx, setStageIdx] = useState(0);

  useEffect(() => {
    if (!busy) { setStageIdx(0); return; }
    const timer = window.setInterval(() => {
      setStageIdx((i) => Math.min(i + 1, GEN_STAGES.length - 1));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [busy]);

  const patch = (p: Partial<SimpleSettingOverrides>) => setOverrides({ ...overrides, ...p });

  const generate = async () => {
    if (!project || !opportunityId) return;
    setBusy(true);
    try {
      const job = await autoApproveAndGenerate({ project, opportunityId, presetId, overrides });
      const results = (job.candidates ?? []).map(quickCandidateFields);
      onGenerated(results);
      setBusy(false);
    } catch (e) { fail(e, '生成失败'); }
  };

  return (
    <div className="qc-step">
      <div className="qc-preset-list" role="radiogroup" aria-label="内容预设">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={presetId === p.id}
            className={`qc-preset-card${presetId === p.id ? ' selected' : ''}`}
            onClick={() => setPresetId(p.id)}
          >
            <strong>{p.name}{p.isDefault && <Star size={12} fill="currentColor" />}</strong>
            <small>{p.description}</small>
          </button>
        ))}
      </div>

      <details className="qc-advanced">
        <summary>精确制导（可选）· 留空则依据知识库与选题自动生成</summary>
        <div className="qc-advanced-grid">
          <Field label="读者阶段">
            <select value={overrides.audienceStage ?? ''} onChange={(e) => patch({ audienceStage: e.target.value || undefined })}>
              <option value="">默认</option>
              {STAGES.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </Field>
          <Field label="内容入口">
            <select value={overrides.entryPoint ?? ''} onChange={(e) => patch({ entryPoint: e.target.value || undefined })}>
              <option value="">默认</option>
              {ENTRIES.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </Field>
          <Field label="评论信息丰富度">
            <select value={overrides.commentRichness ?? ''} onChange={(e) => patch({ commentRichness: (e.target.value || undefined) as CommentRichnessLevel | undefined })}>
              <option value="">默认</option>
              {RICHNESS.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </Field>
          <Field label="城市">
            <input list="qc-cities" value={overrides.city ?? ''} onChange={(e) => patch({ city: e.target.value || undefined })} />
            <datalist id="qc-cities">{(project?.cities ?? []).map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="医生"><input value={overrides.doctor ?? ''} onChange={(e) => patch({ doctor: e.target.value || undefined })} /></Field>
          <Field label="必含词"><input value={overrides.mustInclude ?? ''} onChange={(e) => patch({ mustInclude: e.target.value || undefined })} /></Field>
          <Field label="禁用词"><input value={overrides.forbidden ?? ''} onChange={(e) => patch({ forbidden: e.target.value || undefined })} /></Field>
        </div>
      </details>

      {busy && (
        <div className="qc-progress" role="status">
          <RefreshCw size={15} className="spin" />
          <span>正在生成:{GEN_STAGES[stageIdx]}…</span>
          <small>请勿离开或重复点击</small>
          <i className="qc-progress__track"><b /></i>
        </div>
      )}
      <Button loading={busy} disabled={!presetId || busy} onClick={() => void generate()}>生成文案</Button>
    </div>
  );
}

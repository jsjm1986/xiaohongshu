import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, Field, Modal, useToast } from '../Ui';
import { api, ApiError } from '../../lib/api';
import { autoApproveAndGenerate, quickCandidateFields, type QuickCandidateView } from '../../lib/quick-generation';
import { progressStageText } from '../../lib/quick-progress';
import { buildPresetValuesFromOverrides } from '../../lib/preset-save';
import { writeLocalPresets } from '../../lib/presets';
import type { CommentRichnessLevel, SimpleSettingOverrides } from '../../lib/simple-generation';
import type { ContentPreset, Project } from '../../types';
import { QuickImagePicker } from './QuickImagePicker';

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
  imageAssetIds: string[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  setPresetId: (id: string | undefined) => void;
  setPresets: (presets: ContentPreset[]) => void;
  setOverrides: (o: SimpleSettingOverrides) => void;
  setImageAssetIds: (ids: string[]) => void;
  onGenerated: (results: QuickCandidateView[], jobId: string) => void;
}

export function ConfigTab({ project, opportunityId, presets, presetId, overrides, imageAssetIds, busy, setBusy, fail, setPresetId, setPresets, setOverrides, setImageAssetIds, onGenerated }: Props) {
  const toast = useToast();
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [presetWorking, setPresetWorking] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState({ name: '', description: '' });

  const patch = (p: Partial<SimpleSettingOverrides>) => setOverrides({ ...overrides, ...p });
  const currentPreset = presets.find((p) => p.id === presetId);

  const generate = async () => {
    if (!project || !opportunityId) return;
    setBusy(true);
    setProgress(undefined);
    try {
      const job = await autoApproveAndGenerate({
        project,
        opportunityId,
        presetId,
        overrides,
        imageAssetIds,
        onProgress: (j) => setProgress(j.progress),
      });
      const results = (job.candidates ?? []).map(quickCandidateFields);
      onGenerated(results, job.id);
      setBusy(false);
    } catch (e) { fail(e, '生成失败'); }
  };

  const makeDefault = async () => {
    if (!project || !presetId) return;
    setPresetWorking(true);
    try {
      await api.presets.setDefault(project.id, presetId);
      setPresets(presets.map((p) => ({ ...p, isDefault: p.id === presetId })));
      toast.push(`「${currentPreset?.name ?? ''}」已设为默认预设`);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : '设为默认失败', 'error');
    } finally {
      setPresetWorking(false);
    }
  };

  const saveAsPreset = async () => {
    if (!project || !presetDraft.name.trim()) return;
    setPresetWorking(true);
    const input = {
      name: presetDraft.name.trim(),
      description: presetDraft.description.trim() || '项目自定义内容预设',
      values: { ...(currentPreset?.values ?? {}), ...buildPresetValuesFromOverrides(overrides) },
      isDefault: false,
    };
    try {
      const created = await api.presets.create(project.id, input);
      setPresets([...presets, created]);
      setPresetId(created.id);
      toast.push(`已存为预设「${created.name}」`);
    } catch (e) {
      // 照 GeneratorPage 的模式:4xx 校验错误直接提示;服务不可用(网络/5xx/404)落 localStorage
      if (e instanceof ApiError && e.status !== 404 && e.status < 500) {
        toast.push(e.message || '预设未通过服务端校验', 'error');
      } else {
        const created: ContentPreset = {
          id: `local-${Date.now()}`,
          projectId: project.id,
          source: 'project',
          ...input,
          createdAt: new Date().toISOString(),
        };
        const next = [...presets, created];
        setPresets(next);
        writeLocalPresets(project.id, next.filter((p) => p.source === 'project'));
        setPresetId(created.id);
        toast.push('服务器不可用，预设仅保存在这台浏览器', 'info');
      }
    } finally {
      setPresetWorking(false);
      setSaveOpen(false);
      setPresetDraft({ name: '', description: '' });
    }
  };

  const removePreset = async () => {
    if (!project || !currentPreset || currentPreset.source !== 'project') return;
    setPresetWorking(true);
    let removed = true;
    try {
      await api.presets.remove(project.id, currentPreset.id);
      toast.push(`预设「${currentPreset.name}」已删除`);
    } catch (e) {
      if (e instanceof ApiError && e.status !== 404 && e.status < 500) {
        removed = false;
        toast.push(e.message || '无法删除预设', 'error');
      } else {
        toast.push('服务器不可用，只删除了这台浏览器的副本', 'info');
      }
    }
    if (removed) {
      const next = presets.filter((p) => p.id !== currentPreset.id);
      setPresets(next);
      writeLocalPresets(project.id, next.filter((p) => p.source === 'project'));
      setPresetId(next.find((p) => p.isDefault)?.id ?? next[0]?.id);
    }
    setPresetWorking(false);
    setDeleteOpen(false);
  };

  return (
    <div className="qc-step">
      <Field label="内容预设" required>
        <select value={presetId ?? ''} onChange={(e) => setPresetId(e.target.value || undefined)}>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isDefault ? '（默认）' : ''}</option>)}
        </select>
      </Field>
      <div className="qc-preset-actions">
        <Button variant="ghost" disabled={!presetId || currentPreset?.isDefault || busy || presetWorking} onClick={() => void makeDefault()}>设为默认</Button>
        <Button variant="ghost" disabled={busy || presetWorking} onClick={() => setSaveOpen(true)}>存为预设</Button>
        {currentPreset?.source === 'project' && (
          <Button variant="ghost" disabled={busy || presetWorking} onClick={() => setDeleteOpen(true)}>删除</Button>
        )}
      </div>

      <details className="qc-advanced">
        <summary>高级设置（可留空，全部有默认值）</summary>
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

      {project && (
        <details className="qc-advanced">
          <summary>源素材图（可选，提升贴合度）</summary>
          <QuickImagePicker project={project} busy={busy} setBusy={setBusy} fail={fail} selectedIds={imageAssetIds} onChange={setImageAssetIds} />
        </details>
      )}

      {!opportunityId && <p className="qc-hint">先在左侧选一个选题</p>}
      {busy && (
        <div className="qc-progress" role="status">
          <RefreshCw size={15} className="spin" />
          <span>正在生成:{progressStageText(progress)}…</span>
          <small>{progress !== undefined ? `${progress}% · ` : ''}请勿离开或重复点击</small>
          <i className="qc-progress__track"><b style={{ width: `${progress ?? 0}%`, animation: 'none' }} /></i>
        </div>
      )}
      <Button loading={busy} disabled={!presetId || busy} onClick={() => void generate()}>生成文案</Button>

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="存为预设"
        description="以当前选中预设为基础，叠加高级设置里的覆盖项；城市、医生、必含/禁用词属于项目信息，不会写进预设。"
        footer={<><Button variant="ghost" onClick={() => setSaveOpen(false)}>取消</Button><Button loading={presetWorking} disabled={!presetDraft.name.trim()} onClick={() => void saveAsPreset()}>保存</Button></>}
      >
        <div className="qc-modal-form">
          <Field label="预设名称" required>
            <input value={presetDraft.name} onChange={(e) => setPresetDraft({ ...presetDraft, name: e.target.value })} placeholder="例：口语化短帖" />
          </Field>
          <Field label="描述">
            <input value={presetDraft.description} onChange={(e) => setPresetDraft({ ...presetDraft, description: e.target.value })} placeholder="可留空" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`删除预设「${currentPreset?.name ?? ''}」？`}
        description="删除后不可恢复；内置预设不可删除。已生成的内容不受影响。"
        footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" loading={presetWorking} onClick={() => void removePreset()}>确认删除</Button></>}
      >
        <p className="qc-hint">仅删除该项目自定义预设。</p>
      </Modal>
    </div>
  );
}

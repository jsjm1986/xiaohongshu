import { useEffect, useState } from 'react';
import { Button, Field, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { autoApproveAndGenerate, quickCandidateFields, type QuickCandidateView } from '../../lib/quick-generation';
import { InlineProgress } from './InlineProgress';
import { buildPresetValuesFromOverrides } from '../../lib/preset-save';
import { quotaExhausted, type QuotaSnapshot } from '../../lib/quota-view';
import { SUPPORT_HINT } from '../../lib/support';
import type { CommentRichnessLevel, SimpleSettingOverrides } from '../../lib/simple-generation';
import type { RetryPublishingContract } from '../../lib/quick-recipe';
import type { ContentPreset, Project } from '../../types';
import { QuickImagePicker } from './QuickImagePicker';
import { PresetCards } from './PresetCards';

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
  publishing: RetryPublishingContract;
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** 仅「正在生成文案」为真;收藏/归档等普通操作只动 busy,不驱动生成进度条 */
  generating: boolean;
  setGenerating: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  setPresetId: (id: string | undefined) => void;
  setPresets: (presets: ContentPreset[]) => void;
  setOverrides: (o: SimpleSettingOverrides) => void;
  setImageAssetIds: (ids: string[]) => void;
  onGenerated: (results: QuickCandidateView[], jobId: string) => void;
  /** 批量态:由选题池「配置批量生成」进入,右栏改为多选预设 + 批量提交 */
  batchMode: boolean;
  batchPresetIds: string[];
  onToggleBatchPreset: (id: string) => void;
  batchTopicCount: number;
  onSubmitBatch: () => void;
  onCancelBatch: () => void;
}

export function ConfigTab({ project, opportunityId, presets, presetId, overrides, imageAssetIds, publishing, busy, setBusy, generating, setGenerating, fail, setPresetId, setPresets, setOverrides, setImageAssetIds, onGenerated, batchMode, batchPresetIds, onToggleBatchPreset, batchTopicCount, onSubmitBatch, onCancelBatch }: Props) {
  const toast = useToast();
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [presetWorking, setPresetWorking] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState({ name: '', description: '' });
  const [presetLoadError, setPresetLoadError] = useState<string | null>(null);
  const [presetLoading, setPresetLoading] = useState(false);
  const [presetLoadAttempt, setPresetLoadAttempt] = useState(0);
  /**
   * 额度:生成入口自己也要知道。
   *
   * 实测缺口——额度用尽时总览页和账户页都红着提示并给了客服微信,而创作区(用户
   * 真正点「生成文案」的地方)全页不提额度二字,点下去只会撞上一个 403 红条。
   * 付费产品不该让人这样发现自己没额度了。
   */
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);

  const patch = (p: Partial<SimpleSettingOverrides>) => setOverrides({ ...overrides, ...p });
  const currentPreset = presets.find((p) => p.id === presetId);

  // 预设原先只在 TopicTab.pick()（点选题）里加载，所以进创作区还没选选题时
  // 预设区是空的，只剩「存为预设」，用户看不到 10 个内置预设也无从下手。
  // 这里按需自载一次：仅当项目已选且列表为空时拉，选题仍会带回自己那份。
  const projectId = project?.id;
  const presetsEmpty = presets.length === 0;
  useEffect(() => {
    if (!projectId || !presetsEmpty) {
      setPresetLoadError(null);
      setPresetLoading(false);
      return;
    }
    let cancelled = false;
    setPresetLoadError(null);
    setPresetLoading(true);
    api.presets.list(projectId)
      .then((list) => {
        if (cancelled) return;
        setPresets(list.items);
        setPresetId(list.items.find((p) => p.isDefault)?.id ?? list.items[0]?.id);
      })
      .catch((error) => {
        if (!cancelled) setPresetLoadError(errorMessage(error, '读取预设失败'));
      })
      .finally(() => {
        if (!cancelled) setPresetLoading(false);
      });
    return () => { cancelled = true; };
    // setPresets/setPresetId 是壳的 setState 包装，每次渲染新引用，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, presetsEmpty, presetLoadAttempt]);

  // 额度只在进区时拉一次:它的变化粒度是「每次生成 +1」,不必轮询;生成成功后
  // 重拉一次(见 generate 末尾),让余量当场跟上。
  const workspaceId = project?.workspaceId;
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    api.settings.quota(workspaceId)
      .then((snapshot) => { if (!cancelled) setQuota(snapshot); })
      .catch(() => { /* 静默:额度读不到不该锁死生成——那会把"看不见"升级成"不能用" */ });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const noQuota = quotaExhausted(quota);

  const generate = async () => {
    if (!project || !opportunityId) return;
    setBusy(true);
    setGenerating(true);
    setProgress(undefined);
    try {
      const job = await autoApproveAndGenerate({
        project,
        opportunityId,
        presetId,
        overrides,
        imageAssetIds,
        publishing,
        onProgress: (j) => setProgress(j.progress),
      });
      const results = (job.candidates ?? []).map(quickCandidateFields);
      onGenerated(results, job.id);
      setBusy(false);
      setGenerating(false);
      // 刚扣掉一次额度,重拉一次让余量当场跟上(否则要切区回来才更新)
      if (workspaceId) {
        api.settings.quota(workspaceId)
          .then(setQuota)
          .catch(() => { /* 静默:显示旧余量比报错更不打扰 */ });
      }
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
      toast.push(errorMessage(e, '设为默认失败'), 'error');
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
      setSaveOpen(false);
      setPresetDraft({ name: '', description: '' });
    } catch (e) {
      toast.push(errorMessage(e, '保存预设失败'), 'error');
    } finally {
      setPresetWorking(false);
    }
  };

  const removePreset = async () => {
    if (!project || !currentPreset || currentPreset.source !== 'project') return;
    setPresetWorking(true);
    try {
      await api.presets.remove(project.id, currentPreset.id);
      const next = presets.filter((p) => p.id !== currentPreset.id);
      setPresets(next);
      setPresetId(next.find((p) => p.isDefault)?.id ?? next[0]?.id);
      toast.push(`预设「${currentPreset.name}」已删除`);
      setDeleteOpen(false);
    } catch (e) {
      toast.push(errorMessage(e, '删除预设失败'), 'error');
    } finally {
      setPresetWorking(false);
    }
  };

  const replayTopologyLabel = publishing.publishingTopology === 'institution_owned'
    ? '机构账号说明'
    : publishing.publishingTopology === 'confirmed_individual_author'
      ? '真实作者事实'
      : publishing.publishingTopology === 'creative_scenario'
        ? '自动用户情景'
        : undefined;

  return (
    <div className="qc-step">
      {replayTopologyLabel && (
        <div className="qc-replay-contract" role="status">
          <strong>正在复用原发布视角：{replayTopologyLabel}</strong>
          <small>这是“再来一篇同款”的冻结合同；主动改选新选题或重新分析后会自动清除。</small>
        </div>
      )}
      {batchMode ? (
        <>
          <div className="qc-batch-head">
            <strong>批量生成 · 已选 {batchTopicCount} 个选题</strong>
            <Button variant="ghost" disabled={busy} onClick={onCancelBatch}>退出批量</Button>
          </div>
          <Field label="选版本（预设可多选）" required>
            <PresetCards presets={presets} mode="multi" selectedIds={batchPresetIds} onToggle={onToggleBatchPreset} disabled={busy} />
          </Field>
          <p className="qc-hint">{batchTopicCount} 选题 × {batchPresetIds.length} 预设 = {batchTopicCount * batchPresetIds.length} 篇；下面的高级设置与源图对整批生效。</p>
        </>
      ) : (
        <>
          <Field label="内容预设" required>
            <PresetCards
              presets={presets}
              mode="single"
              selectedId={presetId}
              onSelect={(id) => setPresetId(id)}
              onSave={() => setSaveOpen(true)}
              disabled={busy || presetWorking}
            />
          </Field>
          {presetLoadError && (
            <div className="inline-load-error" role="alert">
              <span><strong>预设加载失败</strong><small>{presetLoadError}</small></span>
              <Button variant="ghost" loading={presetLoading} onClick={() => setPresetLoadAttempt((value) => value + 1)}>重试</Button>
            </div>
          )}
          <div className="qc-preset-actions">
            <Button variant="ghost" disabled={!presetId || currentPreset?.isDefault || busy || presetWorking} onClick={() => void makeDefault()}>设为默认</Button>
            {currentPreset?.source === 'project' && (
              <Button variant="ghost" disabled={busy || presetWorking} onClick={() => setDeleteOpen(true)}>删除</Button>
            )}
          </div>
        </>
      )}

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

      {!batchMode && !opportunityId && <p className="qc-hint">先在左侧选一个选题</p>}
      {/* 只有真的在生成才显示这条;用 busy 会让收藏/归档等操作也弹出「请勿离开」 */}
      <InlineProgress active={generating} progress={progress} />
      {/* 主操作放进 action bar:qc-step 是纵向 flex,按钮作为直接子元素会被拉满整栏,
          放宽后实测拉成 940px 的巨带。这里靠左收窄,并把前置条件说明并排放在右边。 */}
      {/* 额度用尽:在按钮**之前**说清,而不是让用户点下去撞 403 */}
      {noQuota && (
        <p className="qc-hint qc-hint--error">额度已用完，无法继续生成。{SUPPORT_HINT}</p>
      )}
      <div className="qc-actions">
        {batchMode ? (
          <Button loading={busy} disabled={busy || noQuota || batchTopicCount === 0 || batchPresetIds.length === 0} onClick={onSubmitBatch}>
            提交批量生成 · 共 {batchTopicCount * batchPresetIds.length} 篇
          </Button>
        ) : (
          // 必须同时门控 opportunityId:generate() 第一行就 if (!opportunityId) return,
          // 少了它按钮是亮的但点下去静默无反应。
          <Button loading={generating} disabled={!presetId || !opportunityId || busy || noQuota} onClick={() => void generate()}>生成文案</Button>
        )}
      </div>

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

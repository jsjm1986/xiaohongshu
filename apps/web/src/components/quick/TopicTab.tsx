import { useEffect, useState } from 'react';
import { Star, Archive, Trash2, X, Lightbulb, SearchX } from 'lucide-react';
import { Button, Field, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import { filterOpportunities, type OpportunityFilter } from '../../lib/quick-channel-state';
import type { ContentPreset, Project, PromptTemplate, TopicOpportunity } from '../../types';

interface Props {
  project: Project | null;
  opportunities: TopicOpportunity[];
  opportunityId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onPickTopic: (id: string, presets: ContentPreset[]) => void;
  onAnalyzed: (opps: TopicOpportunity[]) => void;
  setOpportunities: (opps: TopicOpportunity[]) => void;
  onOpportunityGone: (id: string) => void;
  /** 空态「去知识库」入口(四区结构下由壳提供,跳转②知识库) */
  onGoKnowledge?: () => void;
}

const FILTER_CHIPS: Array<{ key: OpportunityFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'collected', label: '已收藏' },
  { key: 'archived', label: '已归档' },
];

export function TopicTab({ project, opportunities, opportunityId, busy, setBusy, fail, onPickTopic, onAnalyzed, setOpportunities, onOpportunityGone, onGoKnowledge }: Props) {
  const toast = useToast();
  const [guidance, setGuidance] = useState('');
  const [showGuidance, setShowGuidance] = useState(false);
  const [filter, setFilter] = useState<OpportunityFilter>('all');
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [confirmDeleteOpp, setConfirmDeleteOpp] = useState<TopicOpportunity | null>(null);
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  const [tplLabel, setTplLabel] = useState('');

  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) { setTemplates([]); return; }
    let cancelled = false;
    api.promptTemplates.list(projectId)
      .then((list) => { if (!cancelled) setTemplates(list); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  // 自补足:老项目进工作区时选题池可能未加载,挂载时若为空且非 busy 拉一次(静默)
  useEffect(() => {
    if (!projectId || opportunities.length > 0 || busy) return;
    let cancelled = false;
    api.opportunities.list(projectId)
      .then((r) => { if (!cancelled) setOpportunities(r.items); })
      .catch(() => { /* 静默回落:保持空态 */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const visible = filterOpportunities(opportunities, filter);

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

  const replaceOpp = (updated: TopicOpportunity) =>
    setOpportunities(opportunities.map((x) => (x.id === updated.id ? updated : x)));

  const toggleCollect = async (o: TopicOpportunity) => {
    if (!project) return;
    setBusy(true);
    try {
      const next = o.collectionStatus === 'collected' ? 'active' : 'collected';
      replaceOpp(await api.opportunities.setCollection(project.id, o.id, next));
      toast.push(next === 'collected' ? '已收藏' : '已取消收藏');
      setBusy(false);
    } catch (e) { fail(e, '更新收藏失败'); }
  };

  const toggleArchive = async (o: TopicOpportunity) => {
    if (!project) return;
    setBusy(true);
    try {
      const next = o.collectionStatus === 'archived' ? 'active' : 'archived';
      replaceOpp(await api.opportunities.setCollection(project.id, o.id, next));
      if (next === 'archived') onOpportunityGone(o.id);
      toast.push(next === 'archived' ? '已归档' : '已恢复');
      setBusy(false);
    } catch (e) { fail(e, '更新归档失败'); }
  };

  const doDeleteOpp = async () => {
    if (!project || !confirmDeleteOpp) return;
    setBusy(true);
    try {
      await api.opportunities.remove(project.id, confirmDeleteOpp.id);
      setOpportunities(opportunities.filter((x) => x.id !== confirmDeleteOpp.id));
      onOpportunityGone(confirmDeleteOpp.id);
      setConfirmDeleteOpp(null);
      toast.push('已删除选题');
      setBusy(false);
    } catch (e) { fail(e, '删除选题失败'); }
  };

  const saveTemplate = async () => {
    if (!project || !tplLabel.trim() || !guidance.trim()) return;
    setBusy(true);
    try {
      await api.promptTemplates.create(project.id, tplLabel.trim(), guidance.trim());
      setTemplates(await api.promptTemplates.list(project.id));
      setTplLabel('');
      setShowSaveTpl(false);
      toast.push('已存为模板');
      setBusy(false);
    } catch (e) { fail(e, '保存模板失败'); }
  };

  const removeTemplate = async (id: string) => {
    if (!project) return;
    setBusy(true);
    try {
      await api.promptTemplates.remove(project.id, id);
      setTemplates((cur) => cur.filter((t) => t.id !== id));
      toast.push('模板已删除');
      setBusy(false);
    } catch (e) { fail(e, '删除模板失败'); }
  };

  return (
    <div className="qc-step">
      <div className="chip-group qc-filter-chips">
        {FILTER_CHIPS.map((c) => (
          <button key={c.key} type="button" className={`chip${filter === c.key ? ' chip--active' : ''}`} onClick={() => setFilter(c.key)}>{c.label}</button>
        ))}
      </div>

      <div className="qc-topic-list">
        {visible.map((o) => (
          <div key={o.id} className={`qc-topic${o.id === opportunityId ? ' selected' : ''}`}>
            <button type="button" className="qc-topic__main" onClick={() => void pick(o.id)}>
              <span>{o.title}</span>
              {o.id === opportunityId && <small className="qc-topic__hint">已选</small>}
            </button>
            <span className="qc-topic__ops">
              <Button variant="ghost" icon={<Star size={13} />} disabled={busy} onClick={() => void toggleCollect(o)}>
                {o.collectionStatus === 'collected' ? '取消收藏' : '收藏'}
              </Button>
              <Button variant="ghost" icon={<Archive size={13} />} disabled={busy} onClick={() => void toggleArchive(o)}>
                {o.collectionStatus === 'archived' ? '恢复' : '归档'}
              </Button>
              <Button variant="ghost" icon={<Trash2 size={13} />} disabled={busy} onClick={() => setConfirmDeleteOpp(o)}>删除</Button>
            </span>
          </div>
        ))}
        {visible.length === 0 && (
          opportunities.length === 0 ? (
            <div className="qc-empty">
              <span className="qc-empty__icon"><Lightbulb size={18} /></span>
              还没有选题:先去知识库分析,再回来「换一批」。
              {onGoKnowledge && <Button variant="secondary" onClick={onGoKnowledge}>去知识库</Button>}
            </div>
          ) : (
            <div className="qc-empty">
              <span className="qc-empty__icon"><SearchX size={18} /></span>
              该筛选下没有选题。
            </div>
          )
        )}
      </div>

      <details className="qc-advanced" open={showGuidance} onToggle={(e) => setShowGuidance((e.target as HTMLDetailsElement).open)}>
        <summary>换一批（可选填引导词）</summary>
        <div className="qc-advanced-grid">
          <Field label="引导词（可留空）">
            <textarea value={guidance} rows={2} maxLength={600} placeholder="例如：多一些针对术后恢复期的选题" onChange={(e) => setGuidance(e.target.value)} />
          </Field>
          <div className="qc-project-row">
            <Button variant="ghost" disabled={busy || !guidance.trim()} onClick={() => setShowSaveTpl(true)}>存为模板</Button>
          </div>
          {templates.length > 0 && (
            <div className="qc-tpl-list">
              {templates.map((t) => (
                <span key={t.id} className="qc-tpl">
                  <button type="button" className="qc-tpl__use" title={t.guidance} onClick={() => setGuidance(t.guidance)}>{t.label}</button>
                  <button type="button" className="qc-tpl__del" aria-label={`删除模板「${t.label}」`} disabled={busy} onClick={() => void removeTemplate(t.id)}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      </details>
      <Button variant="secondary" loading={busy} onClick={() => void refresh()}>换一批选题</Button>

      <Modal open={confirmDeleteOpp !== null} title="删除选题" description={`确定删除「${confirmDeleteOpp?.title ?? ''}」？`} onClose={() => setConfirmDeleteOpp(null)}
        footer={<><Button variant="ghost" onClick={() => setConfirmDeleteOpp(null)}>取消</Button><Button loading={busy} onClick={() => void doDeleteOpp()}>确认删除</Button></>}>
        <p className="qc-hint">删除后不可恢复；若它是当前选中的选题，已产生的配置与结果会一并清空。</p>
      </Modal>

      <Modal open={showSaveTpl} title="存为模板" description="把当前引导词保存下来，下次一键填入。" onClose={() => setShowSaveTpl(false)}
        footer={<><Button variant="ghost" onClick={() => setShowSaveTpl(false)}>取消</Button><Button loading={busy} disabled={!tplLabel.trim()} onClick={() => void saveTemplate()}>保存</Button></>}>
        <div className="qc-modal-form">
          <Field label="模板名">
            <input value={tplLabel} onChange={(e) => setTplLabel(e.target.value)} placeholder="如：术后恢复方向" />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

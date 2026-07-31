import { useEffect, useRef, useState } from 'react';
import { Star, Archive, Trash2, X, Lightbulb, SearchX, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, Field, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { filterOpportunities, type OpportunityFilter } from '../../lib/quick-channel-state';
import { topicCardFields } from '../../lib/topic-card';
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
  /** 批量:已勾选的选题 id */
  checkedIds: string[];
  onToggleCheck: (id: string) => void;
  onConfigBatch: () => void;
  /** 空态「去知识库」入口(四区结构下由壳提供,跳转②知识库) */
  onGoKnowledge?: () => void;
}

const FILTER_CHIPS: Array<{ key: OpportunityFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'collected', label: '已收藏' },
  { key: 'archived', label: '已归档' },
];

export function TopicTab({ project, opportunities, opportunityId, busy, setBusy, fail, onPickTopic, onAnalyzed, setOpportunities, onOpportunityGone, checkedIds, onToggleCheck, onConfigBatch, onGoKnowledge }: Props) {
  const toast = useToast();
  const [guidance, setGuidance] = useState('');
  const [showGuidance, setShowGuidance] = useState(false);
  const [filter, setFilter] = useState<OpportunityFilter>('all');
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [topicLoading, setTopicLoading] = useState(false);
  const [topicLoadError, setTopicLoadError] = useState<string | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);
  const [topicLoadAttempt, setTopicLoadAttempt] = useState(0);
  const [templateLoadAttempt, setTemplateLoadAttempt] = useState(0);
  const [confirmDeleteOpp, setConfirmDeleteOpp] = useState<TopicOpportunity | null>(null);
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  const [tplLabel, setTplLabel] = useState('');
  const topicLoadSequence = useRef(0);
  const templateLoadSequence = useRef(0);
  const activeProjectId = useRef(project?.id);
  activeProjectId.current = project?.id;

  const projectId = project?.id;
  useEffect(() => {
    const sequence = ++templateLoadSequence.current;
    setTemplates([]);
    setTemplateLoadError(null);
    if (!projectId) { setTemplateLoading(false); return; }
    setTemplateLoading(true);
    api.promptTemplates.list(projectId)
      .then((list) => {
        if (sequence === templateLoadSequence.current && activeProjectId.current === projectId) setTemplates(list);
      })
      .catch((error) => {
        if (sequence === templateLoadSequence.current && activeProjectId.current === projectId) {
          setTemplateLoadError(errorMessage(error, '方向模板读取失败'));
        }
      })
      .finally(() => {
        if (sequence === templateLoadSequence.current && activeProjectId.current === projectId) setTemplateLoading(false);
      });
    return () => { templateLoadSequence.current += 1; };
  }, [projectId, templateLoadAttempt]);

  // 自补足：老项目进入工作区时共享选题池可能尚未加载。失败必须保留为
  // 明确错误，不能把网络故障展示成“还没有选题”。
  useEffect(() => {
    const sequence = ++topicLoadSequence.current;
    setTopicLoadError(null);
    if (!projectId) { setTopicLoading(false); return; }
    if (opportunities.length > 0 && topicLoadAttempt === 0) {
      setTopicLoading(false);
      return;
    }
    setTopicLoading(true);
    api.opportunities.list(projectId)
      .then((result) => {
        if (sequence === topicLoadSequence.current && activeProjectId.current === projectId) {
          setOpportunities(result.items);
        }
      })
      .catch((error) => {
        if (sequence === topicLoadSequence.current && activeProjectId.current === projectId) {
          setTopicLoadError(errorMessage(error, '选题池读取失败'));
        }
      })
      .finally(() => {
        if (sequence === topicLoadSequence.current && activeProjectId.current === projectId) setTopicLoading(false);
      });
    return () => { topicLoadSequence.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, topicLoadAttempt]);

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
    const targetProjectId = project.id;
    setBusy(true);
    try {
      const opps = await api.opportunities.refresh(targetProjectId, guidance.trim() || undefined);
      if (activeProjectId.current !== targetProjectId) return;
      onAnalyzed(opps.items);
      setTopicLoadError(null);
      setGuidance('');
      setBusy(false);
    } catch (e) {
      if (activeProjectId.current === targetProjectId) fail(e, '换一批失败');
    }
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
    const targetProjectId = project.id;
    setBusy(true);
    try {
      const created = await api.promptTemplates.create(targetProjectId, tplLabel.trim(), guidance.trim());
      if (activeProjectId.current !== targetProjectId) return;
      setTemplates((current) => [created, ...current.filter((template) => template.id !== created.id)]);
      setTemplateLoadError(null);
      setTplLabel('');
      setShowSaveTpl(false);
      toast.push('已存为模板');
      setBusy(false);
    } catch (e) {
      if (activeProjectId.current === targetProjectId) fail(e, '保存模板失败');
    }
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
      {topicLoadError && (
        <div className="inline-load-error" role="alert">
          <TriangleAlert size={15} />
          <span><strong>选题池读取失败</strong><small>{topicLoadError}{opportunities.length > 0 ? '。当前显示的是上次已加载数据。' : ''}</small></span>
          <Button variant="ghost" icon={<RefreshCw size={14} />} loading={topicLoading} onClick={() => setTopicLoadAttempt((value) => value + 1)}>重试</Button>
        </div>
      )}
      <div className="chip-group qc-filter-chips">
        {FILTER_CHIPS.map((c) => (
          <button key={c.key} type="button" className={`chip${filter === c.key ? ' chip--active' : ''}`} onClick={() => setFilter(c.key)}>{c.label}</button>
        ))}
      </div>

      <div className="qc-topic-list">
        {visible.map((o) => {
          const card = topicCardFields(o);
          return (
          <div key={o.id} className={`qc-topic${o.id === opportunityId ? ' selected' : ''}`}>
            <div className="qc-topic__head">
            <input
              type="checkbox"
              className="qc-topic__check"
              checked={checkedIds.includes(o.id)}
              disabled={busy}
              onChange={() => onToggleCheck(o.id)}
              aria-label={`勾选「${o.title}」批量生成`}
            />
            <button type="button" className="qc-topic__main" onClick={() => void pick(o.id)}>
              {card.rankText && <em className="qc-topic__rank">{card.rankText}</em>}
              <span title={o.title}>{o.title}</span>
              {o.id === opportunityId && <small className="qc-topic__hint">已选</small>}
            </button>
            {/* 操作位只留图标:选题池宽 360px,三个带文字的按钮会占满整行、把标题挤成 0 宽。
                名称移到 title/aria-label,可读性与无障碍不丢。 */}
            <span className="qc-topic__ops">
              {(() => {
                const collectLabel = o.collectionStatus === 'collected' ? '取消收藏' : '收藏';
                const archiveLabel = o.collectionStatus === 'archived' ? '恢复' : '归档';
                return (
                  <>
                    <Button variant="ghost" icon={<Star size={13} />} disabled={busy} title={collectLabel} aria-label={`${collectLabel}「${o.title}」`} onClick={() => void toggleCollect(o)} />
                    <Button variant="ghost" icon={<Archive size={13} />} disabled={busy} title={archiveLabel} aria-label={`${archiveLabel}「${o.title}」`} onClick={() => void toggleArchive(o)} />
                    <Button variant="ghost" icon={<Trash2 size={13} />} disabled={busy} title="删除" aria-label={`删除「${o.title}」`} onClick={() => setConfirmDeleteOpp(o)} />
                  </>
                );
              })()}
            </span>
            </div>

            {card.rationale && <p className="qc-topic__reason" title={card.rationale}>{card.rationale}</p>}

            {(card.stageLabel || card.entryLabel || card.evidenceCount > 0 || card.boundaryCount > 0) && (
              <div className="qc-topic__chips">
                {card.stageLabel && <span className="qc-topic__chip">读者：{card.stageLabel}</span>}
                {card.entryLabel && <span className="qc-topic__chip">来源：{card.entryLabel}</span>}
                {card.evidenceCount > 0 && <span className="qc-topic__chip">证据 {card.evidenceCount}</span>}
                {card.boundaryCount > 0 && <span className="qc-topic__chip">边界 {card.boundaryCount}</span>}
              </div>
            )}

            {/* 分数区:显示数字就必须同屏标注「未校准」——后端把这些分标为
                ordinal_noncausal_heuristic,不是效果预测。见 topic-card.ts。 */}
            {(card.scoreText || card.metrics.length > 0) && (
              <div className="qc-topic__scores">
                {card.scoreText && (
                  <span className="qc-topic__score" title="服务端排序分,未校准,仅用于人工复核排序">
                    排序分 <b>{card.scoreText}</b>
                  </span>
                )}
                {card.metrics.map((m) => (
                  <span
                    key={m.key}
                    className={`qc-topic__metric${m.inverse ? ' qc-topic__metric--inverse' : ''}`}
                    title={m.inverse ? `${m.label} ${m.value}（越低越好）` : `${m.label} ${m.value}`}
                  >
                    {m.label}
                    <i className="qc-topic__bar"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, m.value)) * 100)}%` }} /></i>
                    <b>{m.value}</b>
                  </span>
                ))}
                <span className="qc-topic__uncal">未校准 · 仅供人工排序参考，非效果预测</span>
              </div>
            )}
          </div>
          );
        })}
        {topicLoading && opportunities.length === 0 && <div className="qc-empty" role="status">正在读取选题池…</div>}
        {!topicLoading && !topicLoadError && visible.length === 0 && (
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

      {checkedIds.length > 0 && (
        <div className="qc-batch-bar">
          <span>已选 {checkedIds.length} 个选题</span>
          <Button disabled={busy} onClick={onConfigBatch}>配置批量生成</Button>
        </div>
      )}

      <details className="qc-advanced" open={showGuidance} onToggle={(e) => setShowGuidance((e.target as HTMLDetailsElement).open)}>
        <summary>换一批（可选填引导词）</summary>
        <div className="qc-advanced-grid">
          <Field label="引导词（可留空）">
            <textarea value={guidance} rows={2} maxLength={600} placeholder="例如：多一些针对术后恢复期的选题" onChange={(e) => setGuidance(e.target.value)} />
          </Field>
          {templateLoadError && (
            <div className="inline-load-error" role="alert">
              <TriangleAlert size={14} />
              <span><strong>方向模板读取失败</strong><small>{templateLoadError}</small></span>
              <Button variant="ghost" loading={templateLoading} onClick={() => setTemplateLoadAttempt((value) => value + 1)}>重试</Button>
            </div>
          )}
          {templateLoading && !templateLoadError && <small className="qc-hint" role="status">正在读取方向模板…</small>}
          {!showSaveTpl ? (
            <div className="qc-project-row">
              <Button variant="ghost" disabled={busy || !guidance.trim()} onClick={() => setShowSaveTpl(true)}>存为模板</Button>
            </div>
          ) : (
            <div className="qc-tpl-inline">
              <input
                autoFocus
                value={tplLabel}
                onChange={(e) => setTplLabel(e.target.value)}
                placeholder="模板名，如：术后恢复方向"
                aria-label="模板名"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setShowSaveTpl(false); setTplLabel(''); }
                  if (e.key === 'Enter' && tplLabel.trim()) void saveTemplate();
                }}
              />
              <Button loading={busy} disabled={!tplLabel.trim()} onClick={() => void saveTemplate()}>保存</Button>
              <Button variant="ghost" onClick={() => { setShowSaveTpl(false); setTplLabel(''); }}>取消</Button>
            </div>
          )}
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
    </div>
  );
}

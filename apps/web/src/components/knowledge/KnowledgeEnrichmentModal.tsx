import { useEffect, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { Button, Field, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import { canMerge, hasUnsavedEdits, toDraftItems, toMergeItems } from '../../lib/enrich-flow';
import { draftShortfallNote, enrichSavedHint, enrichTargetOptions } from '../../lib/enrich-types';
import type { DraftItem, ModalStep } from '../../lib/enrich-types';
import { EnrichmentDraftList } from './EnrichmentDraftList';
import { OriginalKnowledgePreview } from './OriginalKnowledgePreview';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  /** 保存成功后回调,让调用方刷新文件列表与缺口。 */
  onComplete: () => void;
  /**
   * 只补这几条缺口。缺省 = 整批起草。
   * 缺口池里单条精补时传一个 id;标题也会跟着变,免得用户以为在跑全量。
   */
  gapIds?: readonly string[];
  /**
   * 可选:已有的知识文件,用来选「保存到哪一份」。
   *
   * 缺口池入口没有文件列表(该页不拉 knowledge.list),那里不显示选择器,
   * 沿用后端算出的默认目标——不为了 UI 一致去加一条网络往返。
   */
  files?: ReadonlyArray<{ name: string; category?: string; version?: number }>;
}

const TITLES: Record<ModalStep, string> = {
  drafting: 'AI 正在起草',
  editing: 'AI 补充建议',
  merging: '正在合并',
  preview: '预览合并结果',
  saving: '正在保存',
};

const LOADING_TEXT: Record<'drafting' | 'merging' | 'saving', string> = {
  drafting: 'AI 正在根据现有资料起草补充内容',
  merging: '正在把补充内容融合进知识库',
  saving: '正在保存新版本',
};

export function KnowledgeEnrichmentModal({ open, projectId, onClose, onComplete, gapIds, files }: Props) {
  const [step, setStep] = useState<ModalStep>('drafting');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [preview, setPreview] = useState('');
  const [targetFile, setTargetFile] = useState('');
  const [baseFileId, setBaseFileId] = useState<string | null>(null);
  const [isNewFile, setIsNewFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 起草条数少于待补总数时的说明(超出单次上限,或模型漏答)。 */
  const [shortfall, setShortfall] = useState<string | null>(null);
  /** 正文读不出来的知识文件。模型没看到它们,整理结果会受影响。 */
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const toast = useToast();

  // 每次打开都重新起草。草稿不落库,复用上次的会让用户以为编辑被保存了。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep('drafting');
    setItems([]);
    setPreview('');
    // 目标文件也要归零:上次选的是「并入 A」,这次重开还留着就会悄悄写到 A 上。
    setTargetFile('');
    setBaseFileId(null);
    setError(null);
    setShortfall(null);
    setUnreadable([]);
    api.intelligence.enrich.draft(projectId, gapIds)
      .then((result) => {
        if (cancelled) return;
        setItems(toDraftItems(result.gaps));
        setShortfall(draftShortfallNote(result));
        setUnreadable(result.unreadableFiles ?? []);
        setStep('editing');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 后端的报错文案本来就是写给用户的(「当前没有需要补充的信息缺口」),
        // 直接展示,不在前端二次翻译——两边各写一套必然对不上。
        setError(e instanceof Error ? e.message : '起草失败');
      });
    return () => { cancelled = true; };
    // gapIds 是数组,直接进依赖会因每次渲染新引用而反复重跑;用 join 取其内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, gapIds?.join(',')]);

  const merge = async () => {
    setStep('merging');
    setError(null);
    try {
      /*
       * 目标文件要在这一步就定下来。merge 会读目标文件的原文、把补充融进去,预览就是
       * 那份融合结果;只在 save 时改目标,等于把融了 A 原文的文档存成 B 的新版本,
       * B 自己的内容就在最新版里消失了(后端 :212 防的正是这种覆盖)。
       * 空串 = 用户没选,沿用后端的默认目标(知识地图)。
       */
      const result = await api.intelligence.enrich.merge(projectId, {
        items: toMergeItems(items),
        targetFile: targetFile || undefined,
      });
      setPreview(result.preview);
      setTargetFile(result.targetFile);
      setBaseFileId(result.baseFileId);
      setIsNewFile(result.isNewFile);
      setStep('preview');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '合并失败');
      setStep('editing');   // 退回编辑态,用户的修改还在
    }
  };

  const save = async () => {
    setStep('saving');
    setError(null);
    try {
      await api.intelligence.enrich.save(projectId, { content: preview, targetFile, baseFileId });
      /*
       * 用户逐条确认/修改后保存的版本按业务定义属于已知事实。资料变化会让旧分析
       * 失效，提示用户重新分析以更新知识地图和缺口，但不承诺所有缺口必然消失。
       */
      toast.push(enrichSavedHint());
      onComplete();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败');
      setStep('preview');
    }
  };

  const close = () => {
    if (step === 'editing' && hasUnsavedEdits(items)
      && !window.confirm('有改过但未提交的补充内容,关闭后会丢失。确定关闭吗?')) return;
    onClose();
  };

  const footer = () => {
    if (step === 'editing') {
      return (
        <>
          <Button variant="ghost" onClick={close}>稍后再说</Button>
          <Button onClick={() => void merge()} disabled={!canMerge(items)}>生成合并版</Button>
        </>
      );
    }
    if (step === 'preview') {
      return (
        <>
          <Button variant="ghost" onClick={() => setStep('editing')}>返回修改</Button>
          <Button onClick={() => void save()}>确认保存</Button>
        </>
      );
    }
    // 起草失败时也要给一个出口,否则用户只能点右上角的 ×
    if (error) return <Button variant="ghost" onClick={close}>关闭</Button>;
    return undefined;
  };

  const loading = step === 'drafting' || step === 'merging' || step === 'saving';

  // 去重规则在 enrichTargetOptions 里,连同两个入口列表语义不同的原因一起说明。
  const fileNames = files ? enrichTargetOptions(files) : null;

  return (
    <Modal
      open={open}
      size="wide"
      title={TITLES[step]}
      description={step === 'editing' ? 'AI 基于现有资料起草,请逐条审查后再合并' : undefined}
      onClose={close}
      footer={footer()}
    >
      {error && (
        <div className="enrich-error" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {loading && !error && (
        <div className="enrich-loading">
          <span className="spinner" aria-hidden="true" />
          <p>{LOADING_TEXT[step]}</p>
          {step !== 'saving' && <small>通常需要 30-60 秒</small>}
        </div>
      )}

      {step === 'editing' && !error && (
        <div className="enrich-editing">
          <div className="enrich-drafts">
            <p className="enrich-hint">
              已有资料由 AI 整理，缺少的项目事实由你填写。请逐条核实：准确的点<strong>“确认内容属实”</strong>，
              有偏差的修改，不知道的可以暂不处理。只有确认或填写过的明确事实才能写入知识库，
              保存后将作为“已知事实”参与分析与生成。
            </p>
            {/*
              起草条数少于按钮上写的待补数时必须说清楚。
              入口按钮写的是真实待补总数,而单次起草有上限,不说明的话用户看到
              「补充 17 项」点进来只有 15 条,少了哪两条无从得知。
            */}
            {shortfall && (
              <p className="enrich-notice" role="status">
                <Info size={15} aria-hidden="true" />
                <span>{shortfall}</span>
              </p>
            )}
            {unreadable.length > 0 && (
              <p className="enrich-warning" role="alert">
                <TriangleAlert size={15} aria-hidden="true" />
                <span>
                  有 {unreadable.length} 份资料读不出来(
                  <code>{unreadable.join('、')}</code>
                  ),这次起草<strong>没有参考它们</strong>。
                  请确认文件是否还在,必要时重新上传后再起草。
                </span>
              </p>
            )}
            {/*
              目标文件必须可选。API 一直支持 targetFile,前端只回显不给选,结果是
              33.6 KB 原始资料没被触碰,补充内容独立成 2.9 KB 的 INDEX.md——
              用户的资料和 AI 的补充各自躺着,没有合流。
              放在合并之前:合并要读目标文件的原文,选完再合并才对得上。
              没有文件列表时(缺口池入口)不渲染,沿用后端算出的默认目标。
            */}
            {fileNames && (
              <Field label="保存到" hint="默认合并进知识地图；也可以并入你已有的某份资料">
                <select value={targetFile} onChange={(event) => setTargetFile(event.target.value)}>
                  {/* 缺省项:让后端去算默认目标,前端不重复那套判断 */}
                  <option value="">知识地图（默认，没有就新建）</option>
                  {fileNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </Field>
            )}
            <EnrichmentDraftList items={items} onChange={setItems} />
          </div>
          <aside className="enrich-original">
            <h4>现有资料</h4>
            <OriginalKnowledgePreview projectId={projectId} />
          </aside>
        </div>
      )}

      {step === 'preview' && (
        <div className="enrich-preview">
          <p className="enrich-notice">
            <Info size={15} aria-hidden="true" />
            <span>
              这是融合后的完整文档,将{isNewFile ? '新建 ' : '保存为 '}
              <code>{targetFile}</code>
              {isNewFile ? '' : ' 的新版本(旧版本仍可查看)'}。
              保存后这份资料的证据类型是「已知事实」，表示你已核实并确认最终内容。
            </span>
          </p>
          <p className="enrich-notice">
            <Info size={15} aria-hidden="true" />
            <span>
              点击确认保存表示你对这份最终 Markdown 做事实背书。
              保存后请重新分析知识库，系统会基于新版已知事实更新知识地图和信息缺口。
            </span>
          </p>
          <pre className="enrich-preview__body">{preview}</pre>
        </div>
      )}
    </Modal>
  );
}

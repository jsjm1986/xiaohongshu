import { useEffect, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { Button, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import { canMerge, hasUnsavedEdits, toDraftItems, toMergeItems } from '../../lib/enrich-flow';
import type { DraftItem, ModalStep } from '../../lib/enrich-types';
import { EnrichmentDraftList } from './EnrichmentDraftList';
import { OriginalKnowledgePreview } from './OriginalKnowledgePreview';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  /** 保存成功后回调,让知识库页刷新文件列表与缺口。 */
  onComplete: () => void;
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

export function KnowledgeEnrichmentModal({ open, projectId, onClose, onComplete }: Props) {
  const [step, setStep] = useState<ModalStep>('drafting');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [preview, setPreview] = useState('');
  const [targetFile, setTargetFile] = useState('');
  const [isNewFile, setIsNewFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // 每次打开都重新起草。草稿不落库,复用上次的会让用户以为编辑被保存了。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep('drafting');
    setItems([]);
    setPreview('');
    setError(null);
    api.intelligence.enrich.draft(projectId)
      .then((result) => {
        if (cancelled) return;
        setItems(toDraftItems(result.gaps));
        setStep('editing');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 后端的报错文案本来就是写给用户的(「当前没有需要补充的信息缺口」),
        // 直接展示,不在前端二次翻译——两边各写一套必然对不上。
        setError(e instanceof Error ? e.message : '起草失败');
      });
    return () => { cancelled = true; };
  }, [open, projectId]);

  const merge = async () => {
    setStep('merging');
    setError(null);
    try {
      const result = await api.intelligence.enrich.merge(projectId, { items: toMergeItems(items) });
      setPreview(result.preview);
      setTargetFile(result.targetFile);
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
      await api.intelligence.enrich.save(projectId, { content: preview, targetFile });
      // 「建议重新分析」不是客套:补充内容要经过一次分析才会进生成语料。
      toast.push('知识库已更新,建议重新分析以让补充内容生效');
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
              以下内容由 AI 推断,<strong>不是已核实的事实</strong>。请逐条审查:
              准确的直接保留,有偏差的改掉,不需要的删除。
            </p>
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
              保存后这份资料的证据类型是「猜想」,核实过再改成「已知事实」。
            </span>
          </p>
          <pre className="enrich-preview__body">{preview}</pre>
        </div>
      )}
    </Modal>
  );
}

import { useState } from 'react';
import { CheckCircle2, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '../Ui';
import {
  beginEdit,
  cancelEdit,
  commitEdit,
  confidenceLabel,
  confirmDraft,
  deleteDraft,
  restoreDraft,
} from '../../lib/enrich-flow';
import type { DraftItem } from '../../lib/enrich-types';

export function DraftItemCard({ item, onChange }: { item: DraftItem; onChange: (updated: DraftItem) => void }) {
  const [text, setText] = useState(item.userContent ?? item.aiDraft);

  if (item.status === 'deleted') {
    return (
      <article className="draft-item draft-item--deleted">
        <h4>{item.title}</h4>
        <span className="draft-item__note">已移除,不会写入知识库</span>
        <button type="button" className="draft-item__action" onClick={() => onChange(restoreDraft(item))}>
          <RotateCcw size={13} aria-hidden="true" /> 恢复
        </button>
      </article>
    );
  }

  const label = confidenceLabel(item.confidence);

  return (
    <article className={`draft-item draft-item--${item.confidence}`}>
      <header className="draft-item__header">
        <h4>{item.title}</h4>
        <Badge tone={label.tone}>{label.text}</Badge>
      </header>
      {item.question && <p className="draft-item__question">{item.question}</p>}

      {item.status === 'editing' ? (
        <>
          <label className="draft-item__label" htmlFor={`draft-${item.gapId}`}>补充内容</label>
          <textarea
            id={`draft-${item.gapId}`}
            className="draft-item__textarea"
            value={text}
            rows={8}
            onChange={(event) => setText(event.target.value)}
          />
          <footer className="draft-item__actions">
            <button
              type="button"
              className="draft-item__action"
              onClick={() => { setText(item.userContent ?? item.aiDraft); onChange(cancelEdit(item)); }}
            >
              取消
            </button>
            <button
              type="button"
              className="draft-item__action draft-item__action--primary"
              onClick={() => onChange(commitEdit(item, text))}
            >
              保存修改
            </button>
          </footer>
        </>
      ) : (
        <>
          <pre className="draft-item__body">{item.userContent ?? item.aiDraft}</pre>
          <footer className="draft-item__actions">
            {item.status === 'confirmed' && (
              <span className="draft-item__confirmed">
                <CheckCircle2 size={14} aria-hidden="true" /> 已确认
              </span>
            )}
            {item.status === 'edited' && <span className="draft-item__note">已修改</span>}
            <button type="button" className="draft-item__action" onClick={() => onChange(deleteDraft(item))}>
              <Trash2 size={13} aria-hidden="true" /> 删除
            </button>
            <button type="button" className="draft-item__action" onClick={() => onChange(beginEdit(item))}>
              <Pencil size={13} aria-hidden="true" /> 修改
            </button>
            {item.status !== 'confirmed' && (
              <button
                type="button"
                className="draft-item__action draft-item__action--primary"
                onClick={() => onChange(confirmDraft(item))}
              >
                确认无误
              </button>
            )}
          </footer>
        </>
      )}
    </article>
  );
}

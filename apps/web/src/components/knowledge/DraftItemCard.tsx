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
  isResolvedKnowledge,
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

  if (item.knowledgeAction === 'ask_user') {
    return (
      <article className="draft-item draft-item--low">
        <header className="draft-item__header">
          <h4>{item.title}</h4>
          <Badge tone="danger">需要你提供事实</Badge>
        </header>
        {item.question && (
          <p className="draft-item__question">{item.question}</p>
        )}
        {item.knowledgeReason && (
          <p className="draft-item__note">{item.knowledgeReason}</p>
        )}
        <label className="draft-item__label" htmlFor={`draft-${item.gapId}`}>你的明确答案</label>
        <textarea
          id={`draft-${item.gapId}`}
          className="draft-item__textarea"
          value={text}
          rows={6}
          placeholder="填写你确认过的项目事实；不知道可以暂不处理"
          onChange={(event) => setText(event.target.value)}
        />
        <footer className="draft-item__actions">
          {item.status === 'edited' && (
            <span className="draft-item__confirmed"><CheckCircle2 size={14} aria-hidden="true" /> 已填写并确认</span>
          )}
          <button type="button" className="draft-item__action" onClick={() => onChange(deleteDraft(item))}>
            <Trash2 size={13} aria-hidden="true" /> 暂不处理
          </button>
          <button
            type="button"
            className="draft-item__action draft-item__action--primary"
            disabled={!isResolvedKnowledge(text)}
            onClick={() => onChange({ ...item, status: 'edited', userContent: text })}
          >
            保存并确认
          </button>
        </footer>
      </article>
    );
  }

  return (
    <article className={`draft-item draft-item--${item.confidence}`}>
      <header className="draft-item__header">
        <h4>{item.title}</h4>
        <Badge tone={label.tone}>{label.text}</Badge>
      </header>
      {item.question && <p className="draft-item__question">{item.question}</p>}

      {item.knowledgeReason && (
        <p className="draft-item__reason">
          <span>整理原因：</span>
          <span>{item.knowledgeReason}</span>
        </p>
      )}
      {item.sources.length > 0 && (
        <details className="draft-item__sources">
          <summary>
            <span>查看资料依据（</span>
            <span>{item.sources.length}</span>
            <span> 处）</span>
          </summary>
          {item.sources.map((source) => (
            <blockquote key={source.evidenceId}>
              <strong>{source.filename}{source.heading ? ` · ${source.heading}` : ''}</strong>
              <span>{source.excerpt}</span>
            </blockquote>
          ))}
        </details>
      )}

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
            {item.status === 'edited' && <span className="draft-item__confirmed">已修改并确认</span>}
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
                确认内容属实
              </button>
            )}
          </footer>
        </>
      )}
    </article>
  );
}

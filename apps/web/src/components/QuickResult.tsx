import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button, useToast } from './Ui';
import { quickCandidateToMarkdown, type QuickCandidateView } from '../lib/quick-generation';
import { firstValidationIssueLabel } from '../lib/validation-labels';

async function copyText(text: string, toast: ReturnType<typeof useToast>) {
  try {
    await navigator.clipboard.writeText(text);
    toast.push('已复制');
  } catch {
    toast.push('复制失败，请手动选择文本', 'error');
  }
}

function CopyCard({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  const toast = useToast();
  return (
    <section className="quick-card">
      <header>
        <h3>{title}</h3>
        <Button variant="ghost" icon={<Copy size={14} />} onClick={() => void copyText(text, toast)}>复制</Button>
      </header>
      <div className="quick-card__body">{children}</div>
    </section>
  );
}

function commentsCopyText(view: QuickCandidateView): string {
  const body = view.comments
    .map((c) => `Q: ${c.question}\nA: ${c.answer}${c.boundary ? `\n边界: ${c.boundary}` : ''}${c.nextStep ? `\n下一步: ${c.nextStep}` : ''}`)
    .join('\n\n');
  return view.commentDisclaimer ? `免责声明: ${view.commentDisclaimer}\n\n${body}` : body;
}

/** 单个候选的完整内容卡族:标题/正文/标签/图片简报/可发布首评/问答话术(含免责与未展开缺口)。结果页与历史页共用。 */
export function QuickCandidateCards({ view }: { view: QuickCandidateView }) {
  return (
    <>
      <CopyCard title="标题" text={view.title}><p>{view.title}</p></CopyCard>
      <CopyCard title="正文" text={view.body}><p className="quick-body">{view.body}</p></CopyCard>
      {view.tags.length > 0 && (
        <CopyCard title="标签" text={view.tags.map((t) => `#${t}`).join(' ')}>
          <div className="quick-tag-row">{view.tags.map((t) => <span key={t} className="quick-tag">#{t}</span>)}</div>
        </CopyCard>
      )}
      {view.imageBrief && (
        <CopyCard title="图片简报" text={view.imageBrief}><p>{view.imageBrief}</p></CopyCard>
      )}
      {view.commentOwnedFirstComment && (
        <CopyCard title="可发布首评" text={view.commentOwnedFirstComment}><p>{view.commentOwnedFirstComment}</p></CopyCard>
      )}
      {view.comments.length > 0 && (
        <CopyCard title="问答话术" text={commentsCopyText(view)}>
          {view.commentDisclaimer && <p className="qc-disclaimer">{view.commentDisclaimer}</p>}
          <ul className="quick-qa">
            {view.comments.map((c, i) => (
              <li key={`${c.question}-${i}`}>
                <strong>Q: {c.question}</strong>
                <p>A: {c.answer}</p>
                {c.boundary && <small>边界：{c.boundary}</small>}
                {c.nextStep && <small>下一步：{c.nextStep}</small>}
                {(c.followUps ?? []).map((f, j) => (
                  <div key={`${f.question}-${j}`} className="quick-followup"><span>追问：{f.question}</span><span>回应：{f.answer}</span></div>
                ))}
              </li>
            ))}
          </ul>
          {view.commentUncoveredGaps?.length ? (
            <small className="qc-uncovered">评论区未展开：{view.commentUncoveredGaps.join('、')}</small>
          ) : null}
        </CopyCard>
      )}
    </>
  );
}

export function QuickResult({ candidates, onRegenerate, onPickAnotherTopic, onRevise, revisingId }: {
  candidates: QuickCandidateView[];
  onRegenerate?: () => void;
  onPickAnotherTopic?: () => void;
  onRevise?: (candidateId: string, instruction: string) => Promise<void>;
  revisingId?: string | null;
}) {
  const toast = useToast();
  const [active, setActive] = useState(0);
  const [instruction, setInstruction] = useState('');
  const view = candidates[active];
  if (!view) return null;

  const submitRevise = () => {
    if (!onRevise) return;
    const text = instruction.trim();
    if (!text) return;
    // 错误由 onRevise 内部 toast;仅成功时清空输入
    void onRevise(view.id, text).then(() => setInstruction('')).catch(() => undefined);
  };

  return (
    <div className="quick-result">
      <div className="quick-tabs">
        {candidates.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className={i === active ? 'active' : ''}
            onClick={() => setActive(i)}
          >
            {c.label || `版本${i + 1}`}
            {!c.publishable && <i className="quick-tab-dot" title="该版本未通过可发布校验" />}
          </button>
        ))}
      </div>

      {!view.publishable && (
        <p className="qc-issue-line">
          {firstValidationIssueLabel(view.issueCodes) ?? '未通过校验，可换个预设或用修改意见重生成'}
        </p>
      )}

      <QuickCandidateCards view={view} />

      {onRevise && (
        <details className="qc-revise">
          <summary>按意见修改</summary>
          <textarea
            rows={3}
            value={instruction}
            placeholder="例：标题再口语化一点"
            onChange={(e) => setInstruction(e.target.value)}
          />
          <Button
            variant="secondary"
            loading={revisingId === view.id}
            disabled={!instruction.trim() || Boolean(revisingId)}
            onClick={submitRevise}
          >
            {revisingId === view.id ? '修改中…' : '提交修改'}
          </Button>
        </details>
      )}

      {(onRegenerate || onPickAnotherTopic) && (
        <div className="quick-result__actions">
          <Button variant="secondary" icon={<Copy size={15} />} onClick={() => void copyText(quickCandidateToMarkdown(view), toast)}>复制全部</Button>
          {onRegenerate && <Button variant="ghost" onClick={onRegenerate}>再来一批</Button>}
          {onPickAnotherTopic && <Button variant="ghost" onClick={onPickAnotherTopic}>换个选题</Button>}
        </div>
      )}
    </div>
  );
}

import { Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, useToast } from './Ui';
import { candidateClipboardText } from '../lib/clipboard-truth';
import { deliveryReadiness } from '../lib/delivery-readiness';
import { clampCandidateIndex } from '../lib/note-view';
import { isFreshCandidateBatch, quickCandidateToMarkdown, type QuickCandidateView } from '../lib/quick-generation';
import { CommentPlanCard } from './quick/CommentPlanCard';
import { DeploymentPlanCard } from './quick/DeploymentPlanCard';
import { NoteCard } from './quick/NoteCard';
import { ValidationVerdict } from './quick/ValidationVerdict';

async function copyText(text: string, toast: ReturnType<typeof useToast>) {
  try {
    await navigator.clipboard.writeText(text);
    toast.push('已复制');
  } catch {
    toast.push('复制失败，请手动选择文本', 'error');
  }
}

export function QuickResult({ candidates, projectName, onRegenerate, onPickAnotherTopic, onRevise, revisingId }: {
  candidates: QuickCandidateView[];
  /** 发布账号名,用于仿真笔记与机构答复的署名 */
  projectName?: string;
  onRegenerate?: () => void;
  onPickAnotherTopic?: () => void;
  onRevise?: (candidateId: string, instruction: string) => Promise<void>;
  revisingId?: string | null;
}) {
  const toast = useToast();
  const [active, setActive] = useState(0);
  const [instruction, setInstruction] = useState('');
  const previousIdsRef = useRef<readonly string[]>([]);
  // 候选数组换身份时分两种情况:「再来一批」(id 全新)回到第一版并清掉旧改稿
  // 意见;「改稿」(保序替换一个候选,其余 id 不变)保持当前版本——曾经这里
  // 无条件重置,在第 3 版上提交修改会被跳回第 1 版,看不到自己的修改结果。
  // 候选变少时收敛下标,避免 candidates[active] 越界白屏。
  useEffect(() => {
    const previousIds = previousIdsRef.current;
    previousIdsRef.current = candidates.map((candidate) => candidate.id);
    if (isFreshCandidateBatch(previousIds, previousIdsRef.current)) {
      setActive(0);
      setInstruction('');
      return;
    }
    setActive((current) => clampCandidateIndex(current, candidates.length));
  }, [candidates]);
  const view = candidates[active] ?? candidates[0];
  if (!view) return null;
  /**
   * 创作区与阅读页同一道交付门:未通过机械硬门禁的候选,任何复制入口都不开放。
   * 原来这里没传 copyEnabled(缺省 true),生成完当场复制成了唯一绕过门禁的出口。
   */
  const deliverable = deliveryReadiness(view.validation) === 'publishable';

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

      {/* 结论块与产出区共用 ValidationVerdict:原来这里按数组顺序取首条可识别 code
          当结论,实测 129 个未通过候选里 110 个因此把 warning 当成了结论。 */}
      <ValidationVerdict validation={view.validation} deliverable={deliverable} />

      {/* 生成完先给「发出去长什么样」,与阅读页同一个 NoteCard——原来这里是
          标题/正文/标签/图片简报各一张字段卡,同一份内容在 SaaS 里长两个样,
          而用户先看到的偏偏是字段清单那套。字段级复制没丢:NoteCard 自带逐字段复制。 */}
      <NoteCard candidate={view} job={{}} projectName={projectName} copyEnabled={deliverable} />

      {/* 评论核对:边界要求/下一步核验这些编排字段原来平铺在「问答话术」卡里,
          换成仿真预览后预览区不再展示它们(它们是写给生成器的内部指令,不是发布文案)。
          运营核对仍然要用,所以在这里补上与阅读页同一张核对卡,不然就是净减一项能力。 */}
      <CommentPlanCard candidate={view} />

      {/* 发布执行方案:生成完当场就能看到「下一步做什么」,不必先去产出区 */}
      <DeploymentPlanCard candidate={view} />

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
          <Button
            variant="secondary"
            icon={<Copy size={15} />}
            disabled={!deliverable}
            title={deliverable ? undefined : '该版本未通过可发布校验，不能复制或导出'}
            onClick={() => void copyText(
              candidateClipboardText(view.validation, quickCandidateToMarkdown(view)),
              toast,
            )}
          >
            复制全部
          </Button>
          {onRegenerate && <Button variant="ghost" onClick={onRegenerate}>再来一批</Button>}
          {onPickAnotherTopic && <Button variant="ghost" onClick={onPickAnotherTopic}>换个选题</Button>}
        </div>
      )}
    </div>
  );
}

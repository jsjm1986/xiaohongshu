import { Check, ChevronDown, Info, ListPlus, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import {
  emptyAuthorFact,
  type AuthorFactCategory,
  type PublishingTopologyDraft,
} from "../../lib/publishing-topology";
import { Badge, Button, Field } from "../Ui";

const categoryOptions: Array<{ value: AuthorFactCategory; label: string }> = [
  { value: "current_state", label: "当前状态" },
  { value: "intent", label: "用户打算" },
  { value: "constraint", label: "现实限制" },
  { value: "project_contact", label: "已发生项目接触" },
  { value: "purchase", label: "已购买" },
  { value: "service_completion", label: "已完成服务" },
  { value: "recovery", label: "恢复经历" },
  { value: "outcome", label: "结果经历" },
];

export function PublishingTopologyControl({
  projectId,
  value,
  onChange,
  compact = false,
}: {
  projectId: string;
  value: PublishingTopologyDraft;
  onChange: (value: PublishingTopologyDraft) => void;
  compact?: boolean;
}) {
  const [organizing, setOrganizing] = useState(false);
  const [organizeError, setOrganizeError] = useState("");
  const creative = value.topology === "creative_scenario";
  const institution = value.topology === "institution_owned";
  const individual = value.topology === "confirmed_individual_author";
  const completeFactCount = value.facts.filter((fact) => fact.statement.trim()).length;
  const factsReady = value.facts.length > 0 && completeFactCount === value.facts.length;
  const reviewCount = value.facts.filter((fact) => fact.needsReview).length;

  const selectTopology = (topology: PublishingTopologyDraft["topology"]) => {
    setOrganizeError("");
    // 切回机构视角时保留尚未提交的用户素材，避免误点造成录入丢失；提交层会忽略它们。
    onChange({ ...value, topology, confirmed: false });
  };
  const updateNarrative = (narrative: string) => {
    // AI 结果绑定整理时的素材。素材被改动后丢弃 AI 结果；纯手工事实继续保留供高级复核。
    const hasOrganizedFacts = value.facts.some((fact) => Boolean(fact.sourceQuote));
    onChange({
      ...value,
      narrative,
      confirmed: false,
      facts: hasOrganizedFacts ? [] : value.facts,
      warnings: undefined,
    });
    setOrganizeError("");
  };
  const organize = async () => {
    if (!projectId || organizing) return;
    setOrganizing(true);
    setOrganizeError("");
    try {
      const result = await api.authorFacts.organize(projectId, value.narrative);
      onChange({
        ...value,
        topology: "confirmed_individual_author",
        narrative: result.sourceText,
        confirmed: false,
        facts: result.facts.map((fact) => ({
          id: fact.id,
          statement: fact.statement,
          category: fact.category,
          sourceQuote: fact.sourceQuote,
          needsReview: fact.needsReview,
          reviewReason: fact.reviewReason,
        })),
        warnings: result.warnings,
      });
    } catch (error) {
      setOrganizeError(errorMessage(error, "AI 暂时无法整理用户素材"));
    } finally {
      setOrganizing(false);
    }
  };
  const updateFact = (index: number, patch: Partial<PublishingTopologyDraft["facts"][number]>) => {
    onChange({
      ...value,
      confirmed: false,
      facts: value.facts.map((fact, factIndex) => factIndex === index
        // 手动编辑后，原 AI sourceQuote 不再能证明新文本；清掉过期来源，避免界面误报可追溯。
        ? { ...fact, ...patch, sourceQuote: undefined, needsReview: false, reviewReason: undefined }
        : fact),
    });
  };
  const removeFact = (index: number) => {
    onChange({ ...value, confirmed: false, facts: value.facts.filter((_, factIndex) => factIndex !== index) });
  };
  const addFact = () => {
    const used = new Set(value.facts.map((fact) => fact.id));
    let next = value.facts.length + 1;
    while (used.has(`author_fact_${next}`)) next += 1;
    onChange({ ...value, confirmed: false, facts: [...value.facts, emptyAuthorFact(next - 1)] });
  };

  return <section className={`publishing-topology-control${compact ? " is-compact" : ""}`} aria-label="本次发布视角">
    <div className="publishing-topology-control__heading">
      <div><ShieldCheck size={17} /><span><strong>本次用谁的视角发布？</strong><small>写法由模板决定；这里仅确定谁在说话，以及 AI 可以使用哪些用户事实。</small></span></div>
      <Badge tone={individual ? "warning" : "positive"}>{creative ? "自动用户情景" : institution ? "机构视角" : "真实用户素材"}</Badge>
    </div>

    <div className="publishing-view-options" role="radiogroup" aria-label="选择发布视角">
      <button type="button" role="radio" aria-checked={creative} className={creative ? "selected" : ""} onClick={() => selectTopology("creative_scenario")}>
        <span><Sparkles size={17} /><strong>选题自动匹配</strong>{creative && <Check size={15} />}</span>
        <small>默认。根据已选卡片的阶段、角度、缺口和项目场景模型自动生成人物情景。</small>
      </button>
      <button type="button" role="radio" aria-checked={institution} className={institution ? "selected" : ""} onClick={() => selectTopology("institution_owned")}>
        <span><ShieldCheck size={17} /><strong>机构账号说明</strong>{institution && <Check size={15} />}</span>
        <small>使用已核验项目知识，以明确机构身份说明，不模拟用户亲历。</small>
      </button>
      <button type="button" role="radio" aria-checked={individual} className={individual ? "selected" : ""} onClick={() => selectTopology("confirmed_individual_author")}>
        <span><Sparkles size={17} /><strong>真实用户素材</strong>{individual && <Check size={15} />}</span>
        <small>仅在已有访谈或反馈素材时使用；AI 整理成需人工复核的一人称事实。</small>
      </button>
    </div>

    {individual && <div className="author-material-workspace">
      <div className="author-material-input">
        <Field label="真实用户素材" required hint="可以是访谈记录、客服转述或用户反馈。AI 可拆分和规范表达，但不能新增素材中没有的经历。">
          <textarea rows={compact ? 3 : 4} value={value.narrative} maxLength={4000} onChange={(event) => updateNarrative(event.target.value)} placeholder="例如：用户昨天已经去面诊，目前还在比较方案；因为工作原因只能周末安排。" />
        </Field>
        <div className="author-material-input__action">
          <Button type="button" icon={<Sparkles size={15} />} loading={organizing} disabled={!projectId || value.narrative.trim().length < 4} onClick={() => void organize()}>AI 整理并填充</Button>
          <small>整理后先看摘要；需要时再展开高级复核。</small>
        </div>
      </div>

      {organizeError && <div className="author-material-message is-error" role="alert">{organizeError}</div>}
      {value.warnings?.length ? <div className="author-material-message"><Info size={14} /><span>{value.warnings.join("；")}</span></div> : null}

      {value.facts.length > 0 && <div className="author-fact-summary" aria-label="AI 整理结果">
        <header><div><strong>已整理 {value.facts.length} 条可用事实</strong><small>{reviewCount ? `${reviewCount} 条建议重点复核` : "均可追溯到本次素材"}</small></div><Badge tone={reviewCount ? "warning" : "positive"}>{reviewCount ? "待复核" : "已整理"}</Badge></header>
        <ol>{value.facts.map((fact) => <li key={fact.id} className={fact.needsReview ? "needs-review" : ""}>
          <span>{categoryOptions.find((option) => option.value === fact.category)?.label ?? fact.category}</span>
          <div><strong>{fact.statement || "尚未填写"}</strong>{fact.sourceQuote && <small>来源：{fact.sourceQuote}</small>}{fact.reviewReason && <small className="review-reason">复核：{fact.reviewReason}</small>}</div>
        </li>)}</ol>
      </div>}

      <details className="author-facts-advanced">
        <summary><span><ListPlus size={16} /><span><strong>高级复核：逐条编辑事实</strong><small>AI 分类不准确或需要手动补充时再展开</small></span></span><ChevronDown size={16} /></summary>
        <div className="author-facts-list">
          {value.facts.map((fact, index) => <article className={`author-fact-card${fact.statement.trim() ? " is-complete" : ""}`} key={fact.id}>
            <header><div className="author-fact-card__title"><span>{String(index + 1).padStart(2, "0")}</span><div><strong>用户事实 {index + 1}</strong><small>只保留一个状态、动作或结果</small></div></div><Button className="author-fact-card__remove" type="button" variant="ghost" icon={<Trash2 size={14} />} aria-label={`删除用户事实 ${index + 1}`} onClick={() => removeFact(index)}>删除</Button></header>
            <div className="author-fact-card__body">
              <Field label="规范化事实" required hint="手动修改后需要重新确认。"><textarea rows={3} value={fact.statement} onChange={(event) => updateFact(index, { statement: event.target.value })} /></Field>
              <Field label="事实类别" required><select value={fact.category} onChange={(event) => updateFact(index, { category: event.target.value as AuthorFactCategory })}>{categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
            </div>
          </article>)}
          <Button className="author-facts-add" type="button" variant="ghost" icon={<ListPlus size={15} />} onClick={addFact}>手动添加一条事实</Button>
        </div>
      </details>

      <label className={`author-facts-confirmation${value.confirmed ? " is-confirmed" : ""}${factsReady ? "" : " is-disabled"}`}>
        <input type="checkbox" checked={value.confirmed} disabled={!factsReady} onChange={(event) => onChange({ ...value, confirmed: event.target.checked })} />
        <span><strong>{factsReady ? "我已核对素材和整理结果，可用于本次创作" : "请先用 AI 整理，或在高级复核中填写事实"}</strong><small>{factsReady ? "当前操作员和确认时间由服务端记录；这表示已核对素材，不表示操作员就是文中的用户。" : "模板不会自动补出购买、服务、恢复或结果经历。"}</small></span>
      </label>
    </div>}
  </section>;
}

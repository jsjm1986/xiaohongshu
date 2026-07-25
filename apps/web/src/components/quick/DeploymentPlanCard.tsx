import { Megaphone, Pin, ShieldAlert } from 'lucide-react';
import { deploymentPlanView } from '../../lib/deployment-plan';
import type { Candidate } from '../../types';

/**
 * 发布执行方案卡:拿到文案之后「下一步做什么」。
 *
 * 后端为每个候选都算了 deploymentPlan(发布身份、答复时限、评论分流、停止规则),
 * 极简创作此前完全没露出。按「摘要 + 可展开」组织:正面只给要做什么,
 * 完整方案收进折叠区,避免把整个对象摊开破坏极简定位。
 */
/** 产出区传原始 Candidate,创作区传 QuickCandidateView;两者都带 deploymentPlan/unknowns。 */
type PlanSource = Pick<Candidate, 'deploymentPlan' | 'unknowns'>;

export function DeploymentPlanCard({ candidate }: { candidate?: PlanSource }) {
  const plan = deploymentPlanView(candidate?.deploymentPlan);
  if (!plan) return null;

  return (
    <section className="qc-deploy">
      <header className="qc-deploy__head">
        <Megaphone size={13} />
        <strong>发布执行方案</strong>
        <span className="qc-deploy__identity">以「{plan.identityLabel}」身份发布</span>
        {plan.ownedFirstComment && <span className="qc-badge qc-badge--ok">需自备首评</span>}
      </header>

      {plan.sla && <p className="qc-deploy__sla">答复时限：{plan.sla}</p>}

      {plan.pinLabels.length > 0 && (
        <p className="qc-deploy__pin">
          <Pin size={12} />
          优先置顶：{plan.pinLabels.join(' · ')}
        </p>
      )}

      {plan.hasDetail && (
        <details className="qc-deploy__more">
          <summary>完整方案（评论分流、更新与停止规则）</summary>

          {plan.routing.length > 0 && (
            <div className="qc-deploy__block">
              <h4>评论分流</h4>
              <ul className="qc-deploy__routing">
                {plan.routing.map((r) => (
                  <li key={r.route}>
                    <strong>{r.route}</strong>
                    {r.condition && <em>{r.condition}</em>}
                    <span>{r.action}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.stopRules.length > 0 && (
            <div className="qc-deploy__block">
              <h4><ShieldAlert size={12} />不可以做的事</h4>
              <ul className="qc-deploy__rules">
                {plan.stopRules.map((rule) => <li key={rule}>{rule}</li>)}
              </ul>
            </div>
          )}

          {plan.updateTriggers.length > 0 && (
            <div className="qc-deploy__block">
              <h4>何时需要更新口径</h4>
              <ul className="qc-deploy__rules">
                {plan.updateTriggers.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
          )}

          {plan.updatePolicy.length > 0 && (
            <div className="qc-deploy__block">
              <h4>更新流程</h4>
              <ul className="qc-deploy__rules">
                {plan.updatePolicy.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
          )}
        </details>
      )}

      {/* 仍然未知:直接影响能不能发,所以放在方案里而不是藏进诊断 */}
      {(candidate?.unknowns ?? []).length > 0 && (
        <div className="qc-deploy__unknowns">
          <span>这些问题目前答不了，被真实评论问到时不要代填：</span>
          <ul>
            {(candidate?.unknowns ?? []).map((u) => <li key={String(u)}>{String(u)}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

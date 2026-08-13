import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { Button, Field, useToast } from '../components/Ui';
import { api } from '../lib/api';
import { quotaAbsenceNote, quotaCell, type QuotaSnapshot } from '../lib/quota-view';
import { ledgerItemView, preLedgerNote, type QuotaLedgerResponse } from '../lib/quota-ledger-view';
import { QUICK_HOME_PATH } from '../lib/quick-routes';

/**
 * 极简创作的账户页。
 *
 * 替掉「SaaS 用户点账户设置 → 落进专家版 /settings」这条路径:那个页面渲染在
 * AppShell 里,带整条 9 个入口的专家侧边栏、项目切换器,还有「轻量运行 SQLite /
 * CORE v1.6.0 · POLICY 3.6.0 / 无向量服务」这类内部技术状态。付费客户看到的
 * 本该是自己的账号,不是别人的后台。
 *
 * 只放 SaaS 用户真正能用的三块:账号信息、改密码、额度余量。模型来源 / API 密钥 /
 * BYOK / 生成默认值一概不放——后端对 SaaS 一律 403,摆上去只是能看不能用的装饰。
 */
export function QuickAccountPage() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [ledger, setLedger] = useState<QuotaLedgerResponse | null>(null);

  // 额度:工作区 id 从 /api/workspaces 取,而不是依赖「当前选中项目」——
  // 账户页可能在还没选项目时打开。接口都在 SaaS 白名单里。
  useEffect(() => {
    let cancelled = false;
    api.workspaces.list()
      .then((list) => {
        const workspaceId = list[0]?.id;
        if (!workspaceId || cancelled) return;
        return Promise.all([
          api.settings.quota(workspaceId).then((snapshot) => {
            if (!cancelled) setQuota(snapshot);
          }),
          api.settings.quotaLedger(workspaceId).then((response) => {
            if (!cancelled) setLedger(response);
          }),
        ]);
      })
      .catch(() => { /* 静默回落:额度读不到就不显示这一格,不打扰用户 */ });
    return () => { cancelled = true; };
  }, []);

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (password.next.length < 12) {
      toast.push('新密码至少需要 12 个字符', 'error');
      return;
    }
    if (password.next !== password.confirm) {
      toast.push('两次输入的新密码不一致', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.auth.changePassword(password.current, password.next);
      if (user) setUser({ ...user, mustChangePassword: false });
      setPassword({ current: '', next: '', confirm: '' });
      toast.push('密码已更新');
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '密码更新失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const cell = quotaCell(quota);
  const absenceNote = quotaAbsenceNote(quota);
  // idx > 0 表示这个位置前面还有本站的历史条目,navigate(-1) 不会退出站点
  const canGoBack = (location.key !== 'default') && window.history.length > 1;

  return (
    <div className="page qc-page qc-account">
      <div className="qc-crumb">
        {/*
          返回上一处,而不是硬跳 /quick。四区改成真路由后,「顶栏点额度 → 账户页 →
          返回」如果统一去卡墙,用户会被踢出正在工作的项目,要重新选项目再点回原来
          那个区。有历史就退回去(账户页多半是从某个区点进来的);直接打开账户页
          链接时没有可退的历史,才落卡墙。
        */}
        <button
          type="button"
          className="qc-crumb__back"
          onClick={() => (canGoBack ? navigate(-1) : navigate(QUICK_HOME_PATH))}
        >
          <ArrowLeft size={13} /> {canGoBack ? '返回' : '全部项目'}
        </button>
        <h1>账户</h1>
      </div>

      <div className="qc-panel">
        <section className="qc-account__card">
          <h2>账号信息</h2>
          <p className="qc-hint">账号由管理员开通，用户名与归属权限不能在此修改。</p>
          <dl className="qc-account__meta">
            <div>
              <dt>用户名</dt>
              <dd>{user?.username ?? '—'}</dd>
            </div>
            <div>
              <dt>显示名</dt>
              <dd>{user?.displayName ?? '—'}</dd>
            </div>
            <div>
              <dt>角色</dt>
              <dd>{user?.role ?? '—'}</dd>
            </div>
          </dl>
        </section>

        {/* 额度。不显示数字时也要说清原因(BYOK / 未配额度),而不是留一片空白
            让用户猜是没额度还是坏了。拉取失败时 absenceNote 为 null,静默略过。 */}
        {(cell || absenceNote) && (
          <section className="qc-account__card">
            <h2>平台额度</h2>
            {cell ? (
              <>
                <div className={`qc-account__quota qc-account__quota--${cell.tone}`}>
                  <strong>{cell.value}</strong>
                  <span>{cell.unit}</span>
                </div>
                {cell.note && (
                  <p className={cell.tone === 'error' ? 'qc-warn-line' : 'qc-hint'}>{cell.note}</p>
                )}
              </>
            ) : (
              <p className="qc-hint">{absenceNote}</p>
            )}
          </section>
        )}

        {/* 用量流水:客户对自己的账单有知情权。空流水且余额为 0 时整节不显示;
            流水上线(2026-08-13)前的历史用量无逐笔明细,差额如实说明。 */}
        {ledger && (ledger.items.length > 0 || (quota?.quotaUsed ?? 0) > 0) && (
          <section className="qc-account__card">
            <h2>用量明细</h2>
            <p className="qc-hint">共扣 {ledger.consumed} 次、退回 {ledger.refunded} 次；生成、按意见修改、知识库分析各计 1 次，失败与中断自动退回。</p>
            {quota && preLedgerNote(quota.quotaUsed ?? 0, ledger.net) && (
              <p className="qc-hint">{preLedgerNote(quota.quotaUsed ?? 0, ledger.net)}</p>
            )}
            {ledger.items.length > 0 && (
              <ul className="qc-ledger">
                {ledger.items.slice(0, 20).map((item) => {
                  const view = ledgerItemView(item);
                  return (
                    <li key={item.id}>
                      <span className="qc-ledger__label">{view.label}</span>
                      <span className="qc-ledger__date">{view.date}</span>
                      <b className={view.isRefund ? 'qc-ledger__amount qc-ledger__amount--refund' : 'qc-ledger__amount'}>{view.amount}</b>
                    </li>
                  );
                })}
              </ul>
            )}
            {ledger.items.length > 20 && <p className="qc-hint">仅显示最近 20 条。</p>}
          </section>
        )}

        <section className="qc-account__card">
          <h2>
            <KeyRound size={14} /> 修改密码
            {user?.mustChangePassword && <span className="qc-badge qc-badge--warn">首次登录需修改</span>}
          </h2>
          <p className="qc-hint">修改后当前会话保留，其他设备需要重新登录。</p>
          <form className="qc-account__form" onSubmit={changePassword}>
            <Field label="当前密码">
              <input
                type="password"
                value={password.current}
                autoComplete="current-password"
                onChange={(e) => setPassword((p) => ({ ...p, current: e.target.value }))}
                required
              />
            </Field>
            <Field label="新密码">
              <input
                type="password"
                value={password.next}
                autoComplete="new-password"
                onChange={(e) => setPassword((p) => ({ ...p, next: e.target.value }))}
                required
              />
            </Field>
            <Field label="再次输入新密码">
              <input
                type="password"
                value={password.confirm}
                autoComplete="new-password"
                onChange={(e) => setPassword((p) => ({ ...p, confirm: e.target.value }))}
                required
              />
            </Field>
            <div className="qc-actions">
              <Button type="submit" loading={saving} disabled={saving}>更新密码</Button>
              <small className="qc-hint">
                <ShieldCheck size={12} /> 至少 12 个字符；密码以 Argon2id 单向处理，服务器不保存明文。
              </small>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

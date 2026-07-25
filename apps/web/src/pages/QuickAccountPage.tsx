import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { Button, Field, useToast } from '../components/Ui';
import { api } from '../lib/api';
import { quotaAbsenceNote, quotaCell, type QuotaSnapshot } from '../lib/quota-view';

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
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);

  // 额度:工作区 id 从 /api/workspaces 取,而不是依赖「当前选中项目」——
  // 账户页可能在还没选项目时打开。两个接口都在 SaaS 白名单里。
  useEffect(() => {
    let cancelled = false;
    api.workspaces.list()
      .then((list) => {
        const workspaceId = list[0]?.id;
        if (!workspaceId || cancelled) return;
        return api.settings.quota(workspaceId).then((snapshot) => {
          if (!cancelled) setQuota(snapshot);
        });
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

  return (
    <div className="page qc-page qc-account">
      <div className="qc-crumb">
        <button type="button" className="qc-crumb__back" onClick={() => navigate('/quick')}>
          <ArrowLeft size={13} /> 返回创作
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
            <h2>本月额度</h2>
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

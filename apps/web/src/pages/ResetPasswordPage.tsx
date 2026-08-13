import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useToast } from '../components/Ui';
import { api } from '../lib/api';

/**
 * 凭一次性链接自设新密码(忘记密码通道的用户端)。
 * 链接由管理员核身后通过可信渠道发出,token 在 URL query 里;
 * 成功后回登录页用新密码进入。失败文案不区分令牌状态(见后端注释)。
 * 布局复用登录页的 panel/card 类,不新增样式。
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const navigate = useNavigate();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('新密码至少 8 个字符');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.resetPassword(token, password);
      toast.push('密码已重置，请用新密码登录');
      navigate('/login', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : '重置失败，请重新联系客服获取链接');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page login-page--single">
      <section className="login-panel">
        <div className="login-card">
          <div className="login-card__heading">
            <span><KeyRound size={16} /> 忘记密码</span>
            <h2>设置新密码</h2>
            <p>链接 24 小时内有效，设置成功后即失效</p>
          </div>
          {!token ? (
            <div className="form-error">链接不完整，请使用客服发给你的完整重置链接。</div>
          ) : (
            <form onSubmit={handleSubmit}>
              <label className="field">
                <span className="field__label">新密码</span>
                <input
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="至少 8 个字符"
                  required
                />
              </label>
              <label className="field">
                <span className="field__label">再输一遍</span>
                <input
                  type="password"
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(event) => setConfirm(event.target.value)}
                  required
                />
              </label>
              {error && <div className="form-error">{error}</div>}
              <button type="submit" className="login-submit" disabled={submitting || !password}>
                {submitting ? '提交中…' : '设置新密码'}
              </button>
            </form>
          )}
          <p className="login-help">想起密码了？<Link to="/login">直接登录 →</Link></p>
        </div>
      </section>
    </div>
  );
}

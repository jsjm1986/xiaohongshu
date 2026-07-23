import { ArrowRight, Check, Copy } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useToast } from '../components/Ui';

const SUPPORT_WECHAT = 'wjyy5035';
const PHONE_RE = /^1[3-9]\d{9}$/;

export function RegisterPage() {
  const [form, setForm] = useState({ username: '', password: '', confirm: '', organizationName: '', phone: '' });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [revealWechat, setRevealWechat] = useState(false);
  const toast = useToast();

  const update = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const copyWechat = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_WECHAT);
      toast.push('客服微信已复制,去微信添加即可');
    } catch {
      setRevealWechat(true);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (form.username.trim().length < 3) return setError('用户名至少 3 个字符');
    if (form.password.length < 12) return setError('密码至少 12 个字符');
    if (form.password !== form.confirm) return setError('两次输入的密码不一致');
    if (!form.organizationName.trim()) return setError('请填写机构名称');
    if (!PHONE_RE.test(form.phone.trim())) return setError('请输入有效的手机号');
    setSubmitting(true);
    try {
      await api.register({
        username: form.username.trim(),
        password: form.password,
        organizationName: form.organizationName.trim(),
        phone: form.phone.trim(),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '提交失败,请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="login-page login-page--single">
        <section className="login-panel">
          <div className="login-card">
            <div className="login-card__heading"><span><Check size={16} /> 已提交</span><h2>申请已提交,等待审核</h2><p>我们会尽快审核你的开通申请。如需加急,可添加客服微信。</p></div>
            <button type="button" className="login-submit" onClick={() => void copyWechat()}><Copy size={16} /><span>复制客服微信</span></button>
            {revealWechat && <p className="login-help">客服微信:{SUPPORT_WECHAT}</p>}
            <p className="login-help"><Link to="/login">返回登录</Link></p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="login-page login-page--single">
      <section className="login-panel">
        <div className="login-card">
          <div className="login-card__heading"><span>申请开通</span><h2>注册使用申请</h2><p>提交后由管理员审核开通</p></div>
          <form onSubmit={submit}>
            <label className="field"><span className="field__label">用户名</span><input value={form.username} onChange={update('username')} minLength={3} maxLength={64} required /></label>
            <label className="field"><span className="field__label">密码(至少 12 位)</span><input type="password" value={form.password} onChange={update('password')} minLength={12} required /></label>
            <label className="field"><span className="field__label">确认密码</span><input type="password" value={form.confirm} onChange={update('confirm')} required /></label>
            <label className="field"><span className="field__label">机构名称</span><input value={form.organizationName} onChange={update('organizationName')} maxLength={120} required /></label>
            <label className="field"><span className="field__label">联系手机号</span><input value={form.phone} onChange={update('phone')} inputMode="numeric" required /></label>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="login-submit" disabled={submitting}>{submitting ? <><span className="spinner spinner--small" />提交中…</> : <><span>提交申请</span><ArrowRight size={18} /></>}</button>
          </form>
          <p className="login-help">已有账号?<Link to="/login">返回登录</Link></p>
        </div>
      </section>
    </div>
  );
}

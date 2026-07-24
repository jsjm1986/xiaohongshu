import { ArrowRight, BookOpenText, Check, Eye, EyeOff, Layers3, Sparkles } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { ApiError } from '../lib/api';
import { isSaasUser } from '../lib/saas-access';

export function LoginPage() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // SaaS 用户登录落 /quick;state.from 指向其他页时 ProtectedRoute 也会弹回,双保险。
    if (user) navigate(isSaasUser(user) ? '/quick' : ((location.state as { from?: string } | null)?.from || '/'), { replace: true });
  }, [user, navigate, location.state]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(username, password);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '暂时无法登录，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-story">
        <div className="login-brand"><span><Sparkles size={20} /></span><strong>内容智造台</strong></div>
        <div className="login-story__content">
          <div className="eyebrow eyebrow--light">从信息缺口出发</div>
          <h1>把项目知识，<br />变成真正有用的内容。</h1>
          <p>基于你的知识库和公式版本，一次生成标题、正文、标签与评论区的完整内容包。</p>
          <div className="login-formula">
            <div><BookOpenText size={19} /><span><small>项目知识</small><strong>事实与边界</strong></span></div>
            <i>+</i>
            <div><Layers3 size={19} /><span><small>内容公式</small><strong>缺口与表达</strong></span></div>
            <i>=</i>
            <div className="login-formula__result"><Sparkles size={19} /><span><small>完整交付</small><strong>3 个候选版本</strong></span></div>
          </div>
        </div>
        <div className="login-story__foot">
          <span><Check size={15} />知识来源可追溯</span>
          <span><Check size={15} />未知与猜想明确标记</span>
          <span><Check size={15} />完整内容包一键导出</span>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="login-card__heading"><span>欢迎回来</span><h2>登录工作台</h2><p>使用管理员为你创建的账号</p></div>
          <form onSubmit={handleSubmit}>
            <label className="field"><span className="field__label">用户名</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="请输入用户名" required /></label>
            <label className="field"><span className="field__label">密码</span><span className="password-input"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="请输入密码" required /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="login-submit" disabled={submitting}>{submitting ? <><span className="spinner spinner--small" />正在登录…</> : <><span>登录</span><ArrowRight size={18} /></>}</button>
          </form>
          <p className="login-help">无法登录？请联系工作区管理员重置密码。</p>
          <p className="login-help">还没有账号?<Link to="/register">申请开通 →</Link></p>
        </div>
        <footer>© 2026 内容智造台 · 你的知识始终属于你</footer>
      </section>
    </div>
  );
}

import { ArrowRight, BookOpenText, Check, Eye, EyeOff, Layers3, Sparkles } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { useToast } from '../components/Ui';
import { ApiError } from '../lib/api';
import { isSaasUser, loginLandingPath } from '../lib/saas-access';
import { SUPPORT_WECHAT } from '../lib/support';

export function LoginPage() {
  // 用户名不预填:预填「admin」对付费客户是错的默认值,他得先清空再输入自己的账号
  // (自动化里实测三击选中都清不干净,真人同样容易输成 "adminxxx" 然后被判密码错)。
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [revealWechat, setRevealWechat] = useState(false);
  const { user, login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!user) return;
    // SaaS 用户一律进极简创作(强制改密时进 /quick/account,不再是专家版 /settings)。
    // 专家用户尊重 state.from 以便回到原本要去的页面。
    if (isSaasUser(user) || user.mustChangePassword) {
      navigate(loginLandingPath(user), { replace: true });
      return;
    }
    navigate((location.state as { from?: string } | null)?.from || '/', { replace: true });
  }, [user, navigate, location.state]);

  /** 复制客服微信;剪贴板不可用(非 https / 无权限)时退化成明文展示,不能让人拿不到 */
  const copyWechat = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_WECHAT);
      toast.push('客服微信已复制,去微信添加即可');
    } catch {
      setRevealWechat(true);
    }
  };

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
          {/*
            登录页对**两类用户**同时开放,但「联系工作区管理员重置密码」只对科研用户
            成立:付费的 SaaS 客户既不知道管理员是谁,也没有任何站内途径找到他——
            密码忘了就等于被锁在门外,而这是他唯一能自救的页面。给可复制的客服微信。
          */}
          <p className="login-help">
            忘记密码？请添加客服微信{' '}
            <button type="button" className="login-help__copy" onClick={() => void copyWechat()}>
              {SUPPORT_WECHAT}
            </button>{' '}
            重置。
          </p>
          {revealWechat && <p className="login-help">客服微信:{SUPPORT_WECHAT}(请手动复制)</p>}
          <p className="login-help">还没有账号?<Link to="/register">申请开通 →</Link></p>
        </div>
        <footer>© 2026 内容智造台 · 你的知识始终属于你</footer>
      </section>
    </div>
  );
}

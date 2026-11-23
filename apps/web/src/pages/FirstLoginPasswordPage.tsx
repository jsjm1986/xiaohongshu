import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { Button, useToast } from '../components/Ui';
import { errorMessage } from '../lib/errors';
import { fallbackPath } from '../lib/saas-access';

export function FirstLoginPasswordPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      toast.push(errorMessage(error, '退出登录失败'), 'error');
    }
  };

  return (
    <main className="login-page login-page--single">
      <section className="login-panel">
        <div className="login-card">
          <div className="login-card__heading">
            <h2>修改初始密码</h2>
            <p>为 {user?.username} 设置新密码后即可进入工作台。</p>
          </div>
          <ChangePasswordForm onChanged={() => navigate(fallbackPath(user), { replace: true })} />
          <div className="login-help">
            <Button type="button" variant="ghost" onClick={() => void handleLogout()}>退出登录</Button>
          </div>
        </div>
      </section>
    </main>
  );
}

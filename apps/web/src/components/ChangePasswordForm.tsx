import { LockKeyhole, Save } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { useAuth } from './AuthContext';
import { Button, Field, useToast } from './Ui';

const EMPTY_PASSWORD = { current: '', next: '', confirm: '' };

export function ChangePasswordForm({ onChanged }: { onChanged?: () => void }) {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [password, setPassword] = useState(EMPTY_PASSWORD);
  const [saving, setSaving] = useState(false);

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.next !== password.confirm) {
      toast.push('两次输入的新密码不一致', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.auth.changePassword(password.current, password.next);
      if (user?.mustChangePassword) setUser({ ...user, mustChangePassword: false });
      setPassword(EMPTY_PASSWORD);
      toast.push('密码已更新');
      onChanged?.();
    } catch (error) {
      toast.push(errorMessage(error, '密码更新失败'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form-stack password-form" onSubmit={changePassword}>
      <Field label="当前密码">
        <input
          type="password"
          autoComplete="current-password"
          value={password.current}
          onChange={(event) => setPassword({ ...password, current: event.target.value })}
          maxLength={256}
          required
        />
      </Field>
      <div className="field-grid field-grid--two">
        <Field label="新密码" hint="至少 12 个字符">
          <input
            type="password"
            autoComplete="new-password"
            value={password.next}
            onChange={(event) => setPassword({ ...password, next: event.target.value })}
            minLength={12}
            maxLength={256}
            required
          />
        </Field>
        <Field label="再次输入新密码">
          <input
            type="password"
            autoComplete="new-password"
            value={password.confirm}
            onChange={(event) => setPassword({ ...password, confirm: event.target.value })}
            minLength={12}
            maxLength={256}
            required
          />
        </Field>
      </div>
      <div className="security-note">
        <LockKeyhole size={17} />
        <p>密码会使用 Argon2id 单向处理，服务器不保存可读取的明文密码。</p>
      </div>
      <div className="settings-save">
        <Button type="submit" loading={saving} icon={<Save size={16} />}>更新密码</Button>
      </div>
    </form>
  );
}

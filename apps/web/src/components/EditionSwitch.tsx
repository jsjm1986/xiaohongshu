import { useLocation, useNavigate } from 'react-router-dom';
import { availableEditions, canSwitchEdition, editionOfPath, type EditionId } from '../lib/edition';
import { useAuth } from './AuthContext';

/**
 * 版本切换器(基础版 ⇄ 科研版)。
 *
 * 两个壳的顶栏用同一个组件、同一个位置,所以来回切换是对称动作——原来「极简创作」
 * 在侧边栏、「完整版」在另一个壳的顶栏右侧,用户得记两个不同的位置。
 *
 * SaaS 用户只有一个版本,整个控件不渲染(不是渲染成禁用态:那等于在付费产品里
 * 常驻一个点不动的按钮,反复提示"这里有你买不到的东西")。
 */
export function EditionSwitch() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (!canSwitchEdition(user)) return null;

  const current = editionOfPath(location.pathname);
  const editions = availableEditions(user);

  const go = (id: EditionId, path: string) => {
    if (id === current) return;
    navigate(path);
  };

  return (
    <div className="edition-switch" role="group" aria-label="界面版本">
      {editions.map((edition) => (
        <button
          key={edition.id}
          type="button"
          className={edition.id === current ? 'active' : ''}
          aria-current={edition.id === current ? 'true' : undefined}
          title={edition.hint}
          onClick={() => go(edition.id, edition.path)}
        >
          {edition.label}
        </button>
      ))}
    </div>
  );
}

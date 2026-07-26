import { Navigate, useParams } from 'react-router-dom';
import { areaPath, QUICK_HOME_PATH } from '../../lib/quick-routes';

/**
 * 区段兜底:/quick/:projectId 与 /quick/:projectId/<认不出的段> 都落到默认区。
 *
 * 用**绝对**路径重定向。相对的 `<Navigate to="overview">` 挂在通配路由 `*` 上是
 * 追加而不是替换:实测 /quick/:id/nope 会滚成
 * /quick/:id/nope/overview/overview/overview/… 无限增长——重定向后的地址仍然匹配
 * `*`,于是再追加一次,循环不收敛。绝对路径一次到位。
 */
export function QuickAreaFallback() {
  const { projectId } = useParams<{ projectId: string }>();
  return <Navigate to={projectId ? areaPath(projectId) : QUICK_HOME_PATH} replace />;
}

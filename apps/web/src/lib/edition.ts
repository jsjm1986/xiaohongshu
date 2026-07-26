import type { User } from '../types';
import { isSaasUser, EXPERT_HOME_PATH, SAAS_HOME_PATH } from './saas-access';

/**
 * 版本(edition),不是频道。
 *
 * 「极简创作」此前挂在专家版侧边栏的「02 · 资产与规则」里,和知识库、公式版本并列
 * ——但它不是一类资产,而是**另一套界面**。放在导航里,专家用户点进去等于换壳,再
 * 要回来只能靠壳里另一个位置的「完整版」链接,两个方向的入口长得完全不一样。
 *
 * 产品事实:基础版(SaaS)= /quick 一套壳;科研版 = 完整工作台 + 基础版都能用。
 * 所以这是一个二元的版本切换器,该常驻在两个壳的顶栏同一位置,双向对称。
 */
export type EditionId = 'basic' | 'research';

export interface Edition {
  id: EditionId;
  /** 切换器上的名字。 */
  label: string;
  /** 该版本的落地路径。 */
  path: string;
  /** hover / 无障碍说明。 */
  hint: string;
}

export const EDITIONS: readonly Edition[] = [
  {
    id: 'basic',
    label: '基础版',
    path: SAAS_HOME_PATH,
    hint: '极简创作:四步走完选题到成稿',
  },
  {
    id: 'research',
    label: '科研版',
    path: EXPERT_HOME_PATH,
    hint: '完整工作台:项目、知识库、公式版本、研究证据',
  },
] as const;

export function editionById(id: EditionId): Edition {
  const found = EDITIONS.find((edition) => edition.id === id);
  // EditionId 是闭集,找不到只可能是常量表被改坏了。
  if (!found) throw new Error(`未知版本:${id}`);
  return found;
}

/**
 * 当前路径属于哪个版本。
 * /quick 及其子路径是基础版,其余(专家壳里的一切)都是科研版。
 */
export function editionOfPath(pathname: string): EditionId {
  return pathname === SAAS_HOME_PATH || pathname.startsWith(`${SAAS_HOME_PATH}/`) ? 'basic' : 'research';
}

/**
 * 该用户能在哪些版本之间切换。
 *
 * SaaS 用户只有基础版——返回单元素数组而不是空数组,调用方据此决定是否渲染切换器
 * (长度 < 2 就不渲染),同时保留"我在哪个版本"这个信息以备展示。
 */
export function availableEditions(user: Pick<User, 'userKind'> | null | undefined): readonly Edition[] {
  return isSaasUser(user) ? [editionById('basic')] : EDITIONS;
}

/** 是否给这个用户露出切换器。 */
export function canSwitchEdition(user: Pick<User, 'userKind'> | null | undefined): boolean {
  return availableEditions(user).length > 1;
}

import type { V2InstrumentTone } from '../components/V2';
import { SUPPORT_HINT } from './support';

/** GET /api/settings/quota 的响应。只有额度,不含供应商与密钥字段。 */
export interface QuotaSnapshot {
  workspaceId: string;
  providerMode: 'platform' | 'byok' | string;
  monthlyQuota: number;
  quotaUsed: number;
  remaining: number;
}

export interface QuotaCell {
  tone: V2InstrumentTone;
  /** 剩余次数 */
  value: string;
  /** 「/ 500 次」 */
  unit: string;
  note?: string;
}

/**
 * 不显示额度格时的原因说明。
 *
 * quotaCell 返回 null 有三种完全不同的情形,而界面此前一律留空白——用户看到的是
 * 一片空,分不清"没配额度""用的是自己的密钥""读取失败了"。BYOK 是其中最常见的
 * 一种(实测当前工作区就是),明说一句比留白强。
 *
 * 返回 null 表示连说明都不必给(拉取失败,静默即可,不该拿技术故障打扰用户)。
 */
export function quotaAbsenceNote(q: QuotaSnapshot | null | undefined): string | null {
  if (!q) return null;
  if (q.providerMode !== 'platform') return '当前使用自有密钥，不消耗平台额度。';
  if (!q.monthlyQuota || q.monthlyQuota <= 0) return '尚未配置平台额度。';
  return null;
}

/** 余量低于这个比例就转警示色。20% 给的是"还够用几篇"的手感,不是精确阈值。 */
const LOW_RATIO = 0.2;

/**
 * 额度仪表格的展示决策。
 *
 * 返回 null 表示"这一格不渲染":
 * - BYOK:用户用自己的密钥,平台配额字段对他没有意义,显示只会误导;
 * - 拉取失败(null):额度显示不了不该阻塞总览其余读数;
 * - monthlyQuota 为 0:额度未配置,同时也避免除零。
 */
export function quotaCell(q: QuotaSnapshot | null | undefined): QuotaCell | null {
  if (!q) return null;
  if (q.providerMode !== 'platform') return null;
  if (!q.monthlyQuota || q.monthlyQuota <= 0) return null;

  // 不信任服务端算好的 remaining 也无妨,这里同样做下限保护:
  // 配额被下调到低于用量时,显示 0 而不是负数。
  const remaining = Math.max(0, q.monthlyQuota - q.quotaUsed);
  const ratio = remaining / q.monthlyQuota;

  const tone: V2InstrumentTone = remaining === 0 ? 'error' : ratio <= LOW_RATIO ? 'warn' : 'ok';
  // 用完时的出路必须是 SaaS 用户真能走的那条:他看不到管理员是谁,也没权限配
  // BYOK(PATCH /api/settings 对他 403),所以原来那句「联系管理员增加额度或改用
  // 自有密钥」两条路都走不通。改成可复制的客服微信。
  const note = remaining === 0
    ? `额度已用完，无法继续生成。${SUPPORT_HINT}`
    : tone === 'warn'
      ? '余量不多，用完后将无法生成'
      : undefined;

  return { tone, value: String(remaining), unit: `/ ${q.monthlyQuota} 次`, note };
}

/**
 * 额度是否已经用尽——用于**生成前**就把话说清。
 *
 * 实测缺口:额度用尽时总览页与账户页都红着提示并给了客服微信,而**创作区**
 * (用户真正点「生成文案」的地方)全页不提额度二字。付费用户在那里点下去,只会
 * 撞上一个 403 的红条。所以生成入口自己也要知道额度状态。
 *
 * 只对 platform 模式判定:BYOK 用户不吃平台配额,拉取失败(null)时也不该
 * 因为读不到额度就把生成按钮锁死——那会把"看不见"升级成"不能用"。
 */
export function quotaExhausted(q: QuotaSnapshot | null | undefined): boolean {
  if (!q || q.providerMode !== 'platform') return false;
  if (!q.monthlyQuota || q.monthlyQuota <= 0) return false;
  return q.monthlyQuota - q.quotaUsed <= 0;
}

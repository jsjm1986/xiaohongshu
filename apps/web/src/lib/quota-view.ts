import type { V2InstrumentTone } from '../components/V2';

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
  // 文案与后端 consumePlatformQuota 抛的 403 保持一致口径,不自创说法
  const note = remaining === 0
    ? '已用完，联系管理员增加额度或改用自有密钥'
    : tone === 'warn'
      ? '余量不多，用完后将无法生成'
      : undefined;

  return { tone, value: String(remaining), unit: `/ ${q.monthlyQuota} 次`, note };
}

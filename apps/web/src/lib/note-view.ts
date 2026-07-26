/**
 * 仿真笔记的展示派生值。
 *
 * 这里只放「从已有数据算出来的显示值」,不含任何真实性判断——校验分级复用
 * lib/issue-verdict.ts 的 issueVerdict(),不在这里重写一套。
 */

/**
 * 头像底色。
 *
 * 系统没有真实头像,也不该有:上传头像是平台账号的事,这里只是产出预览。用账号名
 * 派生一个稳定的柔和底色,同一项目每次进页面颜色一致(否则用户会以为换了账号)。
 */
const TONES = [
  { bg: '#ffe0e5', fg: '#c8395a' },
  { bg: '#e2ecff', fg: '#3a5fa8' },
  { bg: '#e4f6e8', fg: '#2f7a45' },
  { bg: '#fff2dc', fg: '#a8792e' },
  { bg: '#efe6ff', fg: '#6b4aa8' },
  { bg: '#dff4f4', fg: '#2b7a7a' },
] as const;

export function avatarTone(name: string): { bg: string; fg: string; initial: string } {
  const text = name.trim();
  // 逐字符累加而不是取首字符 charCode:「稳行驾校」和「稳定健身」首字相同,
  // 只看首字会让同一批项目撞成一个色。
  let sum = 0;
  for (const ch of text) sum += ch.codePointAt(0) ?? 0;
  const tone = TONES[sum % TONES.length]!;
  const first = [...text][0];
  return {
    bg: tone.bg,
    fg: tone.fg,
    // 拉丁字母大写,中文原样;空名字给「号」而不是空白圆圈。
    initial: first ? first.toUpperCase() : '号',
  };
}

/**
 * 笔记日期。真实小红书笔记页脚显示发布日期,这里用完成时间——它是这篇稿子
 * 「成形」的时间。两者皆缺就不渲染日期行,不编一个今天。
 */
export function noteDate(job: { completedAt?: string; createdAt?: string }): string | undefined {
  const raw = job.completedAt ?? job.createdAt;
  if (!raw) return undefined;
  const date = new Date(raw);
  // 历史数据里出现过非 ISO 的脏值;Invalid Date 直接不显示,别把
  // 「Invalid Date」印在仿真笔记上。
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 把候选下标夹进合法范围。
 *
 * 下标由阅读页持有,同时喂给预览区与工作区两侧,所以两边必须用同一套夹法——各写一遍
 * 就会出现「一侧读第 3 版、另一侧回落到最后一版」这种两层显示不同候选的情况。
 *
 * 两头都夹:上界防「上一篇选了第 3 版、下一篇只有 1 版」,下界防负数与 NaN
 * (调用方拿到脏值时,candidates[-1]! 的非空断言会直接崩)。
 */
export function clampCandidateIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, index || 0), total - 1);
}

/** 账号名。项目名缺失时用中性称呼,不留空。 */
export function accountName(projectName?: string | null): string {
  const text = (projectName ?? '').trim();
  return text || '发布账号';
}

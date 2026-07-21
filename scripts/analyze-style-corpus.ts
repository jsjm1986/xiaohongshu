import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

type JsonRow = Record<string, unknown>;

interface Distribution {
  min: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
}

const INFORMATION_PATTERNS: Record<string, RegExp> = {
  price: /价格|费用|花了|多少钱|贵不贵|预算|报价/u,
  pain: /疼|痛|麻醉/u,
  appointment: /预约|排期|地址|交通|车程|高铁|地铁|来院/u,
  service: /复查|随访|服务|术后管理/u,
  recovery: /恢复|请假|上班|肿|淤青|拆线|第[一二三四五六七八九十\d]+天|day\s*\d+/iu,
  method: /术式|方案|适合|适配|内切|外切|眶隔|脂肪/u,
  doctor: /医生|院长|主任|谁做|哪里做/u,
  risk: /风险|副作用|失败|后遗症|凹陷|增生|异常/u,
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function text(row: JsonRow, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value.trim() : '';
}

function bodyWithoutHashtags(value: string): string {
  return value
    .replace(/#([^#\n]*?)(?:\[话题\])?#/gu, '')
    .replace(/(?:^|\s)#[^\s#]+/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function commentLinesWithoutRolePrefix(value: string): string[] {
  return value.split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:评\s*\d+|博主回(?:复)?|楼主回(?:复)?|作者回(?:复)?)[：:]\s*/u, '').trim())
    .filter(Boolean);
}

function imageCount(row: JsonRow): number {
  const raw = row['实际图片数'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const details = row['图片拆解明细'];
  return Array.isArray(details) ? details.length : 0;
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return Math.round(((sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction) * 10) / 10;
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    max: sorted.at(-1) ?? 0,
  };
}

async function main(): Promise<void> {
  const source = resolve(argument('--source') ?? resolve('..', '70篇对标内容_AI提炼版.jsonl'));
  const output = argument('--output');
  const raw = await readFile(source, 'utf8');
  const rows = raw
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as JsonRow;
      } catch (error) {
        throw new Error(`第 ${index + 1} 行不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  if (!rows.length) throw new Error('语料为空。');

  const titles = rows.map((row) => text(row, '标题'));
  const bodies = rows.map((row) => bodyWithoutHashtags(text(row, '正文')));
  const comments = rows.map((row) => text(row, '评论区内容'));
  const commentLineGroups = comments.map(commentLinesWithoutRolePrefix);
  const imageCounts = rows.map(imageCount);
  const imageTypes = new Map<string, number>();
  rows.forEach((row) => {
    const details = row['图片拆解明细'];
    if (!Array.isArray(details)) return;
    details.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const type = (item as JsonRow)['图片类型'];
      if (typeof type === 'string' && type.trim()) imageTypes.set(type.trim(), (imageTypes.get(type.trim()) ?? 0) + 1);
    });
  });
  const placement = Object.fromEntries(Object.entries(INFORMATION_PATTERNS).map(([name, pattern]) => {
    let body = 0;
    let comment = 0;
    let commentOnly = 0;
    rows.forEach((row) => {
      const inBody = pattern.test(bodyWithoutHashtags(text(row, '正文')));
      const inComment = pattern.test(text(row, '评论区内容'));
      if (inBody) body += 1;
      if (inComment) comment += 1;
      if (!inBody && inComment) commentOnly += 1;
    });
    return [name, { body, comment, commentOnly }];
  }));

  const profile = {
    schemaVersion: '2.0',
    id: 'xhs-reference-corpus-descriptive-v1',
    name: '小红书对标样本描述性画像',
    source: basename(source),
    evidenceStatus: 'descriptive_sample',
    sampleSize: rows.length,
    caveat: '这些统计只描述当前样本，不代表质量因果关系、平台推荐规律或最优取值。',
    distributions: {
      titleChars: distribution(titles.map((value) => [...value].length)),
      bodyCharsWithoutHashtags: distribution(bodies.map((value) => [...value].length)),
      commentTotalCharsWithoutRolePrefix: distribution(commentLineGroups.map((lines) => [...lines.join('')].length)),
      commentLineCharsWithoutRolePrefix: distribution(commentLineGroups.flat().map((value) => [...value].length)),
      bodyParagraphs: distribution(bodies.map((value) => value.split(/\n+/u).filter(Boolean).length)),
      commentLines: distribution(commentLineGroups.map((lines) => lines.length)),
      imageCount: distribution(imageCounts),
    },
    counts: {
      bodyAtMost100Chars: bodies.filter((value) => [...value].length <= 100).length,
      bodyAtMost150Chars: bodies.filter((value) => [...value].length <= 150).length,
      bodyAtLeast300Chars: bodies.filter((value) => [...value].length >= 300).length,
    },
    informationPlacement: placement,
    imageTypes: Object.fromEntries([...imageTypes.entries()].sort((a, b) => b[1] - a[1])),
    measurementNotes: [
      '正文长度已移除 #标签[话题]# 与普通 #标签。',
      '评论总长和单行长度已移除“评1：”“博主回：”等转录前缀。',
      '图片类型来自样本人工提炼字段，只作描述性计数。',
    ],
  };
  const serialized = `${JSON.stringify(profile, null, 2)}\n`;
  if (output) await writeFile(resolve(output), serialized, 'utf8');
  else process.stdout.write(serialized);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  parseDraftRequest,
  MAX_MERGE_ITEMS,
  MAX_TOTAL_CONTENT_CHARS,
  isEnrichConfidence,
  parseMergeRequest,
  parseSaveRequest,
} from '../src/intelligence-enrich.types.js';

describe('parseMergeRequest', () => {
  it('接受有效请求并回传规范化结果', () => {
    const parsed = parseMergeRequest({
      items: [{ gapId: 'gap-1', status: 'edited', content: '  正文  ' }],
      targetFile: 'INDEX.md',
    });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].gapId, 'gap-1');
    assert.equal(parsed.items[0].status, 'edited');
    assert.equal(parsed.items[0].content, '正文');
    assert.equal(parsed.targetFile, 'INDEX.md');
  });

  it('targetFile 缺省时为 undefined,由服务层决定落到哪个文件', () => {
    for (const body of [
      { items: [{ gapId: 'g', status: 'confirmed' }] },
      { items: [{ gapId: 'g', status: 'confirmed' }], targetFile: null },
    ]) {
      assert.equal(parseMergeRequest(body).targetFile, undefined);
    }
  });

  it('deleted 项不需要 content', () => {
    const parsed = parseMergeRequest({ items: [{ gapId: 'g', status: 'deleted' }] });
    assert.equal(parsed.items[0].content, undefined);
  });

  it('拒绝空 items', () => {
    assert.throws(() => parseMergeRequest({ items: [] }), BadRequestException);
  });

  it('拒绝非数组 items', () => {
    assert.throws(() => parseMergeRequest({ items: 'gap-1' }), BadRequestException);
    assert.throws(() => parseMergeRequest({}), BadRequestException);
  });

  it('拒绝超过上限的 items', () => {
    const items = Array.from({ length: MAX_MERGE_ITEMS + 1 }, (_, index) => ({
      gapId: `g${index}`,
      status: 'confirmed',
    }));
    assert.throws(() => parseMergeRequest({ items }), BadRequestException);
    // 恰好等于上限要放过,别把边界写成 off-by-one
    assert.doesNotThrow(() => parseMergeRequest({ items: items.slice(0, MAX_MERGE_ITEMS) }));
  });

  it('拒绝未知 status', () => {
    for (const status of ['approved', 'pending', 'editing', '']) {
      assert.throws(
        () => parseMergeRequest({ items: [{ gapId: 'g', status }] }),
        BadRequestException,
        `应拒绝 status=${status}`,
      );
    }
  });

  it('拒绝缺少或非字符串的 gapId', () => {
    assert.throws(() => parseMergeRequest({ items: [{ status: 'confirmed' }] }), BadRequestException);
    assert.throws(() => parseMergeRequest({ items: [{ gapId: 42, status: 'confirmed' }] }), BadRequestException);
  });

  it('拒绝路径穿越或非法扩展名的 targetFile', () => {
    for (const targetFile of [
      '../../../etc/passwd',
      'a/b.md',
      'a\\b.md',
      '.hidden.md',
      'x.exe',
      'noext',
    ]) {
      assert.throws(
        () => parseMergeRequest({ items: [{ gapId: 'g', status: 'confirmed' }], targetFile }),
        BadRequestException,
        `应拒绝 ${targetFile}`,
      );
    }
  });

  it('接受 .md / .txt 且大小写不敏感', () => {
    for (const targetFile of ['INDEX.md', '资料.MD', 'notes.txt', 'a.TXT']) {
      assert.equal(
        parseMergeRequest({ items: [{ gapId: 'g', status: 'confirmed' }], targetFile }).targetFile,
        targetFile,
      );
    }
  });

  it('拒绝总长度超限,但单条不超限的正常请求放过', () => {
    const ok = [
      { gapId: 'a', status: 'edited', content: 'x'.repeat(19_000) },
      { gapId: 'b', status: 'edited', content: 'y'.repeat(19_000) },
    ];
    assert.doesNotThrow(() => parseMergeRequest({ items: ok }));

    const many = Array.from(
      { length: Math.ceil(MAX_TOTAL_CONTENT_CHARS / 19_000) + 1 },
      (_, index) => ({ gapId: `g${index}`, status: 'edited', content: 'z'.repeat(19_000) }),
    );
    assert.throws(() => parseMergeRequest({ items: many }), BadRequestException);
  });

  it('拒绝非对象请求体', () => {
    for (const body of [null, undefined, [], 'x', 7]) {
      assert.throws(() => parseMergeRequest(body), BadRequestException);
    }
  });
});

describe('parseSaveRequest', () => {
  it('接受有效请求', () => {
    const parsed = parseSaveRequest({ content: '# 标题', targetFile: '补充资料.md', baseFileId: 'file-v1' });
    assert.equal(parsed.targetFile, '补充资料.md');
    assert.equal(parsed.content, '# 标题');
    assert.equal(parsed.baseFileId, 'file-v1');
  });

  it('新文件用 null 作为预览基线', () => {
    assert.equal(parseSaveRequest({ content: 'x', targetFile: 'a.md', baseFileId: null }).baseFileId, null);
  });

  it('targetFile 必填', () => {
    assert.throws(() => parseSaveRequest({ content: 'x', baseFileId: null }), BadRequestException);
  });

  it('content 必填且不能是空串', () => {
    assert.throws(() => parseSaveRequest({ targetFile: 'a.md', baseFileId: null }), BadRequestException);
    assert.throws(() => parseSaveRequest({ content: '   ', targetFile: 'a.md', baseFileId: null }), BadRequestException);
  });

  it('baseFileId 必填且只能是字符串或 null', () => {
    assert.throws(() => parseSaveRequest({ content: 'x', targetFile: 'a.md' }), BadRequestException);
    assert.throws(() => parseSaveRequest({ content: 'x', targetFile: 'a.md', baseFileId: 1 }), BadRequestException);
  });

  it('按字节而非字符判断 2 MiB 上限', () => {
    // 中文一字三字节:700_000 字符 = 2.1 MB > 2 MiB,只看字符数会漏过
    assert.throws(
      () => parseSaveRequest({ content: '中'.repeat(700_000), targetFile: 'a.md', baseFileId: null }),
      BadRequestException,
    );
  });

  it('拒绝路径穿越的 targetFile', () => {
    assert.throws(
      () => parseSaveRequest({ content: 'x', targetFile: '../../evil.md', baseFileId: null }),
      BadRequestException,
    );
  });
});

describe('isEnrichConfidence', () => {
  it('只认 low / medium / high', () => {
    for (const value of ['low', 'medium', 'high']) assert.equal(isEnrichConfidence(value), true);
    for (const value of ['LOW', 'unknown', '', null, undefined, 1, {}]) {
      assert.equal(isEnrichConfidence(value), false);
    }
  });
});

describe('parseDraftRequest', () => {
  it('body 缺省或不带 gapIds 时为整批模式', () => {
    for (const body of [undefined, null, {}, { gapIds: null }]) {
      assert.deepEqual(parseDraftRequest(body), {});
    }
  });

  it('接受 gapIds 并去重', () => {
    const parsed = parseDraftRequest({ gapIds: ['a', 'b', 'a'] });
    assert.deepEqual(parsed.gapIds, ['a', 'b']);
  });

  it('拒绝空数组:不指定就该整批,空数组是调用方搞错了', () => {
    assert.throws(() => parseDraftRequest({ gapIds: [] }), BadRequestException);
  });

  it('拒绝非数组与非字符串元素', () => {
    assert.throws(() => parseDraftRequest({ gapIds: 'a' }), BadRequestException);
    assert.throws(() => parseDraftRequest({ gapIds: [42] }), BadRequestException);
  });

  it('拒绝超过上限', () => {
    const gapIds = Array.from({ length: MAX_MERGE_ITEMS + 1 }, (_, i) => `g${i}`);
    assert.throws(() => parseDraftRequest({ gapIds }), BadRequestException);
  });
});

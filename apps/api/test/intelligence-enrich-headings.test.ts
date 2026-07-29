import assert from 'node:assert/strict';
import test from 'node:test';
import { demoteHeadings } from '../src/intelligence-enrich.service.js';

/*
  合并时每条补充被包进 `## 缺口标题`,所以草稿正文里的标题必须落在三级以下。

  实测产出过层级倒置的文档:「### 终身质保具体条款」下面挂「## 终身质保的具体含义」。
  深级标题下出现浅级标题,在大纲视图里会断层,模型续写时也容易跟着错。
*/

test('二级标题压到三级', () => {
  assert.equal(demoteHeadings('## 小标题\n正文'), '### 小标题\n正文');
});

test('保留正文内部原有的层级关系', () => {
  // ## / ### 差一级,整体平移后仍差一级
  const input = '## 顶层\n正文\n### 次级\n正文';
  assert.equal(demoteHeadings(input), '### 顶层\n正文\n#### 次级\n正文');
});

test('已经在三级或更深的不动', () => {
  const input = '### 已经够深\n正文\n#### 更深\n正文';
    assert.equal(demoteHeadings(input), input);
});

test('按最浅一级对齐,不是逐行钳制', () => {
  /*
   * 只把 < 3 的那些提到 3、其余不动,会压掉层级差:
   * `# 一级` 和 `## 二级` 都变成 `### `,两级并成一级。
   * 正确做法是整体平移,这里 shift=+2。
   */
  const input = '# 一级\n## 二级\n### 三级';
  assert.equal(demoteHeadings(input), '### 一级\n#### 二级\n##### 三级');
});

test('六级是上限,超出的钳在六级', () => {
  // 生成 ####### 就不再是标题了,Markdown 会当普通文本渲染
  assert.equal(demoteHeadings('## a\n###### b'), '### a\n###### b');
});

test('没有标题时原样返回', () => {
  const input = '就是一段普通正文,没有任何标题。\n\n第二段。';
  assert.equal(demoteHeadings(input), input);
});

test('不碰行内的 # 和代码块里的井号', () => {
  // 只匹配行首 + 后跟空格的 ATX 标题
  const input = '价格是 #1 的问题\nC# 是一门语言';
  assert.equal(demoteHeadings(input), input);
});

test('不把 #标题(缺空格)当标题', () => {
  // ATX 语法要求 # 后有空格,`#hashtag` 不是标题
  const input = '#不是标题\n## 是标题';
  assert.equal(demoteHeadings(input), '#不是标题\n### 是标题');
});

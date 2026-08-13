import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { CopyMiniButton } from '../src/components/CopyMiniButton.js';

test('copy-mini 在硬阻断时真实渲染为禁用按钮', () => {
  const blocked = renderToStaticMarkup(createElement(CopyMiniButton, {
    deliverable: false,
    onCopy: () => undefined,
  }));
  assert.match(blocked, /class="copy-mini"/u);
  assert.match(blocked, /disabled=""/u);
  assert.match(blocked, /aria-disabled="true"/u);

  const allowed = renderToStaticMarkup(createElement(CopyMiniButton, {
    deliverable: true,
    onCopy: () => undefined,
  }));
  assert.doesNotMatch(allowed, /disabled=""/u);
  assert.match(allowed, /aria-disabled="false"/u);
});

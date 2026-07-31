import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

const productionSource = sourceFiles(sourceRoot)
  .map((path) => ({ path, source: readFileSync(path, 'utf8') }));

test('production UI never imports demo fixtures or restores demo records', () => {
  for (const file of productionSource) {
    assert.doesNotMatch(file.source, /from\s+["'].*fixtures["']/u, file.path);
    assert.doesNotMatch(file.source, /content-agent-demo-/u, file.path);
    assert.doesNotMatch(file.source, /demo(?:Projects|Knowledge|Formulas|Generations|Settings)/u, file.path);
  }
});

test('preset failures cannot be converted into browser-local success', () => {
  for (const relativePath of [
    '../src/pages/GeneratorPage.tsx',
    '../src/components/quick/ConfigTab.tsx',
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|readLocalPresets|writeLocalPresets/u, relativePath);
    assert.doesNotMatch(source, /id:\s*["'`]local-/u, relativePath);
    assert.doesNotMatch(source, /(?:server|\u670d\u52a1\u5668).*?(?:browser|\u6d4f\u89c8\u5668)/iu, relativePath);
  }
});

test('generation detail is server-backed and production source maps stay disabled', () => {
  const resultPage = readFileSync(new URL('../src/pages/GenerationResultPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(resultPage, /sessionStorage|recordSource|generationRecordNotice/u);

  const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(viteConfig, /sourcemap:\s*false/u);
  assert.doesNotMatch(viteConfig, /sourcemap:\s*true/u);
});

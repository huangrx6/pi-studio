import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function compile(path) {
  const source = fs.readFileSync(new URL(`../../web/src/features/usage/${path}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, require: (id) => (id.endsWith('.css') ? {} : require(id)) };
  vm.runInNewContext(compiled, context);
  return context.exports;
}

const day = (index, totalTokens) => ({ day: `2026-01-${String(index + 1).padStart(2, '0')}`, totalTokens, requests: 1 });

test('sparkline draws one point per day and labels the peak for assistive tech', () => {
  const { UsageSparkline } = compile('UsageSparkline.tsx');
  const html = renderToStaticMarkup(React.createElement(UsageSparkline, {
    daily: [day(0, 0), day(1, 1200), day(2, 4800)],
  }));
  assert.match(html, /class="usage-sparkline"/);
  assert.match(html, /viewBox="0 0 100 40"/);
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="近 3 天每日 Token 趋势，峰值 4,800"/);
  const points = html.match(/points="([^"]+)"/)[1].split(' ');
  assert.equal(points.length, 3);
  // 峰值落在顶部附近，零值落在基线上。
  assert.equal(points[2].split(',')[1], '4.00');
  assert.equal(points[0].split(',')[1], '38.00');
});

test('sparkline keeps the last 30 days and stays silent without a trend', () => {
  const { UsageSparkline } = compile('UsageSparkline.tsx');
  const daily = Array.from({ length: 45 }, (_, index) => day(index % 28, 100 + index));
  const html = renderToStaticMarkup(React.createElement(UsageSparkline, { daily }));
  assert.match(html, /近 30 天每日 Token 趋势/);
  assert.equal(html.match(/points="([^"]+)"/)[1].split(' ').length, 30);
  assert.equal(renderToStaticMarkup(React.createElement(UsageSparkline, { daily: [day(0, 5)] })), '');
  assert.equal(renderToStaticMarkup(React.createElement(UsageSparkline, { daily: [] })), '');
});

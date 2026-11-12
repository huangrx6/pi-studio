import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { splitMessageText, splitComposerText } from '../../web/src/features/conversation/references.ts';

const require = createRequire(import.meta.url);
function compile(file, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../../web/src/${file}`, import.meta.url), 'utf8');
  const context = { exports: {}, require: id => dependencies[id] || require(id) };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}
const attachments = compile('shared/AttachmentIcon.tsx');
const { ReferenceChip } = compile('features/conversation/ReferenceChip.tsx', { '../../shared/AttachmentIcon': attachments });
const render = reference => renderToStaticMarkup(React.createElement(ReferenceChip, { reference }));

test('composer and message paths produce identical chips with complete transport tokens', () => {
  for (const token of ['@.qa/', '@src/App.tsx', '@"docs/设计方案 v2.pdf"', '/skill:skill-creator']) {
    const editor = splitComposerText(token, new Set())[0].reference;
    const message = splitMessageText(token)[0].reference;
    assert.equal(render(editor), render(message));
    assert.match(render(editor), /data-reference-token=/);
    assert.match(render(editor), /contenteditable="false"/);
  }
});

test('reference icons distinguish folders, data, configuration, media and unknown files', () => {
  const cases = [
    ['@.qa/', 'folder'], ['@src/main.tsx', 'file-code2'], ['@package.json', 'file-json2'],
    ['@.env.local', 'file-sliders'], ['@Dockerfile', 'file-terminal'], ['@db.sqlite', 'database'],
    ['@notes.md', 'file-text'], ['@spec.pdf', 'file-type2'], ['@report.xlsx', 'file-spreadsheet'],
    ['@slides.pptx', 'presentation'], ['@photo.PNG', 'file-image'], ['@music.mp3', 'file-audio2'],
    ['@movie.mp4', 'file-video2'], ['@release.tar.gz', 'file-archive'], ['@unknown.weird', 'lucide-file"'],
  ];
  for (const [token, icon] of cases) assert.ok(render(splitMessageText(token)[0].reference).includes(icon), `${token}: ${icon}`);
});

test('reference labels and full path attributes escape markup', () => {
  const html = render({ kind: 'file', token: '@"<img>.md"', label: '<img>.md', location: 'docs/"<img>.md' });
  assert.ok(html.includes('&lt;img&gt;.md'));
  assert.ok(html.includes('&quot;'));
  assert.ok(!html.includes('<img'));
});

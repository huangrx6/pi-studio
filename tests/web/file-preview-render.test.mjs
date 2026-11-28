import assert from 'node:assert/strict';
import { Accordion } from './helpers/accordion.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as helpers from '../../web/src/shared/file-preview.ts';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../../web/src/shared/FilePreview.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Render the actual component with React; count expensive helper calls rather
// than asserting implementation text or relying on machine-dependent timings.
function fixture() {
  const calls = { json: 0, fence: 0, table: 0 };
  const markdownChrome = [];
  const sourceViews = [];
  const context = {
    exports: {},
    require(id) {
      if (id.endsWith('.css')) return {};
      if (id === './editor-state') return require('../../web/src/shared/editor-state.ts');
      if (id === 'react') return { ...React, lazy: () => props => {
        sourceViews.push(props);
        return React.createElement('code', null, props.text);
      } };
      if (id === './Accordion') return { Accordion };
      if (id === './FilePreviewMenu') return { FilePreviewMenu: () => null };
      if (id === './ArchivePreview') return { ArchivePreview: ({ data }) => React.createElement('div', null, data.format) };
      if (id === './LoadingState') return { LoadingIndicator: () => null, LoadingState: ({ children }) => React.createElement('span', null, children) };
      if (id === './file-preview.ts') return {
        ...helpers,
        prettyJson(text) { calls.json++; return helpers.prettyJson(text); },
        markdownCodeFence(text, language) { calls.fence++; return helpers.markdownCodeFence(text, language); },
        parseDelimitedPreview(text, delimiter) { calls.table++; return helpers.parseDelimitedPreview(text, delimiter); },
      };
      if (id === './Markdown') return { Markdown: ({ children, codeChrome }) => {
        markdownChrome.push(codeChrome ?? true);
        return React.createElement('pre', null, children);
      } };
      if (id === './FileKindIcon') return {
        FileKindIcon: ({ path }) => React.createElement('span', { 'data-path': path }),
        FileFormatIcon: ({ format }) => React.createElement('span', { 'data-format': format }),
      };
      if (id === './filesize') return { formatFileSize: size => `${size} B` };
      return require(id);
    },
  };
  vm.runInNewContext(compiled, context);
  return {
    calls,
    markdownChrome,
    sourceViews,
    render(path, text, overrides = {}, props = {}) {
      return renderToStaticMarkup(React.createElement(context.exports.FilePreview, {
        file: { path, name: path, text, size: text.length, kind: 'text', ...overrides },
        ...props,
      }));
    },
  };
}

test('plain text bypasses JSON parsing and Markdown fence construction while preserving original text', () => {
  const { calls, render, sourceViews } = fixture();
  // Large backtick-heavy text previously incurred both irrelevant transforms.
  const text = 'literal ` content\r\n'.repeat(10_000);
  render('notes.txt', text);
  assert.deepEqual(calls, { json: 0, fence: 0, table: 0 });
  assert.equal(sourceViews[0].text, text);
});

test('a pending file read replaces the empty prompt, and a refresh keeps the current contents visible', () => {
  const { render } = fixture();
  const pending = render('notes.md', '', {}, { file: null, loading: true });
  assert.match(pending, /正在读取文件/);
  assert.doesNotMatch(pending, /选择一个文件/);
  assert.match(render('notes.md', '', {}, { file: null }), /选择一个文件/);
  assert.match(render('notes.md', '# Current text', {}, { loading: true }), /# Current text/);
});

test('each format runs only its required text preparation', () => {
  const { calls, markdownChrome, render, sourceViews } = fixture();
  assert.match(render('notes.md', '# Heading'), /# Heading/);
  assert.match(render('page.html', '<h1>Heading</h1>'), /sandbox=""/);
  assert.match(render('picture.png', '', { kind: 'image', dataUrl: 'data:image/png;base64,AA==' }), /<img/);
  assert.deepEqual(calls, { json: 0, fence: 0, table: 0 });
  assert.match(render('data.csv', 'name,value\nAlpha,2'), /<td>Alpha<\/td>/);
  assert.deepEqual(calls, { json: 0, fence: 0, table: 1 });
  render('script.ts', 'const value = 2;');
  assert.equal(sourceViews.at(-1).path, 'script.ts');
  assert.equal(sourceViews.at(-1).text, 'const value = 2;');
  assert.deepEqual(markdownChrome, [true]);
  assert.deepEqual(calls, { json: 0, fence: 0, table: 1 });
});

test('JSON still formats valid content and preserves invalid content with a visible warning', () => {
  const { calls, render, sourceViews } = fixture();
  const valid = render('data.json', '{"count":2}');
  assert.match(valid, /\n  &quot;count&quot;: 2\n/);
  assert.ok(!valid.includes('JSON 格式有误'));
  const invalid = render('invalid.json', '{broken');
  assert.match(invalid, /JSON 格式有误/);
  assert.match(invalid, /\{broken/);
  render('data.json', '{"count":2}', {}, {sourceOnOpen:true});
  assert.equal(sourceViews.at(-1).text, '{"count":2}');
  assert.deepEqual(calls, { json: 2, fence: 0, table: 0 });
});

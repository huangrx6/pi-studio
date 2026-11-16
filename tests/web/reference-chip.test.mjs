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
const manifest = require('material-icon-theme/dist/material-icons.json');
const associations = group => new Map(Object.entries(group).map(([key, id]) => [key.toLowerCase(), id]));
const theme = {
  fileNames: associations(manifest.fileNames), fileExtensions: associations(manifest.fileExtensions),
  urls: Object.fromEntries(Object.entries(manifest.iconDefinitions).map(([id, value]) => [id, value.iconPath])),
  lightIcons: { toml: 'toml_light' },
};
const resolver = compile('shared/file-icon.ts', { 'virtual:studio-file-icons': theme });
const icons = compile('shared/FileKindIcon.tsx', { './file-icon': resolver, 'virtual:studio-file-icons': theme });
const { ReferenceChip } = compile('features/conversation/ReferenceChip.tsx', { '../../shared/FileKindIcon': icons });
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
    ['@src/main.tsx', 'react_ts'], ['@package.json', 'nodejs'], ['@.env.local', 'tune'],
    ['@Dockerfile', 'docker'], ['@db.sqlite', 'database'], ['@notes.md', 'markdown'],
    ['@spec.pdf', 'pdf'], ['@report.xlsx', 'table'], ['@slides.pptx', 'powerpoint'],
    ['@photo.PNG', 'image'], ['@music.mp3', 'audio'], ['@movie.mp4', 'video'],
    ['@release.tar.gz', 'zip'], ['@unknown.weird', 'file'],
  ];
  assert.match(render(splitMessageText('@.qa/')[0].reference), /lucide-folder/);
  for (const [token, id] of cases) assert.ok(render(splitMessageText(token)[0].reference).includes(`data-file-icon="${id}"`), token);
});

test('reference labels and full path attributes escape markup', () => {
  const html = render({ kind: 'file', token: '@"<img>.md"', label: '<img>.md', location: 'docs/"<img>.md' });
  assert.ok(html.includes('&lt;img&gt;.md'));
  assert.ok(html.includes('&quot;'));
  assert.equal((html.match(/<img /g) || []).length, 1, 'only the trusted file icon becomes an image');
});

test('file icons respect full names, scoped paths, compound suffixes and MIME fallbacks', () => {
  for (const [path, mime, expected] of [
    ['C:\\repo\\.github\\FUNDING.yml', '', 'github-sponsors'],
    ['src/APP.D.TS', '', 'typescript-def'], ['src/model.ts', '', 'typescript'],
    ['.env.staging-west', '', 'tune'], ['Dockerfile.custom', '', 'docker'],
    ['.github/workflows/publish.yml', '', 'github-actions-workflow'],
    ['download', 'application/problem+json', 'json'], ['download', 'image/png', 'image'],
    ['image.py', 'image/png', 'python'], ['unknown.constructor', '', 'file'],
  ]) {
    const id = resolver.fileIconId(path, mime);
    assert.equal(id, expected, path);
    assert.ok(theme.urls[id], `missing asset for ${path}`);
  }
});

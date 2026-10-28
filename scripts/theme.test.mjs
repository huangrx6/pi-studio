import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.resolve('vite'));
const postcss = require('postcss');
const palette = postcss.parse(fs.readFileSync('web/src/styles/palette.css', 'utf8'));
const files = fs.readdirSync('web/src', { recursive: true }).filter(f => /\.(css|tsx|ts)$/.test(f)).map(f => path.join('web/src', f));
function tokens(mode) {
  const result = {};
  palette.walkRules(rule => {
    if (rule.selector === ':root' || (mode === 'dark' && rule.selector === ':root[data-theme="dark"]')) rule.walkDecls(d => { if(d.prop.startsWith('--')) result[d.prop] = d.value; });
  });
  const resolve = (key, seen = new Set()) => {
    assert.ok(!seen.has(key), `circular palette token ${key}`);
    seen.add(key); assert.ok(result[key], `missing palette token ${key}`);
    return result[key].replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(name, new Set(seen)));
  };
  return Object.fromEntries(Object.keys(result).map(k => [k, resolve(k)]));
}
function luminance(hex) {
  const rgb = hex.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  assert.ok(rgb, `contrast requires an opaque palette color: ${hex}`);
  const c = rgb.slice(1).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
  return c[0]*.2126+c[1]*.7152+c[2]*.0722;
}
test('all CSS color literals and color calculations live in palette.css', () => {
  for(const file of files.filter(f=>f.endsWith('.css') && !f.endsWith('/palette.css'))) {
    postcss.parse(fs.readFileSync(file,'utf8')).walkDecls(d=>{
      assert.ok(!/#[\da-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|\b(?:white|black|transparent)\b(?![\w-])/.test(d.value.replace(/var\([^)]*\)/g,'')), `${file}: ${d.prop}: ${d.value}`);
    });
  }
  for(const file of files.filter(f=>/\.tsx?$/.test(f))) {
    assert.ok(!/(?:color|background|fill|stroke)\s*:\s*['"](?:#|rgba?\(|white|black)/.test(fs.readFileSync(file,'utf8')), file);
  }
});
test('all referenced design tokens resolve', () => {
  const declared = new Set(['--chat-font-size','--provider-icon-size']);
  const used = new Set();
  for(const file of files.filter(f=>f.endsWith('.css'))) postcss.parse(fs.readFileSync(file,'utf8')).walkDecls(d=>{
    if(d.prop.startsWith('--'))declared.add(d.prop);
    for(const m of d.value.matchAll(/var\((--[\w-]+)/g))used.add(m[1]);
  });
  assert.deepEqual([...used].filter(k=>!declared.has(k)), []);
});
for(const mode of ['light','dark']) test(`${mode} has neutral surfaces and readable semantic color pairs`,()=>{
  const t = tokens(mode);
  for(const key of ['--bg','--surface','--sidebar-bg']) {
    const color = t[key].slice(1).match(/../g).map(v=>parseInt(v,16));
    assert.equal(Math.max(...color)-Math.min(...color),0, `${mode} ${key} must stay neutral`);
  }
  const pairs = [
    ['--text','--bg'],['--muted','--surface'],['--faint','--surface-soft'],
    ['--accent','--accent-soft'],['--on-button','--button-bg'],['--on-button','--button-hover'],
    ['--error','--error-soft'],['--warning','--warning-soft'],['--success','--success-soft'],
    ['--syntax-keyword','--code-bg'],['--syntax-string','--code-bg'],['--syntax-number','--code-bg'],['--syntax-function','--code-bg'],['--selection-text','--selection'],
  ];
  for(const [fg,bg] of pairs) {
    const values=[luminance(t[fg]),luminance(t[bg])].sort((a,b)=>b-a);
    const ratio=(values[0]+.05)/(values[1]+.05);
    assert.ok(ratio>=4.5, `${mode} ${fg}/${bg} contrast ${ratio.toFixed(2)}`);
  }
});
test('Electron reads both backgrounds from the same palette', () => {
  const { themeBackground } = createRequire(import.meta.url)('../electron/theme.cjs');
  assert.equal(themeBackground('light',true), tokens('light')['--bg']);
  assert.equal(themeBackground('dark',false), tokens('dark')['--bg']);
  assert.equal(themeBackground('system',true), tokens('dark')['--bg']);
  assert.equal(themeBackground('system',false), tokens('light')['--bg']);
});

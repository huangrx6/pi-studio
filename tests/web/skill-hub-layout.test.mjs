import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync('web/src/features/skills/styles/skill-hub.css', 'utf8');
const source = readFileSync('web/src/features/skills/SkillHub.tsx', 'utf8');
const catalog = readFileSync('web/src/features/skills/SkillCatalogDialog.tsx', 'utf8');

test('the skill hub loading state stays frameless inside its own card', () => {
  assert.match(source, /<LoadingState variant="section">正在读取技能源/);
  assert.match(source, /<LoadingState variant="section">正在准备技能预览/);
  const loadingCss = readFileSync('web/src/styles/loading.css', 'utf8');
  const sectionRules = loadingCss.match(/\.loading-state(?:--section)?\s*(?:,\s*\.loading-state--panel\s*)?\{[^}]*}/g);
  assert.ok(sectionRules, 'shared loading rules exist');
  for (const rule of sectionRules) assert.doesNotMatch(rule, /\b(?:border|background)\s*:/, 'no extra frame inside the skills card or its dialog');
});

test('the settings overview opens a bounded, independently scrollable card catalog', () => {
  assert.match(source, /className="skill-hub-overview-row"/);
  assert.match(source, /onClick=\{\(\) => setBrowse\(\{ sourceId: source\.id \}\)\}/);
  assert.doesNotMatch(source, /className="skill-hub-grid"/);
  assert.match(catalog, /<DetailDialog className="skill-catalog-dialog"/);
  assert.match(catalog, /matches\.slice\(0, visibleCount\)/);
  assert.match(css, /\.skill-catalog-results\s*\{[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/);
  assert.match(css, /\.skill-hub-grid\s*\{[^}]*repeat\(auto-fill,/);
});

test('empty source setup keeps one action and omits search, management and refresh', () => {
  assert.match(source, /const hasSources = Boolean\(snapshot\?\.sources\.length\)/);
  assert.match(source, /\(hasSources \|\| error\) && <div className="skill-hub-actions">/);
  assert.match(source, /\{hasSources && <button[^>]*aria-haspopup="dialog" onClick=\{\(\) => setBrowse\(\{\}\)\}>/);
  assert.match(source, /\{hasSources && <button type="button" className="settings-outline" onClick=\{\(\) => setManagerOpen\(true\)\}>/);
  assert.match(source, /<h2>技能源 \{hasSources &&/);
});

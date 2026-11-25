import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sourceStatusLabel } from '../../web/src/features/skills/skill-catalog.ts';

const css = readFileSync('web/src/features/skills/styles/skill-hub.css', 'utf8');
const source = readFileSync('web/src/features/skills/SkillHub.tsx', 'utf8');
const catalog = readFileSync('web/src/features/skills/SkillCatalogDialog.tsx', 'utf8');

test('skill counts are shown only for successfully read, enabled sources', () => {
  const source = { enabled: true, lastError: '' };
  assert.equal(sourceStatusLabel(source, 0, false), '0 个技能');
  assert.equal(sourceStatusLabel(source, 9, false), '9 个技能');
  const failed = { ...source, lastError: '读取失败的原因' };
  assert.equal(sourceStatusLabel(failed, 0, false), '读取失败');
  assert.equal(sourceStatusLabel(failed, 0, true), '正在读取…');
  assert.equal(sourceStatusLabel({ ...failed, enabled: false }, 0, true), '已停用');
});

test('the skill hub loading state stays frameless in the overview and install preview', () => {
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
  const actions = source.match(/\{hasSources && <div className="skill-hub-actions">([\s\S]+?)<\/div>\}/)?.[1];
  assert.ok(actions);
  assert.match(actions, /搜索技能/);
  assert.match(actions, /管理源/);
  assert.match(actions, /aria-label="刷新技能源"/);
  assert.match(source, /<h2>技能源\{hasSources &&/);
});

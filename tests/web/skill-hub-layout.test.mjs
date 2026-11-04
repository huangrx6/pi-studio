import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync('web/src/features/skills/skill-hub.css', 'utf8');
const source = readFileSync('web/src/features/skills/SkillHub.tsx', 'utf8');

test('the skill hub loading state stays frameless inside its own card', () => {
  const rule = /\.skill-hub-loading\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.ok(rule, 'skill hub loading rule exists');
  // 卡片本身已经有边框；加载态再套一层框会变成“框中框”。
  assert.equal(/\bborder\s*:/.test(rule), false, 'no border on the inline loading state');
  assert.equal(/\bbackground\s*:/.test(rule), false, 'no panel background on the inline loading state');
  // 页面级占位（带框）只用于整页加载；这个页面里所有加载都走同一份无框样式。
  assert.equal(source.includes('settings-loading'), false, 'no framed placeholder inside the skills card or its dialog');
});

test('sources and their skills are layered instead of one flat list', () => {
  // 源导航 + 源总览 + 单源详情：三层结构缺一不可，否则技能多时会变成灾难。
  assert.match(source, /className="skill-hub-sources"/);
  assert.match(source, /className="skill-hub-overview-row"/);
  assert.match(source, /className="skill-hub-detail-head"/);
  assert.match(source, /SKILL_PAGE_SIZE/);
  assert.match(css, /\.skill-hub-body\s*\{[^}]*grid-template-columns/);
});

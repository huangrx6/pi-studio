/**
 * 会话标题清洗的单元测试。
 *
 * 背景：Pi 在写入历史前会把 `/skill:name` 展开成 `<skill ...>正文</skill>`，
 * 如果直接取首行做标题，侧边栏会出现一整段 `<skill name="...">`。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanSessionTitle, sessionTitle } = require('../electron/services/session-title.cjs');

test('skill blocks are stripped from the title and the real request is kept', () => {
  const text = '<skill name="deck-authoring" location="/x/SKILL.md">\n# 演示\n很长的技能正文\n</skill>\n\n给我做一版汇报 PPT';
  assert.equal(cleanSessionTitle(text), '给我做一版汇报 PPT');
});

test('titles collapse whitespace, truncate at 80 chars, and fall back when empty', () => {
  assert.equal(cleanSessionTitle('  第一行\n\n第二行  '), '第一行 第二行');
  assert.equal(cleanSessionTitle('a'.repeat(100)).length, 80);
  assert.equal(cleanSessionTitle('<skill name="x">only skill</skill>'), '新会话');
  assert.equal(cleanSessionTitle('', '自定义兜底'), '自定义兜底');
});

test('an explicit session name wins over the first message', () => {
  assert.equal(sessionTitle('已重命名的会话', '随便什么内容'), '已重命名的会话');
  assert.equal(sessionTitle('   ', '<skill name="x">正文</skill>\n真实问题'), '真实问题');
  assert.equal(sessionTitle(undefined, ''), '新会话');
});

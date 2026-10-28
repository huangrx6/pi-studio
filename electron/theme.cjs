/**
 * 窗口底色。
 *
 * 原生窗口的 backgroundColor 必须和渲染进程一致（否则启动瞬间会闪一下），
 * 所以这里直接从 palette.css 解析 --bg，避免颜色写两份。
 */

const fs = require('node:fs');
const path = require('node:path');

// The native window uses the same palette as the renderer, including at startup.
const palette = fs.readFileSync(path.join(__dirname, '../web/src/styles/palette.css'), 'utf8');
const backgrounds = Object.fromEntries(['light', 'dark'].map((theme) => {
  const selector = theme === 'light' ? ':root {' : ':root[data-theme="dark"] {';
  const block = palette.slice(palette.indexOf(selector) + selector.length).split('}')[0];
  const color = block.match(/--bg:\s*(#[\da-f]{6})\s*;/i)?.[1];
  if (!color) throw new Error(`Missing --bg in the ${theme} palette`);
  return [theme, color];
}));

function themeBackground(preference, systemDark) {
  return backgrounds[preference === 'system' ? (systemDark ? 'dark' : 'light') : preference];
}
module.exports = { themeBackground };

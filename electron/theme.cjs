/**
 * 窗口底色。
 *
 * 原生窗口的 backgroundColor 必须和渲染进程一致（否则启动瞬间会闪一下），
 * 所以这里直接从 palette.css 解析外框使用的 --surface-chrome：窗口的四角、
 * 边缘和启动首帧都应该是外框的 chrome 底色，而不是内容画布色。
 */

const fs = require('node:fs');
const path = require('node:path');

// The native window uses the same palette as the renderer, including at startup.
const palette = fs.readFileSync(path.join(__dirname, '../web/src/styles/palette.css'), 'utf8');
function paletteBlock(selector) {
  return palette.slice(palette.indexOf(selector) + selector.length).split('}')[0];
}

/** 读取一个颜色令牌；允许一层 var(--x) 别名，因为语义令牌指向四级表面。 */
function readColor(block, name) {
  const raw = block.match(new RegExp(`--${name}:\\s*([^;]+);`, 'i'))?.[1]?.trim();
  if (!raw) return undefined;
  const alias = raw.match(/^var\(\s*--([\w-]+)\s*\)$/);
  return alias ? readColor(block, alias[1]) : (raw.match(/^#[\da-f]{6}$/i) ? raw : undefined);
}

const backgrounds = Object.fromEntries(['light', 'dark'].map((theme) => {
  const block = paletteBlock(theme === 'light' ? ':root {' : ':root[data-theme="dark"] {');
  const color = readColor(block, 'surface-chrome');
  if (!color) throw new Error(`Missing --surface-chrome in the ${theme} palette`);
  return [theme, color];
}));

function themeBackground(preference, systemDark) {
  return backgrounds[preference === 'system' ? (systemDark ? 'dark' : 'light') : preference];
}
module.exports = { themeBackground };

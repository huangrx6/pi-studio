/**
 * 主题 / 设计令牌的静态检查。
 *
 * 目标：确保颜色只有一个来源（web/src/styles/palette.css），所有 var() 都能
 * 解析，亮色与暗色都有中性背景和达标的语义色对比度，并且 Electron 原生窗口
 * 与渲染进程读取的是同一份调色板。
 *
 * 运行方式：
 *   pnpm test                            # 跑 tests/ 下全部单测
 *   node --test tests/web/theme.test.mjs # 只跑本文件
 *
 * 注意：用例里用的是相对仓库根目录的路径（web/src/...），必须在仓库根目录执行。
 *
 * 依赖：
 * - vite（直接依赖）提供的 postcss：项目没有直接声明 postcss，而是通过
 *   createRequire(import.meta.resolve('vite')) 从 Vite 的依赖树里加载，
 *   这样在 pnpm 的严格 node_modules 布局下也能找到；
 * - web/src 下的 CSS / TSX 源码；
 * - electron/theme.cjs（原生窗口背景色）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.resolve('vite'));
const postcss = require('postcss');
const palette = postcss.parse(fs.readFileSync('web/src/styles/palette.css', 'utf8'));
const sourceFiles = fs.readdirSync('web/src', { recursive: true })
  .filter((file) => /\.(css|tsx|ts)$/.test(file))
  .map((file) => path.join('web/src', file));

/**
 * 收集某个主题下所有 `--token` 的最终值。
 *
 * - light：只读 `:root`；
 * - dark：先读 `:root`，再用 `:root[data-theme="dark"]` 覆盖同名 token。
 * var() 引用会递归展开（例如 --accent → --color-accent），并用 seen 检测循环，
 * 任何缺失或循环都会让断言失败。
 */
function tokens(mode, paletteName = 'lime') {
  const result = {};
  palette.walkRules((rule) => {
    const isBase = rule.selector === ':root';
    const isDarkOverride = mode === 'dark' && rule.selector === ':root[data-theme="dark"]';
    const isPaletteOverride = paletteName !== 'lime' && rule.selector === `:root[data-palette="${paletteName}"]`;
    const isDarkPaletteOverride = mode === 'dark' && paletteName !== 'lime' && rule.selector === `:root[data-theme="dark"][data-palette="${paletteName}"]`;
    if (!isBase && !isDarkOverride && !isPaletteOverride && !isDarkPaletteOverride) return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) result[decl.prop] = decl.value;
    });
  });
  const resolve = (key, seen = new Set()) => {
    assert.ok(!seen.has(key), `circular palette token ${key}`);
    seen.add(key);
    assert.ok(result[key], `missing palette token ${key}`);
    return result[key].replace(
      /var\((--[\w-]+)\)/g,
      (_, name) => resolve(name, new Set(seen)),
    );
  };
  return Object.fromEntries(Object.keys(result).map((key) => [key, resolve(key)]));
}

/**
 * 计算 WCAG 相对亮度，支持不透明颜色和不透明 sRGB 混合结果。
 * 透明色需有实际背景才可计算，不在这里隐式假设背景。
 */
function colorChannels(value) {
  const hex = value.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (hex) return hex.slice(1).map(channel => parseInt(channel, 16) / 255);
  // Shared tints are an opaque sRGB blend, just as rendered by Chromium.
  const mix = value.match(/^color-mix\(in srgb, (#[a-f\d]{6}) ([\d.]+)%, (#[a-f\d]{6})\)$/i);
  assert.ok(mix, `contrast requires an opaque color or sRGB blend: ${value}`);
  const weight = Number(mix[2]) / 100;
  const first = colorChannels(mix[1]), second = colorChannels(mix[3]);
  return first.map((channel, i) => channel * weight + second[i] * (1 - weight));
}

function luminance(value) {
  const [r, g, b] = colorChannels(value)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

// 圆角只有 tokens.css 里那一套阶梯：4 tag / 8 control / 12 card / 16 panel / 999 round。
// 组件各自写 6px、10px、14px 时，同一屏里会出现三种半径，看起来像不同组件拼起来的。
test('all CSS border radii come from the shared scale', () => {
  // 派生圆角只允许在同一条阶梯上做小幅加减（控件内更小的同心圆角），
  // 或按图标尺寸取比例；不允许出现与阶梯无关的独立数值。
  const derived = /^calc\(var\(--(?:radius-[a-z-]+|provider-icon-size)\) .+\)$/;
  const unit = /^(?:0|50%|inherit|var\(--radius-[a-z-]+\))$/;
  for (const file of sourceFiles.filter((item) => item.endsWith('.css') && !item.endsWith('/tokens.css'))) {
    postcss.parse(fs.readFileSync(file, 'utf8')).walkDecls((decl) => {
      if (decl.prop !== 'border-radius') return;
      const value = decl.value.trim();
      if (derived.test(value)) return;
      for (const part of value.split(/\s+/)) {
        assert.match(part, unit, `${file}: ${decl.prop}: ${decl.value}`);
      }
    });
  }
});

// 颜色必须集中在 palette.css：其它 CSS 声明里不能出现十六进制、rgb()/hsl()、
// color-mix() 或 white/black 等颜色字面量（先去掉 var() 再匹配）。transparent
// 只表达“无可见颜色”，不会在不同主题间泄漏色值，因此保留为布局关键字。
// TSX/TS 里也不能写内联的 color/background/fill/stroke 颜色值。
// 否则切换主题时会出现漏改的硬编码颜色。
test('all CSS color literals and color calculations live in palette.css', () => {
  const literal = /#[\da-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:white|black)\b(?![\w-])/;
  for (const file of sourceFiles.filter((item) => item.endsWith('.css') && !item.endsWith('/palette.css'))) {
    postcss.parse(fs.readFileSync(file, 'utf8')).walkDecls((decl) => {
      // 先去掉 var() 引用；color-mix() 只在完全由 token、百分比与 transparent
      // 组成时放行（例如运行时按壁纸可见度派生的透明表面），其余仍按字面量处理。
      const value = decl.value.replace(/var\([^)]*\)/g, '');
      const mixes = value.match(/color-mix\((?:[^()]|\([^()]*\))*\)/g) ?? [];
      for (const mix of mixes) {
        assert.ok(!literal.test(mix), `${file}: ${decl.prop}: ${mix}`);
      }
      assert.ok(
        !literal.test(value.replace(/color-mix\((?:[^()]|\([^()]*\))*\)/g, '')),
        `${file}: ${decl.prop}: ${decl.value}`,
      );
    });
  }
  for (const file of sourceFiles.filter((item) => /\.tsx?$/.test(item))) {
    assert.ok(
      !/(?:color|background|fill|stroke)\s*:\s*['"](?:#|rgba?\(|white|black)/.test(
        fs.readFileSync(file, 'utf8'),
      ),
      file,
    );
  }
});

// 所有被 var(--x) 引用的 token 都必须在某个 CSS 文件里声明，防止拼写错误导致
// 样式静默失效。--chat-font-size 由 App.tsx 在运行时写到根元素，
// --provider-icon-size 由 ProviderIcon.tsx 以内联 style 注入，二者按约定列入白名单。
test('all referenced design tokens resolve', () => {
  const declared = new Set(['--chat-font-size', '--provider-icon-size', '--terminal-fg']);
  const used = new Set();
  for (const file of sourceFiles.filter((item) => item.endsWith('.css'))) {
    postcss.parse(fs.readFileSync(file, 'utf8')).walkDecls((decl) => {
      if (decl.prop.startsWith('--')) declared.add(decl.prop);
      for (const match of decl.value.matchAll(/var\((--[\w-]+)/g)) used.add(match[1]);
    });
  }
  assert.deepEqual([...used].filter((key) => !declared.has(key)), []);
});

// 字体层级只允许使用 tokens.css 声明的字号和字重；页面 CSS 不能再悄悄引入
// 9.5px、550 之类局部档位，避免设置页和工作区出现难以察觉的视觉跳变。
test('all page typography consumes shared size and weight tokens', () => {
  for (const file of sourceFiles.filter((item) => item.endsWith('.css') && !item.endsWith('/tokens.css'))) {
    postcss.parse(fs.readFileSync(file, 'utf8')).walkDecls((decl) => {
      // @font-face descriptors define a font resource and its variable weight
      // range; they are not page typography declarations.
      if (decl.parent?.type === 'atrule' && decl.parent.name === 'font-face') return;
      if (decl.prop === 'font-size') {
        const sharedSize = decl.value.replace(/var\(--chat-font-size(?:,\s*[^)]+)?\)/g, 'var(--chat-font-size)');
        assert.doesNotMatch(sharedSize, /\b\d+(?:\.5)?px\b/, `${file}: ${decl.prop}: ${decl.value}`);
      }
      if (decl.prop === 'font-weight') {
        assert.match(decl.value, /^var\(--weight-(?:regular|medium|semibold|bold)\)$/, `${file}: ${decl.prop}: ${decl.value}`);
      }
      if (decl.prop === 'font') {
        // The optional line-height may still use a control-specific px value;
        // only the font-size position must come from a shared token.
        const withoutPixelLineHeight = decl.value.replace(/\/\s*\d+(?:\.\d+)?px\b/g, '/');
        assert.doesNotMatch(withoutPixelLineHeight, /\b(?:400|450|500|550|600|620|650|700)\b|\b\d+(?:\.5)?px(?:\/|\s)/, `${file}: ${decl.prop}: ${decl.value}`);
      }
    });
  }
});

// 两种主题分别检查：
// 1. 页面级背景（--bg / --surface / --sidebar-bg）只能带极小的冷色偏移
//    （四级表面规范是 #17191D 这类冷灰），不能跟着品牌色被染色；
// 2. 前景/背景组合的 WCAG 对比度至少 4.5:1，覆盖正文、弱化文字、按钮、
//    错误/警告/成功状态、代码语法色与选区文字。
for (const paletteName of ['lime', 'ocean', 'amber', 'berry']) {
  for (const mode of ['light', 'dark']) {
    test(`${mode} ${paletteName} has neutral surfaces and readable semantic color pairs`, () => {
      const t = tokens(mode, paletteName);
      for (const key of ['--bg', '--surface', '--sidebar-bg']) {
        const color = t[key].slice(1).match(/../g).map((value) => parseInt(value, 16));
        // 允许 ≤12/255 的冷色偏移：规范的四级表面就是冷灰，不能让品牌色再叠一层色相。
        assert.ok(Math.max(...color) - Math.min(...color) <= 12, `${mode} ${key} must stay near-neutral`);
      }
      const pairs = [
        ['--text', '--bg'],
        ['--muted', '--surface'],
        ['--faint', '--surface-soft'],
        ['--accent-foreground', '--accent-soft'],
        ['--on-button', '--button-bg'],
        ['--on-button', '--button-hover'],
        ['--error', '--error-soft'],
        ['--warning', '--warning-soft'],
        ['--success', '--success-soft'],
        ['--syntax-keyword', '--code-bg'],
        ['--syntax-string', '--code-bg'],
        ['--syntax-number', '--code-bg'],
        ['--syntax-function', '--code-bg'],
        ['--selection-text', '--selection'],
      ];
      // 选区还必须和它所在的页面底有明显差别：只满足文字对比度不够，
      // 背景本身看不出来时选中范围就辨认不出来。
      const selectionVsSurface = (() => {
        const values = [luminance(t['--selection']), luminance(t['--surface'])].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
      })();
      assert.ok(
        selectionVsSurface >= 1.3,
        `${mode} ${paletteName} selection/surface contrast ${selectionVsSurface.toFixed(2)}`,
      );
      for (const [fg, bg] of pairs) {
        const values = [luminance(t[fg]), luminance(t[bg])].sort((a, b) => b - a);
        const ratio = (values[0] + 0.05) / (values[1] + 0.05);
        assert.ok(ratio >= 4.5, `${mode} ${paletteName} ${fg}/${bg} contrast ${ratio.toFixed(2)}`);
      }
    });
  }
}

test('solid controls keep white foregrounds across every theme', () => {
  for (const paletteName of ['lime', 'ocean', 'amber', 'berry']) {
    for (const mode of ['light', 'dark']) {
      const t = tokens(mode, paletteName);
      assert.equal(t['--on-button'], '#ffffff', `${mode} ${paletteName} button foreground`);
      assert.equal(t['--switch-on-thumb'], '#ffffff', `${mode} ${paletteName} switch thumb`);
    }
  }
});

test('palette presets keep semantic status colors stable', () => {
  for (const mode of ['light', 'dark']) {
    const base = tokens(mode, 'lime');
    for (const paletteName of ['ocean', 'amber', 'berry']) {
      const current = tokens(mode, paletteName);
      for (const token of ['--success', '--success-soft', '--error', '--error-soft', '--warning', '--warning-soft', '--info', '--info-soft']) {
        assert.equal(current[token], base[token], `${mode} ${paletteName} must not change ${token}`);
      }
    }
  }
});

// 原生窗口的 backgroundColor 必须在启动瞬间就和页面一致（否则会闪一下）。
// Electron 侧从同一份 palette.css 读取 --bg：显式主题直接取对应值，
// system 则按当前系统是否暗色选择。
test('the four shared surfaces stay opaque in both themes', () => {
  // 换壁纸不改变窗口内颜色：四级表面必须是实色，不能是 rgba 或 color-mix。
  for (const mode of ['light', 'dark']) {
    const t = tokens(mode, 'lime');
    for (const key of ['--surface-canvas', '--surface-chrome', '--surface-raised', '--surface-floating']) {
      assert.match(t[key], /^#[\da-f]{6}$/i, `${mode} ${key} must be an opaque hex color`);
    }
    for (const key of ['--bg', '--surface', '--sidebar-bg']) {
      assert.match(t[key], /^#[\da-f]{6}$/i, `${mode} ${key} resolves to an opaque surface`);
    }
  }
});

test('Electron reads both backgrounds from the same palette', () => {
  const { themeBackground } = createRequire(import.meta.url)('../../electron/theme.cjs');
  assert.equal(themeBackground('light', true), tokens('light')['--bg']);
  assert.equal(themeBackground('dark', false), tokens('dark')['--bg']);
  assert.equal(themeBackground('system', true), tokens('dark')['--bg']);
  assert.equal(themeBackground('system', false), tokens('light')['--bg']);
});


test('each palette has one solid accent shared by buttons, focus and previews', () => {
  for (const name of ['lime', 'ocean', 'amber', 'berry']) {
    for (const mode of ['light', 'dark']) {
      const t = tokens(mode, name);
      for (const role of ['--accent', '--accent-hover', '--accent-border', '--button-bg', '--button-hover', '--focus-color', '--data-model-fill']) {
        assert.equal(t[role], t[`--scheme-${name}`], `${mode} ${name} ${role}`);
      }
      assert.equal(t['--accent-soft'], t['--surface-soft']);
      const values = [luminance(t['--accent']), luminance(t['--accent-soft'])].sort((a, b) => b - a);
      assert.ok((values[0] + .05) / (values[1] + .05) >= 3, 'graphical accent contrast');
    }
  }
});

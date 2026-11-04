/**
 * Focused browser QA for the text-selection colour.
 *
 * Renders a model chip and a paragraph, selects text, and asserts the selection
 * band is clearly separated from the page surface in both themes. Before the fix
 * the selection reused the neutral selected row colour (contrast 1.14 against the
 * surface), which is why selecting text was hard to see.
 *
 * Run the Vite server first:
 *   pnpm run web
 *   node tools/qa/qa-selection-contrast.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/selection/', import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/popover-preview', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="fixture"></div><script type="module">
      await import('/src/styles/tokens.css'); await import('/src/styles/palette.css'); await import('/src/app.css');
      document.getElementById('fixture').innerHTML = \`
        <main style="max-width:720px;margin:48px auto;display:grid;gap:24px;font-family:var(--font)">
          <div class="turn-trace"><div class="activity-request"><span class="activity-request-model">deepseek/deepseek-flash</span></div></div>
          <p class="selection-probe-text" style="margin:0;font-size:15px;line-height:1.7;color:var(--text)">
            选中这段文字检查选区是否明显：模型调用 deepseek/deepseek-flash，上下文 286 条消息。
          </p>
        </main>\`;
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/popover-preview', { waitUntil: 'domcontentloaded' });
  await page.locator('.selection-probe-text').waitFor();

  async function measure(theme) {
    await page.evaluate((nextTheme) => {
      document.documentElement.dataset.theme = nextTheme;
      const target = document.querySelector('.selection-probe-text');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, theme);
    await page.waitForTimeout(120);
    return page.evaluate(() => {
      // 自定义属性保留的是 color-mix() 表达式，用探针元素取“实际生效”的颜色。
      const probe = document.createElement('div');
      probe.style.position = 'fixed';
      probe.style.opacity = '0';
      document.body.appendChild(probe);
      const used = (token) => {
        probe.style.backgroundColor = `var(${token})`;
        return getComputedStyle(probe).backgroundColor;
      };
      const selectionColor = used('--selection');
      const surfaceColor = used('--surface');
      probe.remove();
      const parse = (value) => {
        const rgb = value.trim().match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/i);
        if (rgb) return rgb.slice(1, 4).map(channel => Number(channel) / 255);
        // Chromium 对 color-mix 结果会序列化成 color(srgb r g b)，分量已是 0–1。
        const srgb = value.trim().match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
        if (srgb) return srgb.slice(1, 4).map(Number);
        const hex = value.trim().match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
        if (!hex) throw new Error(`unexpected colour: ${value}`);
        return hex.slice(1).map(channel => parseInt(channel, 16) / 255);
      };
      const root = getComputedStyle(document.documentElement);
      const luminance = (rgb) => {
        const [r, g, b] = rgb
          .map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
        return r * 0.2126 + g * 0.7152 + b * 0.0722;
      };
      const surface = luminance(parse(surfaceColor));
      const selection = luminance(parse(selectionColor));
      const high = Math.max(surface, selection);
      const low = Math.min(surface, selection);
      return {
        selection: selectionColor,
        surface: surfaceColor,
        ratio: Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100,
        selectedText: String(window.getSelection()).slice(0, 12),
        theme: root.getPropertyValue('--theme-accent').trim(),
      };
    });
  }

  const light = await measure('light');
  assert.ok(light.selectedText.length > 0, 'text must be selected for this check');
  assert.ok(light.ratio >= 1.3, `light selection/surface contrast ${light.ratio}`);
  await page.screenshot({ path: output + 'selection-light.png', animations: 'disabled' });

  const dark = await measure('dark');
  assert.ok(dark.ratio >= 1.3, `dark selection/surface contrast ${dark.ratio}`);
  await page.screenshot({ path: output + 'selection-dark.png', animations: 'disabled' });

  assert.deepEqual(errors, []);
  console.log(
    `PASS: selection contrast against surface — light ${light.ratio} (${light.selection} on ${light.surface}), `
    + `dark ${dark.ratio} (${dark.selection} on ${dark.surface}).`,
  );
} finally {
  await browser.close();
}

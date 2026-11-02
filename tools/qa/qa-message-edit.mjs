// Visual and interaction QA for composer references and inline user-message editing.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const output = new URL('../../.qa/screenshots/message-edit/', import.meta.url).pathname;
const prompt = '/goal @"00 Inbox/"';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/popover-preview', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/styles/tokens.css');
      await import('/src/styles/palette.css');
      await import('/src/app.css');
      const React = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/@fs/${process.cwd()}/node_modules/.vite/deps/react-dom_client.js')).default;
      const { ChatMessageView } = await import('/src/components/ChatMessage.tsx');
      const { splitComposerText } = await import('/src/lib/references.ts');
      const prompt = '/goal @"00 Inbox/"';
      let resolveEdit;
      const editPromise = new Promise((resolve) => { resolveEdit = resolve; });
      window.resolveEdit = () => resolveEdit();
      window.editRequest = null;
      function Fixture() {
        const [value, setValue] = React.useState(prompt);
        const current = splitComposerText(value, new Set(['goal']));
        return React.createElement(React.Fragment, null,
          React.createElement('main', { className: 'qa-message-edit' },
            React.createElement('div', { className: 'qa-label' }, '输入框引用'),
            React.createElement('div', { className: 'composer' },
              React.createElement('div', { className: 'composer-input' },
                React.createElement('div', { className: 'composer-highlight', 'aria-hidden': 'true' },
                  current.map((segment, index) => segment.kind === 'text'
                    ? React.createElement('span', { key: index }, segment.text)
                    : React.createElement('span', { key: index, className: 'composer-token is-' + segment.tokenKind }, segment.text))
                ),
                React.createElement('textarea', {
                  'aria-label': '消息',
                  value,
                  onChange: (event) => setValue(event.target.value),
                })
              )
            ),
            React.createElement('div', { className: 'qa-label' }, '已发送消息'),
            React.createElement('div', { className: 'messages' },
              React.createElement(ChatMessageView, {
                message: {
                  role: 'user',
                  sourceIndex: 12,
                  timestamp: Date.now(),
                  content: [{ type: 'text', text: prompt }],
                },
                onEdit: async (entryId, text) => {
                  window.editRequest = { entryId, text };
                  await editPromise;
                },
              })
            )
          )
        );
      }
      createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
    </script></body></html>`,
  }));
  await page.goto('http://127.0.0.1:5180/popover-preview', { waitUntil: 'domcontentloaded' });
  await page.locator('.composer-token').first().waitFor();
  await page.locator('.message.user').waitFor();

  const tokenStyle = await page.locator('.composer-token').first().evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      borderWidth: style.borderWidth,
      boxShadow: style.boxShadow,
      borderRadius: style.borderTopLeftRadius,
    };
  });
  assert.equal(tokenStyle.borderWidth, '0px');
  assert.equal(tokenStyle.boxShadow, 'none');
  assert.notEqual(tokenStyle.background, 'rgba(0, 0, 0, 0)');
  assert.notEqual(tokenStyle.borderRadius, '0px');
  await page.screenshot({ path: output + 'composer-light.png', animations: 'disabled' });

  const user = page.locator('.message.user');
  await user.hover();
  await user.getByRole('button', { name: '编辑消息' }).click();
  const editor = page.getByRole('textbox', { name: '编辑消息' });
  await editor.waitFor();
  assert.equal(await editor.inputValue(), prompt);
  await editor.click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.type('/goal @"00 Inbox/" 改成修正后的描述');
  await page.screenshot({ path: output + 'editing-light.png', animations: 'disabled' });
  await page.getByRole('button', { name: '发送' }).click();
  assert.deepEqual(await page.evaluate(() => window.editRequest), {
    entryId: 12,
    text: '/goal @"00 Inbox/" 改成修正后的描述',
  });
  assert.equal(await page.getByRole('button', { name: '发送中' }).count(), 1);
  await page.evaluate(() => window.resolveEdit());
  await editor.waitFor({ state: 'detached' });

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: output + 'composer-dark.png', animations: 'disabled' });
  await user.hover();
  await user.getByRole('button', { name: '编辑消息' }).click();
  await page.getByRole('textbox', { name: '编辑消息' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: '编辑消息' }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(`PASS: composer references and message editing screenshots saved to ${output}`);
} finally {
  await browser.close();
}

// Visual fixture for the exact model-request projection. No user data or network requests.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = new URL('../../.qa/screenshots/request-trace/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/request-trace-preview', (route) => route.fulfill({
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
      const { AssistantTurnView } = await import('/src/features/conversation/ChatMessage.tsx');
      const trace = {
        id: 'trace-1',
        requestId: 'trace-1',
        conversationId: 'fixture',
        taskId: 'task-1',
        attempt: 1,
        createdAt: 1000,
        model: { provider: 'deepseek', modelId: 'deepseek-flash' },
        thinkingLevel: 'medium',
        messages: [
          {
            index: 0,
            role: 'system',
            content: [
              { type: 'text', text: '<harness>\\nYou are a precise coding agent.\\n</harness>' },
              { type: 'text', text: '<project_context>\\nAGENTS.md instructions.\\n</project_context>' },
            ],
          },
          {
            index: 1,
            role: 'user',
            content: [{ type: 'text', text: '请检查设置页面，并把首个模型请求完整显示在轨迹顶部。' }],
          },
        ],
        tools: [{
          name: 'read',
          description: 'Read a file from the workspace.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        }],
        stats: {
          messageCount: 2,
          systemChars: 96,
          userChars: 42,
          assistantChars: 0,
          toolResultChars: 0,
          imageCount: 0,
          toolCallCount: 0,
          toolDefinitionCount: 1,
          estimatedChars: 260,
        },
        truncated: false,
      };
      const secondTrace = {
        ...trace,
        id: 'trace-2',
        requestId: 'trace-2',
        attempt: 1,
        createdAt: 4000,
        model: { provider: 'deepseek', modelId: 'deepseek-reasoner' },
        messages: [
          ...trace.messages,
          {
            index: 2,
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '先读取组件与样式。' },
              { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'web/src/features/conversation/ChatMessage.tsx' } },
            ],
          },
          {
            index: 3,
            role: 'toolResult',
            toolCallId: 'read-1',
            toolName: 'read',
            content: [{ type: 'text', text: '已读取 ChatMessage.tsx。' }],
          },
        ],
        stats: {
          ...trace.stats,
          messageCount: 4,
          assistantChars: 14,
          toolResultChars: 22,
          toolCallCount: 1,
          estimatedChars: 326,
        },
      };
      const firstAnswer = {
        role: 'assistant',
        timestamp: 2000,
        content: [
          { type: 'thinking', thinking: '先读取实际 provider 请求，确认当前轨迹组件和样式结构。' },
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'web/src/features/conversation/ChatMessage.tsx' } },
          { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'pnpm test --filter request-trace' } },
          { type: 'text', text: '第一次请求返回了读取与验证步骤。' },
        ],
      };
      const secondAnswer = {
        role: 'assistant',
        timestamp: 5000,
        content: [
          { type: 'thinking', thinking: '工具结果已经返回，根据失败信息继续调整样式并再次请求模型。' },
          { type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'web/src/app.css' } },
          { type: 'text', text: '轨迹按每次模型请求分区，决策和工具留在对应阶段，最终回复单独显示。' },
        ],
      };
      const toolResults = new Map([
        ['read-1', {
          role: 'toolResult',
          toolCallId: 'read-1',
          toolName: 'read',
          timestamp: 2100,
          content: [{ type: 'text', text: '已读取 ChatMessage.tsx，共 720 行。' }],
        }],
        ['bash-1', {
          role: 'toolResult',
          toolCallId: 'bash-1',
          toolName: 'bash',
          timestamp: 2200,
          isError: true,
          content: [{ type: 'text', text: 'Command failed with exit code 1.\\nExpected request-trace fixture.' }],
        }],
        ['edit-1', {
          role: 'toolResult',
          toolCallId: 'edit-1',
          toolName: 'edit',
          timestamp: 5500,
          content: [{ type: 'text', text: 'Updated web/src/app.css.' }],
        }],
      ]);
      const root = createRoot(document.getElementById('fixture'));
      const render = (extra = {}) => root.render(
        React.createElement('main', { style: { maxWidth: 900, margin: '30px auto', padding: '0 24px' } },
          React.createElement(AssistantTurnView, {
            messages: [firstAnswer, secondAnswer],
            toolResults,
            requestTraces: [trace, secondTrace],
            busy: false,
            cwd: '/project',
            stepDisplay: 'standard',
            ...extra,
          })
        )
      );
      window.renderTrace = render;
      window.longRequest = () => render({ requestTraces: [{ ...trace, messages: [trace.messages[0], ...Array.from({length: 738}, (_, i) => ({index: i + 1, role: i % 2 ? 'assistant' : 'user', content: [{type:'text', text: 'Context entry ' + (i + 1)}]}))], stats:{...trace.stats, messageCount:739, estimatedChars:13000}}, secondTrace], stepCollapse:'keep-open' });
      window.largePrompt = () => render({requestTraces:[{...trace, messages:[{index:0, role:'system', content:[{type:'text', text:'Project instructions. '.repeat(8000)}]}, trace.messages[1]], stats:{...trace.stats, estimatedChars:176042}}], stepCollapse:'keep-open'});
      window.splitWithinMessage = () => render({requestTraces: [], stepCollapse:'keep-open', messages:[{...firstAnswer, content:[...firstAnswer.content, ...secondAnswer.content]}]});
      render();
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/request-trace-preview', { waitUntil: 'domcontentloaded' });
  const groups = page.locator('.turn-trace');
  const toggles = page.locator('.turn-trace-toggle');
  await toggles.first().waitFor();
  assert.equal(await groups.count(), 2, 'a visible explanation splits execution groups');
  assert.deepEqual(await toggles.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-expanded'))), ['false', 'false']);
  const order = await page.locator('.assistant-turn-main').evaluate(node => [...node.children].filter(child => child.matches('.turn-trace, .assistant-response')).map(child => child.className.split(' ')[0]));
  assert.deepEqual(order, ['turn-trace', 'assistant-response', 'turn-trace', 'assistant-response']);
  assert.equal(await page.locator('.request-inspector').count(), 0, 'collapsed requests do not mount large contexts');
  assert.ok(await page.getByText('第一次请求返回了读取与验证步骤。', {exact:true}).isVisible());
  await toggles.first().click();
  await toggles.last().click();
  const requests = page.locator('.activity-request');
  assert.equal(await requests.count(), 2);
  assert.deepEqual(await requests.locator('.activity-request-label').allTextContents(), ['模型调用', '模型调用']);
  await requests.first().locator(':scope > summary').click();
  const inspector = requests.first().locator('.request-inspector');
  await inspector.getByRole('button', {name:'系统提示词'}).click();
  assert.equal(await inspector.locator('pre').count(), 0, 'message body is lazy');
  const systemRow = inspector.locator('.request-message > summary');
  const background = await systemRow.evaluate(node => getComputedStyle(node).backgroundColor);
  await systemRow.hover();
  assert.equal(await systemRow.evaluate(node => getComputedStyle(node).backgroundColor), background, 'no nested hover surface');
  await systemRow.click();
  await inspector.getByText('<harness>', {exact:false}).last().waitFor();
  await inspector.getByRole('button', {name:'工具定义'}).click();
  await inspector.locator('.request-tool > summary').click();
  assert.match(await inspector.locator('pre').innerText(), /properties/);
  await inspector.getByRole('button', {name:'上下文'}).click();
  const aligned = await page.evaluate(() => {
    const icons = [...document.querySelectorAll('.turn-trace .activity-disclosure-icon')];
    return icons.map(node => ({left:node.getBoundingClientRect().left, width:node.getBoundingClientRect().width}));
  });
  assert.ok(aligned.every(rect => rect.width === 18 && Math.abs(rect.left - aligned[0].left) < 1), JSON.stringify(aligned));
  await page.screenshot({path:output+'light-segments.png', fullPage:true, animations:'disabled'});
  await page.evaluate(() => window.longRequest());
  await page.waitForFunction(() => document.querySelector('.activity-request-metrics')?.textContent.includes('739'));
  assert.ok(await inspector.locator('.request-message').count() <= 16);
  assert.match(await inspector.locator('.request-inspector-footer').innerText(), /738/);
  await inspector.getByRole('button', {name:'最早', exact:true}).click();
  assert.match(await inspector.locator('.request-message-preview').first().innerText(), /Context entry 1$/);
  await inspector.getByRole('button', {name:'最近', exact:true}).click();
  await inspector.getByRole('textbox', {name:'搜索请求内容'}).fill('Context entry 402');
  assert.equal(await inspector.locator('.request-message').count(), 1);
  await inspector.getByRole('textbox', {name:'搜索请求内容'}).fill('');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({path:output+'dark-long-context.png', fullPage:true, animations:'disabled'});
  const searchFocus = await inspector.getByRole('textbox').evaluate(node => ({shadow:getComputedStyle(node).boxShadow, height:node.getBoundingClientRect().height}));
  assert.deepEqual(searchFocus, {shadow:'none', height:24});
  for (const width of [720, 390]) {
    await page.setViewportSize({width, height:800});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no overflow at '+width);
    await page.screenshot({path:output+'narrow-'+width+'.png', fullPage:true, animations:'disabled'});
  }
  await page.setViewportSize({width:1100, height:760});
  await page.evaluate(() => window.largePrompt());
  await inspector.getByRole('button', {name:'系统提示词'}).click();
  await inspector.locator('.request-message > summary').click();
  const prompt = inspector.locator('.request-block');
  await prompt.waitFor();
  assert.ok((await prompt.innerText()).length > 150000);
  assert.ok(await prompt.evaluate(node => node.getBoundingClientRect().height <= 300 && node.scrollHeight > node.clientHeight));
  await page.screenshot({path:output+'dark-large-prompt.png', fullPage:true, animations:'disabled'});
  for (const selector of ['.activity-tool > summary', '.activity-thinking > summary']) {
    const row = page.locator(selector).first();
    await page.mouse.move(0,0);
    const before = await row.evaluate(node => getComputedStyle(node).backgroundColor);
    await row.hover();
    assert.equal(await row.evaluate(node => getComputedStyle(node).backgroundColor), before);
  }
  await page.evaluate(() => window.splitWithinMessage());
  assert.equal(await groups.count(), 2, 'one assistant message can contain multiple execution groups');
  assert.equal(await page.locator('.assistant-response').count(), 2);
  await page.evaluate(() => window.renderTrace({stepCollapse:'after-answer', busy:true}));
  await page.waitForFunction(() => [...document.querySelectorAll('.turn-trace-toggle')].every(node => node.getAttribute('aria-expanded') === 'true'));
  const footer = await page.locator('.run-live-status').evaluate(node => ({left:parseFloat(getComputedStyle(node).paddingLeft), right:parseFloat(getComputedStyle(node).paddingRight)}));
  assert.deepEqual(footer, {left:12, right:12});
  await toggles.first().click();
  await page.evaluate(() => window.renderTrace({stepCollapse:'after-answer', busy:true}));
  assert.equal(await toggles.first().getAttribute('aria-expanded'), 'false', 'updates preserve manual collapse');
  assert.equal(await toggles.last().getAttribute('aria-expanded'), 'true', 'groups fold independently');
  await page.evaluate(() => window.renderTrace({stepCollapse:'after-answer', busy:false}));
  await page.waitForFunction(() => [...document.querySelectorAll('.turn-trace-toggle')].every(node => node.getAttribute('aria-expanded') === 'false'));
  assert.deepEqual(errors, []);
  console.log(`Request trace QA passed; screenshots saved to ${output}`);
} finally { await browser.close(); }

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
      const { AssistantTurnView } = await import('/src/components/ChatMessage.tsx');
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
              { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'web/src/components/ChatMessage.tsx' } },
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
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'web/src/components/ChatMessage.tsx' } },
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
      createRoot(document.getElementById('fixture')).render(
        React.createElement('main', { style: { maxWidth: 900, margin: '30px auto', padding: '0 24px' } },
          React.createElement(AssistantTurnView, {
            messages: [firstAnswer, secondAnswer],
            toolResults,
            requestTraces: [trace, secondTrace],
            busy: false,
            cwd: '/project',
            stepDisplay: 'standard',
          })
        )
      );
    </script></body></html>`,
  }));

  await page.goto('http://127.0.0.1:5180/request-trace-preview', { waitUntil: 'domcontentloaded' });
  const requests = page.locator('.activity-request');
  await requests.first().waitFor();
  assert.equal(await requests.count(), 2, 'each provider request gets its own stage anchor');
  const order = await page.locator('.assistant-turn-main').evaluate((node) => (
    [...node.children].map((child) => child.className)
  ));
  const requestOrder = order.flatMap((className, index) => className.includes('activity-request') ? [index] : []);
  const sequenceOrder = order.flatMap((className, index) => className.includes('activity-sequence') ? [index] : []);
  const responseOrder = order.flatMap((className, index) => className.includes('assistant-response') ? [index] : []);
  assert.equal(requestOrder.length, 2, `both requests are visible: ${order.join(', ')}`);
  assert.equal(sequenceOrder.length, 2, `each request keeps its own execution sequence: ${order.join(', ')}`);
  assert.ok(
    requestOrder[0] < sequenceOrder[0]
      && sequenceOrder[0] < responseOrder[0]
      && responseOrder[0] < requestOrder[1]
      && requestOrder[1] < sequenceOrder[1]
      && sequenceOrder[1] < responseOrder[1],
    `trace follows request -> decision/tools -> next request -> answer: ${order.join(', ')}`,
  );
  assert.equal(await page.locator('.run-history').count(), 0, 'legacy monolithic execution block is removed');
  assert.equal(await requests.nth(0).getByText('模型请求 1', { exact: true }).count(), 1);
  assert.equal(await requests.nth(0).getByText('deepseek/deepseek-flash', { exact: true }).count(), 1);
  assert.equal(await requests.nth(1).getByText('模型请求 2', { exact: true }).count(), 1);
  assert.equal(await requests.nth(1).getByText('deepseek/deepseek-reasoner', { exact: true }).count(), 1);
  const firstSequence = page.locator('.activity-sequence').nth(0);
  const secondSequence = page.locator('.activity-sequence').nth(1);
  assert.equal(await firstSequence.locator('.activity-tool').count(), 2);
  assert.equal(await secondSequence.locator('.activity-tool').count(), 1);
  assert.equal(await firstSequence.locator('.activity-thinking').count(), 1);
  assert.equal(await secondSequence.locator('.activity-thinking').count(), 1);
  assert.equal(await firstSequence.getByText('决策', { exact: true }).count(), 1);
  const rowAlignment = await page.locator('.activity-sequence .activity-sequence-item').evaluateAll((items) => items.map((item) => {
    const rect = (selector) => item.querySelector(selector)?.getBoundingClientRect();
    return {
      icon: rect('.activity-disclosure-icon')?.left,
      title: rect('.activity-disclosure-title')?.left,
      preview: rect('.activity-disclosure-preview')?.left,
      status: rect('.activity-tool-status')?.right,
      chevron: rect('.activity-disclosure-chevron')?.right,
    };
  }));
  const aligned = (field) => {
    const values = rowAlignment.map((entry) => entry[field]).filter((value) => value !== undefined);
    return values.length > 0 && values.every((value) => Math.abs(value - values[0]) < 1);
  };
  assert.ok(
    aligned('icon') && aligned('title') && aligned('preview') && aligned('status') && aligned('chevron'),
    `execution rows share fixed icon, text, status and disclosure columns: ${JSON.stringify(rowAlignment)}`,
  );
  const shortToolNamesFit = await page.locator('.activity-sequence .activity-disclosure-title').evaluateAll((titles) => (
    titles.every((title) => title.scrollWidth <= title.clientWidth + 1)
  ));
  assert.equal(shortToolNamesFit, true, 'short tool names remain fully visible in the fixed label column');
  const alignment = await page.evaluate(() => {
    const left = (selector) => document.querySelector(selector)?.getBoundingClientRect().left;
    return {
      response: left('.assistant-response'),
      requestIcon: left('.activity-request-icon'),
      sequence: left('.activity-sequence-item'),
    };
  });
  assert.ok(
    Math.abs(alignment.requestIcon - alignment.response) < 1
      && alignment.sequence > alignment.response,
    `trajectory content aligns with assistant text: ${JSON.stringify(alignment)}`,
  );

  await page.screenshot({
    path: `${output}light-collapsed.png`,
    fullPage: true,
    animations: 'disabled',
  });

  await requests.nth(0).locator(':scope > summary').click();
  await requests.nth(0).locator('.request-message.is-system > summary').click();
  await requests.nth(0).locator('.request-block.is-text', {
    hasText: 'You are a precise coding agent.',
  }).waitFor();
  await page.screenshot({
    path: `${output}light-open.png`,
    fullPage: true,
    animations: 'disabled',
  });

  await firstSequence.locator('.activity-thinking > summary').click();
  await firstSequence.locator('.activity-tool.is-error > summary').click();
  await firstSequence.locator('.activity-tool.is-done:not(.is-error) > summary').click();
  await secondSequence.locator('.activity-thinking > summary').click();
  await page.waitForTimeout(250);
  const nestedAlignment = await page.evaluate(() => {
    const rect = (selector) => {
      const bounds = document.querySelector(selector)?.getBoundingClientRect();
      return bounds ? { left: bounds.left, right: bounds.right } : undefined;
    };
    return {
      sequence: rect('.activity-sequence-item'),
      thinking: rect('.activity-sequence .activity-thinking > summary'),
      tool: rect('.activity-sequence .activity-tool > summary'),
    };
  });
  assert.ok(
    nestedAlignment.sequence
      && nestedAlignment.thinking
      && nestedAlignment.tool
      && Math.abs(nestedAlignment.thinking.left - nestedAlignment.sequence.left) < 1
      && Math.abs(nestedAlignment.tool.left - nestedAlignment.sequence.left) < 1
      && Math.abs(nestedAlignment.thinking.right - nestedAlignment.sequence.right) < 1
      && Math.abs(nestedAlignment.tool.right - nestedAlignment.sequence.right) < 1,
    `operations share the stage bounds: ${JSON.stringify(nestedAlignment)}`,
  );
  const verticalFlow = await page.locator('.activity-sequence .activity-tool[open]').evaluateAll((tools) => tools.map((tool) => {
    const summary = tool.querySelector(':scope > summary')?.getBoundingClientRect();
    const body = tool.querySelector(':scope > .activity-tool-body')?.getBoundingClientRect();
    return summary && body ? { summaryBottom: summary.bottom, bodyTop: body.top, bodyBottom: body.bottom } : undefined;
  }));
  assert.ok(
    verticalFlow.every((entry) => entry && entry.bodyTop >= entry.summaryBottom - 1),
    `expanded operation content follows its summary: ${JSON.stringify(verticalFlow)}`,
  );
  await page.screenshot({
    path: `${output}light-open-operations.png`,
    fullPage: true,
    animations: 'disabled',
  });

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({
    path: `${output}dark-open.png`,
    fullPage: true,
    animations: 'disabled',
  });

  await page.setViewportSize({ width: 520, height: 760 });
  const overflow = await page.locator('.activity-request-body').evaluateAll((nodes) => nodes.map((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  })));
  assert.ok(
    overflow.every((entry) => entry.scrollWidth <= entry.clientWidth + 1),
    `request bodies have no horizontal overflow: ${JSON.stringify(overflow)}`,
  );
  const sequenceOverflow = await page.locator('.activity-sequence').evaluateAll((nodes) => nodes.map((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  })));
  assert.ok(
    sequenceOverflow.every((entry) => entry.scrollWidth <= entry.clientWidth + 1),
    `operation stages have no horizontal overflow: ${JSON.stringify(sequenceOverflow)}`,
  );
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({
    path: `${output}light-narrow-open.png`,
    fullPage: true,
    animations: 'disabled',
  });

  assert.deepEqual(errors, []);
  console.log(`Request trace QA passed; screenshots saved to ${output}`);
} finally {
  await browser.close();
}

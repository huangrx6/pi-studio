/**
 * Real Electron process-tree memory smoke test.
 *
 * Isolated userData, a long transcript fixture, image rendering, subagent
 * surfaces, repeated conversation/tab switching, idle reclamation, and clean
 * process teardown are all exercised. Run after `pnpm run build`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';

if (process.platform !== 'darwin') {
  throw new Error('The Pi Studio desktop memory smoke test currently requires macOS.');
}

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const rendererFile = path.join(root, 'web-dist', 'index.html');
if (!existsSync(rendererFile)) {
  throw new Error('web-dist/index.html is missing; run `pnpm run build` before `pnpm qa:memory`.');
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'pi-studio-memory-smoke-'));
const environment = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.PI_STUDIO_DEV;

let electronApp;
let electronPid;
let lastTrackedPids = [];

function processRows() {
  const rows = new Map();
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8',
  });
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.set(Number(match[1]), {
      parent: Number(match[2]),
      rssKiB: Number(match[3]),
      command: match[4],
    });
  }
  return rows;
}

function descendants(rootPid) {
  if (!rootPid) return { rows: new Map(), pids: [] };
  const rows = processRows();
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, row] of rows) {
      if (selected.has(pid) || !selected.has(row.parent)) continue;
      selected.add(pid);
      changed = true;
    }
  }
  return {
    rows,
    pids: [...selected].filter((pid) => rows.has(pid)),
  };
}

function sample(label) {
  const { rows, pids } = descendants(electronPid);
  lastTrackedPids = [...new Set([...lastTrackedPids, ...pids])];
  const totalKiB = pids.reduce((total, pid) => total + rows.get(pid).rssKiB, 0);
  const electronKiB = pids.reduce((total, pid) => {
    const command = rows.get(pid).command;
    return total + (
      /Electron|Pi Studio/.test(command) ? rows.get(pid).rssKiB : 0
    );
  }, 0);
  const result = {
    processes: pids.length,
    totalMiB: totalKiB / 1024,
    electronMiB: electronKiB / 1024,
    pids,
  };
  console.log(
    `${label}: processes=${result.processes} total=${result.totalMiB.toFixed(1)} MiB `
    + `electron=${result.electronMiB.toFixed(1)} MiB`,
  );
  return result;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function rendererMetrics(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Performance.enable');
    await session.send('HeapProfiler.collectGarbage');
    await sleep(300);
    const metrics = await session.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.metrics.map(({ name, value }) => [name, value]));
    return {
      jsHeapMiB: (values.JSHeapUsedSize || 0) / 1024 / 1024,
      nodes: values.Nodes || 0,
      documents: values.Documents || 0,
    };
  } finally {
    await session.detach().catch(() => {});
  }
}

async function closeProcessTree() {
  if (electronApp) {
    const app = electronApp;
    electronApp = undefined;
    await Promise.race([
      app.evaluate(({ app: electron }) => {
        electron.isQuitting = true;
        electron.quit();
      }).catch(() => {}),
      sleep(2_000),
    ]);
    await Promise.race([
      app.close().catch(() => {}),
      sleep(5_000),
    ]);
  }
  await sleep(1_000);
  const current = descendants(electronPid);
  const tracked = [...new Set([...lastTrackedPids, ...current.pids])];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of tracked.toReversed()) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await sleep(signal === 'SIGTERM' ? 750 : 200);
  }
}

async function installStressFixture(page) {
  await page.addInitScript(() => {
    const cwd = '/workspace/memory-regression';
    const model = {
      modelRef: 'qa/memory-fixture',
      label: 'Memory Fixture',
      thinkingLevel: 'high',
      thinkingLevels: ['off', 'high'],
      effectiveThinkingLevel: 'high',
      defaultThinkingLevel: 'high',
      supportsImages: true,
    };
    const definitions = [
      ['memory-long', 'Memory long transcript', 420],
      ['memory-medium-a', 'Memory medium A', 120],
      ['memory-medium-b', 'Memory medium B', 120],
    ];
    const summaries = new Map(definitions.map(([id, title, messageCount]) => [
      id,
      {
        id,
        cwd,
        title,
        messageCount,
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - definitions.findIndex(([value]) => value === id) * 1_000,
      },
    ]));
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">',
      '<rect width="640" height="400" fill="#17372f"/>',
      '<path d="M40 90h260M40 140h410M40 190h350" stroke="#b7e7d3" stroke-width="18" stroke-linecap="round"/>',
      '<circle cx="500" cy="105" r="52" fill="#64d7aa"/>',
      '<text x="40" y="330" fill="#f5fbf8" font-family="sans-serif" font-size="34">Memory fixture</text>',
      '</svg>',
    ].join('');
    const imageData = btoa(svg);
    const messagesBySession = new Map();

    function messagesFor(id) {
      if (messagesBySession.has(id)) return messagesBySession.get(id);
      const summary = summaries.get(id);
      const messages = [];
      for (let index = 0; index < summary.messageCount; index += 1) {
        if (index % 2 === 0) {
          messages.push({
            role: 'user',
            timestamp: Date.now() - summary.messageCount * 100 + index * 100,
            sourceIndex: index,
            content: [{
              type: 'text',
              text: `Memory question ${index / 2 + 1}: ${'请检查长会话的滚动、缓存与内存边界。'.repeat(5)}`,
            }],
          });
          continue;
        }
        const content = [
          {
            type: 'thinking',
            thinking: `第 ${Math.ceil(index / 2)} 轮先核对历史窗口与缓存边界。`,
          },
          {
            type: 'text',
            text: `## Memory response ${Math.ceil(index / 2)}\n\n${'这是用于验证长会话渲染、历史分页和缓存释放的确定性内容。'.repeat(28)}`,
          },
        ];
        if (index % 30 === 1) {
          content.push({
            type: 'toolCall',
            id: `read-${index}`,
            name: 'read',
            arguments: { path: `/workspace/memory-${index}.ts` },
          });
        }
        if (index % 60 === 29) {
          content.push(
            { type: 'image', mimeType: 'image/svg+xml', data: imageData },
            { type: 'image', mimeType: 'image/svg+xml', data: imageData },
          );
        }
        messages.push({
          role: 'assistant',
          timestamp: Date.now() - summary.messageCount * 100 + index * 100,
          sourceIndex: index,
          content,
        });
        if (index % 30 === 1) {
          messages.push({
            role: 'toolResult',
            timestamp: Date.now() - summary.messageCount * 100 + index * 100 + 1,
            sourceIndex: index,
            toolCallId: `read-${index}`,
            toolName: 'read',
            content: [{ type: 'text', text: 'Read completed.' }],
            details: { path: `/workspace/memory-${index}.ts` },
          });
        }
      }
      messagesBySession.set(id, messages);
      return messages;
    }

    let activeConversationId = definitions[0][0];
    const listeners = new Set();
    const childBase = {
      runId: 'memory-child-run',
      source: 'background',
      context: 'fork',
      model: model.modelRef,
      thinking: 'high',
      cwd,
      startedAt: Date.now() - 30_000,
      updatedAt: Date.now(),
      tokens: 18_420,
      toolCount: 7,
      turnCount: 4,
      preview: '正在核对历史窗口、图片缓存与事件订阅的生命周期。',
      hasTranscript: true,
    };
    const children = Array.from({ length: 8 }, (_, index) => ({
      ...childBase,
      key: `child-${index}`,
      runId: `memory-child-run-${index}`,
      index,
      agent: `memory-agent-${index}`,
      name: `Memory child ${index + 1}`,
      task: `验证第 ${index + 1} 个子智能体的长上下文与缓存边界。`,
      status: index < 4 ? 'running' : 'completed',
      startedAt: Date.now() - (index + 1) * 20_000,
    }));
    const childMessages = Array.from({ length: 180 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      timestamp: Date.now() - 180_000 + index * 100,
      sourceIndex: index,
      content: [{
        type: 'text',
        text: index % 2
          ? `Child answer ${index}: ${'子智能体长上下文内容。'.repeat(18)}`
          : `Child question ${index}: ${'检查工具调用与结果边界。'.repeat(10)}`,
      }],
    }));

    function snapshot(id = activeConversationId) {
      return {
        ...summaries.get(id),
        running: false,
        requestId: '',
        compacting: false,
        inbox: [],
        tools: [],
        nestedTools: [],
        usage: {},
        model,
        agent: { cwd, name: 'Memory fixture agent' },
      };
    }

    function emit(event) {
      for (const listener of listeners) listener(event);
    }

    const api = {
      state: async () => ({
        workspaces: [{
          cwd,
          name: 'memory-regression',
          sessions: [...summaries.values()],
        }],
        cwd,
        model,
      }),
      models: async () => ({
        models: [{
          id: model.modelRef,
          name: model.label,
          provider: 'qa',
          providerName: 'QA',
          supportsImages: true,
        }],
        enabled: [model.modelRef],
        current: model.modelRef,
        selection: model,
        defaultSelection: model,
      }),
      conversationPage: async ({ id }) => {
        activeConversationId = id;
        const messages = messagesFor(id);
        return {
          ...snapshot(id),
          messages,
          turnDiffs: [],
          page: { hasOlder: false },
          messageStart: 0,
          totalMessages: messages.length,
        };
      },
      conversationSnapshot: async (id) => snapshot(id),
      conversationOutline: async (id) => ({
        id,
        items: messagesFor(id)
          .filter((message) => message.role === 'user')
          .slice(-10)
          .map((message) => ({
            sourceIndex: message.sourceIndex,
            text: message.content[0].text.slice(0, 120),
            timestamp: message.timestamp,
          })),
        totalMessages: messagesFor(id).length,
      }),
      subscribeConversation: async (id) => {
        activeConversationId = id;
        return snapshot(id);
      },
      unsubscribeConversation: async () => ({ ok: true }),
      onConversationEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      composerResources: async () => ({ commands: [], skills: [] }),
      sessionSubagents: async (id) => id === 'memory-long' ? children : children.slice(0, 2),
      subagentTranscript: async ({ childKey }) => ({
        child: children.find((child) => child.key === childKey),
        messages: childMessages,
        totalMessages: childMessages.length,
        hasMore: false,
        messageStart: 0,
      }),
      extensionsUi: async () => ({
        items: [],
        errors: [],
        syncedAt: Date.now(),
        apiVersion: 1,
      }),
      conversationExtensionUiPreferences: async () => ({
        version: 1,
        layout: 'grid',
        globalOrder: [],
        sessionOrders: {},
      }),
      saveConversationExtensionUiPreferences: async (value) => ({
        version: 1,
        layout: value?.layout || 'grid',
        globalOrder: value?.globalOrder || [],
        sessionOrders: value?.sessionOrders || {},
      }),
      conversationSubmit: async () => {
        const requestId = `memory-request-${Date.now()}`;
        setTimeout(() => emit({
          type: 'run.completed',
          conversationId: activeConversationId,
          revision: Date.now(),
          payload: { inputs: [requestId] },
        }), 10);
        return {
          conversationId: activeConversationId,
          submissionId: `memory-submission-${Date.now()}`,
          requestId,
          status: 'placed',
          whenBusy: 'followUp',
        };
      },
    };
    window.piApi = new Proxy(api, {
      get(target, key) {
        if (key in target) return target[key];
        if (String(key).startsWith('on')) return () => () => {};
        return async () => undefined;
      },
    });
  });
}

async function openStressWindow() {
  console.log('opening stress renderer...');
  const nextWindow = electronApp.waitForEvent('window');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    void window.loadURL('about:blank');
  });
  const page = await nextWindow;
  page.on('crash', () => {
    console.error('stress renderer crashed');
  });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installStressFixture(page);
  await page.goto(pathToFileURL(rendererFile).href);
  await page.locator('.brand').waitFor();
  console.log('stress renderer ready');
  return { page, errors };
}

try {
  electronApp = await _electron.launch({
    args: ['.', `--user-data-dir=${profile}`, '--js-flags=--expose-gc'],
    cwd: root,
    env: environment,
  });
  electronPid = electronApp.process().pid;
  electronApp.process().stdout?.on('data', (chunk) => process.stdout.write(chunk));
  electronApp.process().stderr?.on('data', (chunk) => process.stderr.write(chunk));
  lastTrackedPids = [electronPid];
  const mainWindow = await electronApp.firstWindow();
  await mainWindow.locator('.brand').waitFor({ timeout: 30_000 });

  await sleep(4_000);
  const coldStart = sample('cold-start');
  await sleep(8_000);
  const idle = sample('idle-12s');
  assert.ok(coldStart.totalMiB < 650, 'cold Electron process tree exceeded 650 MiB');
  assert.ok(idle.totalMiB < 700, 'idle Electron process tree exceeded 700 MiB');

  const { page, errors } = await openStressWindow();
  await page.locator('.workspace-row').filter({ hasText: 'memory-regression' })
    .evaluate((node) => node.click());
  const longRow = page.locator('.session-row').filter({ hasText: 'Memory long transcript' });
  await longRow.waitFor();
  await longRow.evaluate((node) => node.click());
  await page.waitForTimeout(500);
  if (!await page.locator('.chat-scroll').count()) {
    console.error('renderer errors after selecting fixture:', errors);
    console.error('renderer body after selecting fixture:', (await page.locator('body').innerText()).slice(0, 2_000));
  }
  await page.locator('.chat-scroll').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.message').length >= 200);
  console.log('long transcript rendered');
  await page.locator('.chat-scroll').evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(100);
  await page.locator('.chat-scroll').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });

  const subagentTab = page.getByRole('tab').filter({ hasText: '子智能体' });
  await subagentTab.click();
  await page.locator('.agent-child-card').first().waitFor();
  assert.ok(await page.locator('.agent-child-card').count() >= 8);
  await page.locator('.agent-child-card.is-running').first().click();
  await page.locator('.agent-context-view').waitFor();
  await page.getByRole('button', { name: '返回主智能体', exact: true }).click();
  await page.locator('.chat-scroll').waitFor();
  console.log('subagent overview rendered');
  const conversationTab = page.getByRole('tab').filter({ hasText: /^对话/ });
  await conversationTab.click();

  for (let round = 0; round < 5; round += 1) {
    await page.locator('.session-row').filter({ hasText: 'Memory medium A' })
      .evaluate((node) => node.click());
    await page.locator('.chat-scroll').waitFor();
    await subagentTab.click();
    await page.locator('.agent-child-card').first().waitFor();
    await conversationTab.click();
    await page.locator('.session-row').filter({ hasText: 'Memory medium B' })
      .evaluate((node) => node.click());
    await page.locator('.chat-scroll').waitFor();
    await longRow.evaluate((node) => node.click());
    await page.locator('.chat-scroll').waitFor();
    console.log(`switch round ${round + 1}/5 complete`);
  }

  const renderer = await rendererMetrics(page);
  console.log(
    `renderer-stress: jsHeap=${renderer.jsHeapMiB.toFixed(1)} MiB `
    + `nodes=${renderer.nodes} documents=${renderer.documents}`,
  );
  assert.ok(renderer.jsHeapMiB < 450, 'stressed renderer JS heap exceeded 450 MiB');
  assert.ok(renderer.nodes < 120_000, 'stressed renderer DOM node count exceeded 120,000');
  const stressed = sample('renderer-stress');
  assert.ok(stressed.totalMiB < 900, 'stressed Electron process tree exceeded 900 MiB');

  await page.close();
  console.log('stress renderer closed');
  await sleep(5_000);
  const recovered = sample('after-window-close');
  assert.ok(
    recovered.totalMiB < stressed.totalMiB - 40,
    'closing the stress window did not release at least 40 MiB',
  );
  assert.deepEqual(errors, [], 'stress fixture emitted renderer errors');

  const closingApp = electronApp;
  electronApp = undefined;
  const closingProcess = closingApp.process();
  const processExited = once(closingProcess, 'exit').catch(() => {});
  console.log('requesting application quit');
  await closingApp.evaluate(({ app }) => {
    setImmediate(() => {
      app.isQuitting = true;
      app.quit();
    });
  });
  console.log('application quit request completed');
  await Promise.race([processExited, sleep(15_000)]);
  console.log(`application process exitCode=${String(closingProcess.exitCode)}`);
  if (closingProcess.exitCode === null) {
    await Promise.race([
      closingApp.close().catch(() => {}),
      sleep(5_000),
    ]);
  }
  await sleep(1_000);
  const remainingRows = processRows();
  const remaining = lastTrackedPids.filter((pid) => remainingRows.has(pid));
  assert.deepEqual(remaining, [], `Electron processes did not terminate: ${remaining.join(', ')}`);
  console.log('Memory smoke passed: bounded renderer growth and clean process teardown.');
} finally {
  await closeProcessTree();
  rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 200,
  });
}

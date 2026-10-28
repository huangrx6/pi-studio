/**
 * Footer 宿主桥接测试。
 *
 * 扩展的 footer 是终端组件：它返回文本行、用 handleMouse 命中分段、
 * 通过 showOverlay 画浮层。这里不启动 Electron，用一个最小的假组件验证
 * 宿主只做「字符单元 + 坐标 + 快照」的搬运，不掺入任何业务判断。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFooterHost, cells, cellWidth, normalizePanel } = require('../electron/services/footer-host.cjs');

/** 记录宿主发布出去的快照，模拟 renderer 收到的推送。 */
function createPublisher() {
  const events = [];
  return { events, publish: (payload) => events.push(payload) };
}

test('wide graphemes occupy two terminal columns', () => {
  assert.equal(cellWidth('a'), 1);
  assert.equal(cellWidth('中'), 2);
  assert.equal(cellWidth('🙂'), 2);
  // 与扩展的 visibleWidth 规则一致：23xx / 26xx 符号按两列计。
  assert.equal(cellWidth('⌘'), 2);
  assert.equal(cellWidth('◴'), 1);
  assert.deepEqual(cells('a中'), [{ text: 'a', width: 1 }, { text: '中', width: 2 }]);
});

test('semantic SGR colors become tones without affecting width', () => {
  assert.deepEqual(cells('\x1b[90ma\x1b[39m\x1b[1m中\x1b[22m'), [
    { text: 'a', width: 1, tone: 'muted' },
    { text: '中', width: 2, bold: true },
  ]);
});

test('a framed terminal panel becomes a native card without losing hit offsets', () => {
  const inner = 42;
  const title = '  会话统计';
  const close = 'ｘ ';
  const titleGap = ' '.repeat(inner - cells(title).reduce((sum, cell) => sum + cell.width, 0) - cells(close).reduce((sum, cell) => sum + cell.width, 0));
  const panel = normalizePanel([
    `╭${'─'.repeat(inner)}╮`,
    `│${title}${titleGap}${close}│`,
    `│${'─'.repeat(inner)}│`,
    `│  模型用时${' '.repeat(inner - 10 - 1 - 3)}—   │`,
    `╰${'─'.repeat(inner)}╯`,
  ]);

  assert.equal(panel.title, '会话统计');
  // 外框 1 行 + 标题 1 行 + 分隔线 1 行被裁掉；左侧去掉 1 列边框。
  assert.deepEqual(panel.offset, { row: 3, col: 1 });
  assert.deepEqual(panel.rowTypes, ['text']);
  assert.equal(panel.lines.length, 1);
  assert.equal(panel.contentWidth, inner);
  // 扩展的关闭按钮仍用原面板坐标（包含左侧边框）。
  const glyphCol = cells(title).reduce((sum, cell) => sum + cell.width, 0) + titleGap.length;
  assert.deepEqual(panel.close, { row: 1, col: 1 + glyphCol });
});

test('an unframed panel is passed through untouched', () => {
  const panel = normalizePanel(['status: ready', 'quota: 76%']);
  assert.equal(panel.title, '');
  assert.equal(panel.close, null);
  assert.deepEqual(panel.offset, { row: 0, col: 0 });
  assert.deepEqual(panel.rowTypes, ['text', 'text']);
  assert.equal(panel.contentWidth, 13);
});

test('footer content, hit regions and overlay stay in the extension', () => {
  const { events, publish } = createPublisher();
  const host = createFooterHost(publish);
  const received = [];
  let opened = false;
  let card;
  let overlayHandle;

  const footer = {
    render: () => ['运行 正常 · 额度 76%'],
    handleMouse(event) {
      received.push(event);
      if (event.type === 'click' && event.y === 0) {
        opened = true;
        card = {
          render: (width) => ['详情面板', `宽度 ${width}`, '按 Esc 关闭'],
          handleInput: (key) => { if (key === '\x1b') { opened = false; overlayHandle.hide(); } },
          handleMouse: (inner) => received.push({ ...inner, from: 'overlay' }),
        };
        overlayHandle = host.tui.showOverlay(card, { row: 4, col: 3, width: 20, maxHeight: 6, visible: () => true });
      }
    },
  };
  host.set(() => footer, { getExtensionStatuses: () => new Map() });

  assert.equal(events.at(-1).text, '运行 正常 · 额度 76%');
  assert.equal(events.at(-1).view.interactive, true);
  assert.equal(events.at(-1).view.lines[0].length, '运行 正常 · 额度 76%'.length);

  host.action({ type: 'resize', columns: 90, rows: 30, appearance: 'dark' });
  assert.equal(host.tui.terminal.columns, 90);
  assert.equal(host.tui.terminal.rows, 30);
  assert.equal(host.theme.appearance, 'dark');

  const snapshot = host.action({ type: 'click', target: 'footer', x: 2, y: 0 });
  assert.equal(received.at(-1).screenY, 29);
  assert.equal(received.at(-1).clickCount, 1);
  assert.equal(opened, true);
  assert.equal(snapshot.overlay.col, 3);
  assert.equal(snapshot.overlay.width, 20);
  assert.deepEqual(snapshot.overlay.lines[0].map((cell) => cell.text).join(''), '详情面板');

  // 浮层内的点击使用绝对坐标，扩展可以自己判断关闭按钮或滚动。
  host.action({ type: 'click', target: 'overlay', x: 1, y: 2 });
  assert.equal(received.at(-1).screenX, 4);
  assert.equal(received.at(-1).screenY, 6);

  // Esc 交回扩展处理，宿主不直接改 opened。
  host.action({ type: 'close' });
  assert.equal(opened, false);
  assert.equal(host.view.overlay, null);
});

test('a failing footer render degrades to an empty snapshot instead of throwing', () => {
  const { events, publish } = createPublisher();
  const host = createFooterHost(publish);
  host.set(() => ({
    render: () => { throw new Error('boom'); },
    handleMouse: () => {},
  }), { getExtensionStatuses: () => new Map() });

  assert.deepEqual(host.view, { lines: [], overlay: null, interactive: false });
  assert.equal(events.at(-1).text, '');
});

test('footer status changes only re-render when a footer exists', () => {
  const { events, publish } = createPublisher();
  const host = createFooterHost(publish);
  host.set(undefined, { getExtensionStatuses: () => new Map() });
  const before = events.length;
  host.render();
  assert.equal(events.length, before + 1);
  assert.equal(host.active, false);

  host.set(() => ({ render: () => ['x'] }), { getExtensionStatuses: () => new Map() });
  assert.equal(host.active, true);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const { typeDesktop } = require('../../electron/main/services/desktop-control/act.cjs');

function objcArray(items) {
  return { get count() { return items.length; }, objectAtIndex: i => items[i], addObject: item => items.push(item) };
}

function pasteboardItem(entries = {}) {
  return {
    entries,
    get types() { return objcArray(Object.keys(entries)); },
    dataForType(type) { return entries[type]; },
    setDataForType(data, type) { entries[type] = data; return true; },
  };
}

function typeIntoFixture(text, { submit = false, onPaste } = {}) {
  const originalData = { isNil: () => false };
  const original = { 'public.rtf': originalData, 'public.png': originalData };
  let contents = [pasteboardItem(original), pasteboardItem({ 'public.file-url': originalData })];
  const board = {
    changeCount: 3,
    get pasteboardItems() { return objcArray(contents); },
    // JXA evaluates zero-argument ObjC methods as getters, returning a number here.
    get clearContents() { contents = []; return ++this.changeCount; },
    setStringForType(value, type) { contents = [pasteboardItem({ [type]: value })]; return true; },
    writeObjects(items) { contents = Array.from({ length: items.count }, (_, i) => items.objectAtIndex(i)); return true; },
  };
  const keys = [];
  let fieldValue = 'old text';
  const field = { role: () => 'AXTextField', value: () => fieldValue };
  const app = { name: 'Fixture', bundleId: 'com.example.fixture' };
  const pid = 123;
  let frontPid = pid;
  let pendingFrontPid = pid;
  const windowId = 44;
  let frontWindowId = windowId;
  const se = {
    keyCode(code) {
      keys.push(code);
      if (code === 9) {
        assert.equal(contents[0].entries['public.utf8-plain-text'], text);
        fieldValue = text;
        onPaste?.({
          board,
          switchWindow: () => { frontWindowId++; },
          switchApp: () => { pendingFrontPid++; },
          changeValue: value => { fieldValue = value; },
        });
      }
    },
  };
  const context = vm.createContext({
    ObjC: { import() {}, deepUnwrap: v => v, castRefToObject: v => v },
    $: Object.assign(v => v, {
      NSPasteboard: { generalPasteboard: board },
      NSPasteboardTypeString: 'public.utf8-plain-text',
      NSPasteboardItem: { alloc: { get init() { return pasteboardItem(); } } },
      NSMutableArray: { alloc: { get init() { return objcArray([]); } } },
      NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ firstObject: null }) },
      NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return { processIdentifier: frontPid }; } } },
      NSRunLoop: { currentRunLoop: { runUntilDate() { frontPid = pendingFrontPid; } } },
      NSDate: { dateWithTimeIntervalSinceNow: n => n },
      CGWindowListCopyWindowInfo: () => [{
        kCGWindowOwnerPID: pid, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowNumber: frontWindowId,
      }],
    }),
    Application: () => se,
    delay() {},
  });
  const run = () => typeDesktop(app, { text, windowId, clear: true, submit }, {
    platform: 'darwin',
    listWindows: async () => [{ windowId, visible: true, bounds: { x: 0, y: 0, width: 480, height: 160 } }],
    getFocusedNode: async () => ({ role: 'AXTextField', secure: false }),
    runner: async (_cmd, args) => {
      vm.runInContext(args[3], context);
      context.findRunningApp = () => ({ pid });
      context.findSeProcess = () => ({ attributes: { byName: () => ({ value: () => field }) } });
      return { stdout: context.run(args.slice(4)) };
    },
  });
  return { run, keys, entries: () => contents.map(item => item.entries), original, originalData };
}

test('Latin search and Chinese text paste literally and restore all clipboard items', async () => {
  for (const [text, submit] of [['wx', false], ['中文🙂\n第二行', true]]) {
    const f = typeIntoFixture(text, { submit });
    const result = await f.run();
    assert.equal(result.method, 'paste');
    assert.equal(result.valueVerified, true);
    assert.deepEqual(f.keys, submit ? [0, 9, 36] : [0, 9]);
    assert.deepEqual(f.entries(), [f.original, { 'public.file-url': f.originalData }]);
  }
});

test('a focus change after paste stops Return and restores the clipboard', async () => {
  const f = typeIntoFixture('wx', { submit: true, onPaste: ({ switchWindow }) => switchWindow() });
  await assert.rejects(f.run, /目标窗口未在前台/);
  assert.deepEqual(f.keys, [0, 9]);
  assert.deepEqual(f.entries(), [f.original, { 'public.file-url': f.originalData }]);
});

test('an application switch during paste stops Return even when the target app still has the same window', async () => {
  const f = typeIntoFixture('wx', { submit: true, onPaste: ({ switchApp }) => switchApp() });
  await assert.rejects(f.run, /目标窗口未在前台/);
  assert.deepEqual(f.keys, [0, 9]);
});

test('a concurrent copy survives a paste and stops Return', async () => {
  const f = typeIntoFixture('wx', { submit: true, onPaste: ({ board }) => {
    board.clearContents;
    board.setStringForType('new clipboard', 'public.utf8-plain-text');
  } });
  await assert.rejects(f.run, /剪贴板已变化/);
  assert.deepEqual(f.keys, [0, 9]);
  assert.deepEqual(f.entries(), [{ 'public.utf8-plain-text': 'new clipboard' }]);
});

test('unexpected text in a readable target prevents submit', async () => {
  const f = typeIntoFixture('wx', { submit: true, onPaste: ({ changeValue }) => changeValue('old text') });
  await assert.rejects(f.run, /输入框内容与预期不符/);
  assert.deepEqual(f.keys, [0, 9]);
});

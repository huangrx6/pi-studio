import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  needsPasteConfirm,
  parseTerminalLink,
  stepTerminalFontSize,
  terminalKeyIntent,
} from '../../web/src/features/terminal/terminal-actions.ts';

const mac = { platform: 'mac' };

function key(overrides) {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    hasSelection: false,
    ...mac,
    ...overrides,
  };
}

test('字号夹在 11–20 之间，越界与非法值都有确定结果', () => {
  assert.equal(clampTerminalFontSize(14), 14);
  assert.equal(clampTerminalFontSize(2), MIN_TERMINAL_FONT_SIZE);
  assert.equal(clampTerminalFontSize(99), MAX_TERMINAL_FONT_SIZE);
  assert.equal(clampTerminalFontSize('nope'), DEFAULT_TERMINAL_FONT_SIZE);
  assert.equal(clampTerminalFontSize(undefined), DEFAULT_TERMINAL_FONT_SIZE);
  assert.equal(stepTerminalFontSize(12, 1), 13);
  assert.equal(stepTerminalFontSize(MIN_TERMINAL_FONT_SIZE, -1), MIN_TERMINAL_FONT_SIZE, '下界不再变化');
  assert.equal(stepTerminalFontSize(MAX_TERMINAL_FONT_SIZE, 1), MAX_TERMINAL_FONT_SIZE, '上界不再变化');
});

test('只有多行或超长的粘贴才需要确认', () => {
  assert.equal(needsPasteConfirm('ls -la'), false);
  assert.equal(needsPasteConfirm(''), false);
  assert.equal(needsPasteConfirm('git status\n'), false, '结尾换行不算第二条命令');
  assert.equal(needsPasteConfirm('pnpm build\npnpm test'), true);
  assert.equal(needsPasteConfirm('a'.repeat(401)), true);
});

test('终端只接管主修饰键组合，其余按键交回 shell', () => {
  assert.equal(terminalKeyIntent(key({ key: 'c', metaKey: true, hasSelection: true })), 'copy');
  assert.equal(terminalKeyIntent(key({ key: 'c', metaKey: true })), null, '没有选区时 ⌘C 是中断');
  assert.equal(terminalKeyIntent(key({ key: 'C', metaKey: true, shiftKey: true, hasSelection: true })), 'copy');
  assert.equal(terminalKeyIntent(key({ key: 'v', metaKey: true })), 'paste');
  assert.equal(terminalKeyIntent(key({ key: 'a', metaKey: true })), 'select-all');
  assert.equal(terminalKeyIntent(key({ key: 'f', metaKey: true })), 'search');
  assert.equal(terminalKeyIntent(key({ key: 'k', metaKey: true })), 'clear');
  assert.equal(terminalKeyIntent(key({ key: 't', metaKey: true })), 'new-terminal');
  assert.equal(terminalKeyIntent(key({ key: '=', metaKey: true })), 'zoom-in');
  assert.equal(terminalKeyIntent(key({ key: '-', metaKey: true })), 'zoom-out');
  assert.equal(terminalKeyIntent(key({ key: '0', metaKey: true })), 'zoom-reset');
  assert.equal(terminalKeyIntent(key({ key: 'ArrowUp', metaKey: true, shiftKey: true })), 'prev-command');
  assert.equal(terminalKeyIntent(key({ key: 'ArrowDown', metaKey: true, shiftKey: true })), 'next-command');
  assert.equal(terminalKeyIntent(key({ key: 'c', ctrlKey: true })), null, '⌃C 必须留给 shell');
  assert.equal(terminalKeyIntent(key({ key: 'ArrowUp' })), null);
  assert.equal(terminalKeyIntent(key({ key: 'r', metaKey: true })), null);
  assert.equal(terminalKeyIntent(key({ platform: 'other', key: 'v', ctrlKey: true })), 'paste');
  assert.equal(terminalKeyIntent(key({ platform: 'other', key: 'v', metaKey: true })), null);
});

test('链接解析区分 URL 与 path:line，不把普通文本当文件', () => {
  assert.deepEqual(parseTerminalLink('https://example.com/a?b=1'), { kind: 'url', url: 'https://example.com/a?b=1' });
  assert.deepEqual(parseTerminalLink('src/App.tsx:12:3'), { kind: 'file', path: 'src/App.tsx', line: 12, column: 3 });
  assert.deepEqual(parseTerminalLink('./docs/readme.md:7'), { kind: 'file', path: './docs/readme.md', line: 7, column: undefined });
  assert.deepEqual(parseTerminalLink('src/App.tsx'), { kind: 'file', path: 'src/App.tsx' });
  assert.equal(parseTerminalLink('warning:3'), null);
  assert.equal(parseTerminalLink('done'), null);
  assert.equal(parseTerminalLink(''), null);
});

test('拖进终端的路径按 shell 规则转义', async () => {
  const { shellQuotePath } = await import('../../web/src/features/terminal/terminal-actions.ts');
  assert.equal(shellQuotePath('/tmp/a.ts'), '/tmp/a.ts');
  assert.equal(shellQuotePath('/tmp/with space/a.ts'), "'/tmp/with space/a.ts'");
  assert.equal(shellQuotePath("/tmp/it's/a.ts"), "'/tmp/it'\\''s/a.ts'");
  assert.equal(shellQuotePath(''), '');
});

test('终端标题只保留可读主干，过长或为空时回退', async () => {
  const { terminalTabTitle } = await import('../../web/src/features/terminal/terminal-actions.ts');
  assert.equal(terminalTabTitle('pnpm dev', '终端'), 'pnpm dev');
  assert.equal(terminalTabTitle('~/Documents/workspace/pi-studio', '终端'), 'pi-studio');
  assert.equal(terminalTabTitle('', '终端'), '终端');
  assert.equal(terminalTabTitle('a'.repeat(30), '终端'), '终端');
  assert.equal(terminalTabTitle('zsh — 80x24', '终端'), 'zsh');
});

test('OSC 133 解析出提示符、命令开始与退出码', async () => {
  const { parseOsc133, commandFailed, adjacentCommand } = await import('../../web/src/features/terminal/terminal-commands.ts');
  assert.deepEqual(parseOsc133('A'), { type: 'prompt' });
  assert.deepEqual(parseOsc133('C'), { type: 'command-start' });
  assert.deepEqual(parseOsc133('D;1'), { type: 'command-end', exitCode: 1 });
  assert.deepEqual(parseOsc133('D;0'), { type: 'command-end', exitCode: 0 });
  assert.deepEqual(parseOsc133('D'), { type: 'command-end', exitCode: 0 });
  assert.equal(parseOsc133('B'), null);
  assert.equal(parseOsc133(''), null);
  assert.equal(commandFailed({ row: 3, exitCode: 0, done: true }), false);
  assert.equal(commandFailed({ row: 3, exitCode: 2, done: true }), true);
  assert.equal(commandFailed({ row: 3, done: false }), false, '还在执行的命令不算失败');
  const marks = [{ row: 5, done: true }, { row: 20, done: true }, { row: 40, done: true }];
  assert.equal(adjacentCommand(marks, 30, -1)?.row, 20);
  assert.equal(adjacentCommand(marks, 30, 1)?.row, 40);
  assert.equal(adjacentCommand(marks, 0, -1), null);
  assert.equal(adjacentCommand(marks, 99, 1), null);
});

test('命令表按落点记录，失败计数只算真正失败的', async () => {
  const { CommandTracker } = await import('../../web/src/features/terminal/terminal-commands.ts');
  const tracker = new CommandTracker();
  assert.equal(tracker.end(0), null, '没有开始就没有结束');
  tracker.start(3);
  assert.deepEqual(tracker.end(0), { row: 3, exitCode: 0, done: true });
  tracker.start(12);
  tracker.end(127);
  tracker.start(30);
  tracker.end(0);
  assert.equal(tracker.list().length, 3);
  assert.equal(tracker.failureCount(), 1);
  tracker.reset();
  assert.equal(tracker.list().length, 0);
});

/**
 * electron/sidebar-state.cjs 与 SDK 会话分叉的单元测试。
 *
 * 覆盖：
 * 1. 侧边栏元数据（重命名 / 隐藏 / 恢复 / 置顶 / 归档）能落盘、保留无关设置、
 *    并且可以反向操作；
 * 2. 非法的元数据操作（空名称、原型污染 ID、不支持的动作）不会改变状态；
 * 3. Pi SDK 的 SessionManager.forkFrom 会生成独立历史，源会话文件字节不变。
 *
 * 运行方式：
 *   pnpm test                                    # 跑 scripts/ 下全部单测
 *   node --test scripts/sidebar-state.test.cjs   # 只跑本文件
 *
 * 依赖：node:test / node:assert（Node 20+ 内置）、node:fs / os / path，
 *      以及 @earendil-works/pi-coding-agent（第 3 个用例）。
 * 所有文件操作都在系统临时目录内完成。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateSidebar } = require('../electron/sidebar-state.cjs');
const { readConfig, writeConfig } = require('../electron/settings-config.cjs');

test('sidebar changes persist, preserve unrelated settings, and are reversible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sidebar-'));
  try {
    const file = path.join(dir, 'config.json');
    // theme / modelRef 代表与侧边栏无关的设置，操作后必须原样保留。
    const original = { theme: 'dark', modelRef: 'provider/model' };

    // 连续执行一串操作，模拟用户在侧边栏里的实际操作顺序：
    // 重命名工作区（两侧空格应被 trim）→ 从侧边栏移除（hidden: true）→
    // 置顶会话 → 归档会话 → 重命名会话。
    let config = updateSidebar(original, {
      kind: 'workspace',
      id: '/project',
      action: 'rename',
      name: '  Project A  ',
    });
    config = updateSidebar(config, { kind: 'workspace', id: '/project', action: 'remove' });
    config = updateSidebar(config, { kind: 'session', id: 'session-a', action: 'pin' });
    config = updateSidebar(config, { kind: 'session', id: 'session-a', action: 'archive' });
    config = updateSidebar(config, { kind: 'session', id: 'session-a', action: 'rename', name: 'Title' });

    // 经过一次真实的写盘 + 读盘，确认元数据不是只存在内存里。
    writeConfig(file, config);
    config = readConfig(file, {});
    assert.deepEqual(config.workspaceMetadata['/project'], { name: 'Project A', hidden: true });
    assert.deepEqual(config.sessionMetadata['session-a'], {
      pinned: true,
      archived: true,
      name: 'Title',
    });
    assert.equal(config.theme, 'dark');
    assert.equal(config.modelRef, 'provider/model');
    // updateSidebar 是纯函数，不应原地修改传入的 config。
    assert.equal(original.workspaceMetadata, undefined);

    // 反向操作：恢复工作区、取消归档、取消置顶；名称等其它字段保持不变。
    config = updateSidebar(config, { kind: 'workspace', id: '/project', action: 'restore' });
    config = updateSidebar(config, { kind: 'session', id: 'session-a', action: 'archive' });
    config = updateSidebar(config, { kind: 'session', id: 'session-a', action: 'pin' });
    assert.equal(config.workspaceMetadata['/project'].hidden, false);
    assert.deepEqual(config.sessionMetadata['session-a'], {
      pinned: false,
      archived: false,
      name: 'Title',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid metadata actions cannot alter state', () => {
  // 三种非法输入：
  // - 工作区重命名为纯空格（名称必须 1–80 个字符）；
  // - 使用 __proto__ 作为 ID（防止原型污染）；
  // - 对会话执行 remove（remove 只适用于工作区）。
  const invalidInputs = [
    { kind: 'workspace', id: '/project', action: 'rename', name: ' ' },
    { kind: 'session', id: '__proto__', action: 'pin' },
    { kind: 'session', id: 's', action: 'remove' },
  ];
  for (const input of invalidInputs) assert.throws(() => updateSidebar({}, input));
});

test('SDK fork creates a separate history and leaves the source untouched', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fork-'));
  try {
    // 最小可用的 Pi 会话文件：第一行是 session 头（version 3），第二行是
    // 一条用户消息。parentId: null 表示它是历史的根条目。
    const source = path.join(dir, 'source.jsonl');
    const timestamp = new Date().toISOString();
    const lines = [
      {
        type: 'session',
        version: 3,
        id: 'source-session',
        timestamp,
        cwd: dir,
      },
      {
        type: 'message',
        id: 'entry1',
        parentId: null,
        timestamp,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'fixture history' }],
          timestamp: Date.now(),
        },
      },
    ];
    fs.writeFileSync(source, lines.map(JSON.stringify).join('\n') + '\n');
    const before = fs.readFileSync(source);

    // forkFrom(source, cwd, agentDir)：从源会话复制一份新的历史。
    const fork = SessionManager.forkFrom(source, dir, dir);
    fork.appendSessionInfo('Fork title');

    // 新会话必须有独立的 ID 和独立的文件，同时在 header 里记录来源路径，
    // 以便界面展示“分叉自哪个会话”。
    assert.notEqual(fork.getSessionId(), 'source-session');
    assert.notEqual(fork.getSessionFile(), source);
    assert.equal(fork.getHeader().parentSession, source);
    // 源会话的历史消息应被复制过来。
    assert.ok(fork.getEntries().some(
      (entry) => entry.type === 'message' && entry.message.content[0].text === 'fixture history',
    ));
    // 分叉操作只读源文件，源文件字节必须完全不变。
    assert.ok(fs.readFileSync(source).equals(before));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

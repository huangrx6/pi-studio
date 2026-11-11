const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  expandUserPath,
  resolveUserTarget,
} = require('../../electron/services/file-target.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-target-'));
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'out', 'report.xlsx'), 'x');
  return root;
}

test('expandUserPath 展开 ~ 与 file:// 前缀', () => {
  assert.equal(expandUserPath('~'), os.homedir());
  assert.equal(expandUserPath('~/Downloads/a.xlsx'), path.join(os.homedir(), 'Downloads/a.xlsx'));
  assert.equal(expandUserPath('  ./out/a.xlsx  '), './out/a.xlsx');
  assert.equal(expandUserPath('file:///tmp/a.xlsx'), '/tmp/a.xlsx');
  assert.throws(() => expandUserPath('   '), /缺少文件路径/);
  assert.throws(() => expandUserPath('a\0b'), /非法字符/);
});

test('相对路径以传入的会话工作目录为基准，而不是进程 cwd', () => {
  const root = fixture();
  assert.equal(resolveUserTarget('out/report.xlsx', { cwd: root }), fs.realpathSync(path.join(root, 'out', 'report.xlsx')));
  assert.equal(resolveUserTarget('./out/report.xlsx', { cwd: root }), fs.realpathSync(path.join(root, 'out', 'report.xlsx')));
  assert.equal(resolveUserTarget(path.join(root, 'out/report.xlsx')), fs.realpathSync(path.join(root, 'out', 'report.xlsx')));
});

test('不存在的路径、目录与缺失的工作目录都被拒绝', () => {
  const root = fixture();
  assert.throws(() => resolveUserTarget('out/missing.txt', { cwd: root }), /文件不存在或无法访问/);
  assert.throws(() => resolveUserTarget('out', { cwd: root }), /不是文件/);
  assert.throws(() => resolveUserTarget('out/report.xlsx'), /文件不存在或无法访问/);
});

test('凭据目录与系统目录在任何写法下都被拒绝', () => {
  assert.throws(() => resolveUserTarget(path.join(os.homedir(), '.ssh', 'id_rsa')), /不在预览范围内|不存在或无法访问/);
  assert.throws(() => resolveUserTarget(path.join(os.homedir(), 'Library/Application Support/pi-studio/x.bin')), /不在预览范围内|不存在或无法访问/);
  assert.throws(() => resolveUserTarget('/etc/hosts'), /不在预览范围内/);
  assert.throws(() => resolveUserTarget('/System/Library/CoreServices/SystemVersion.plist'), /不在预览范围内/);
});

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

// 保护范围按请求路径判定，所以这些位置即使文件不存在也报同一句，
// 断言不依赖具体平台的目录结构（CI 是 Linux，本地是 macOS）。
test('只有文件名的引用会在会话目录与一级子目录里找同名文件', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp-report.docx'), 'x');
  fs.writeFileSync(path.join(root, 'output', '交付.docx'), 'x');
  assert.equal(
    resolveUserTarget('tmp-report.docx', { cwd: root }),
    fs.realpathSync(path.join(root, 'tmp-report.docx')),
  );
  assert.equal(
    resolveUserTarget('交付.docx', { cwd: root }),
    fs.realpathSync(path.join(root, 'output', '交付.docx')),
  );
  assert.throws(() => resolveUserTarget('nope.docx', { cwd: root }), /文件不存在或无法访问/);
});

test('相对路径少写了前缀时，按尾段在工作区里找到唯一文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-target-suffix-'));
  const deep = path.join(root, 'skills', 'deck-authoring', 'scripts');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'render.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# root\n');
  // 模型常把 skills/<skill>/scripts/render.py 写成 scripts/render.py
  assert.equal(
    resolveUserTarget('scripts/render.py', { cwd: root }),
    fs.realpathSync(path.join(deep, 'render.py')),
  );
  // 裸文件名也能穿透多级目录
  assert.equal(resolveUserTarget('render.py', { cwd: root }), fs.realpathSync(path.join(deep, 'render.py')));
  // 确实不存在时仍然报不存在
  assert.throws(() => resolveUserTarget('scripts/styles.py', { cwd: root }), /文件不存在或无法访问/);
});

test('尾段命中多个文件时列出来，而不是随便挑一个', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-target-multi-'));
  for (const dir of ['a/scripts', 'b/scripts']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'build.py'), 'pass\n');
  }
  const error = (() => {
    try { resolveUserTarget('scripts/build.py', { cwd: root }); return null; } catch (caught) { return caught; }
  })();
  assert.match(error.message, /同名文件/);
  assert.match(error.message, /a\/scripts\/build\.py/);
  assert.match(error.message, /b\/scripts\/build\.py/);
});

test('凭据目录与系统目录在任何写法下都被拒绝', () => {
  assert.throws(() => resolveUserTarget(path.join(os.homedir(), '.ssh', 'id_rsa')), /不在预览范围内/);
  assert.throws(() => resolveUserTarget(path.join(os.homedir(), '.ssh/known_hosts')), /不在预览范围内/);
  assert.throws(() => resolveUserTarget(path.join(os.homedir(), 'Library/Application Support/pi-studio/x.bin')), /不在预览范围内/);
  assert.throws(() => resolveUserTarget('/etc/hosts'), /不在预览范围内/);
  assert.throws(() => resolveUserTarget('/private/etc/hosts'), /不在预览范围内/);
  assert.throws(() => resolveUserTarget('/System/Library/CoreServices/SystemVersion.plist'), /不在预览范围内/);
  assert.throws(() => resolveUserTarget(path.join(os.homedir(), 'credentials.json')), /可能包含凭据/);
});

/**
 * 导入一致性检查。
 *
 * 重构主进程时最容易犯的错误，是把某个函数从错误的模块里解构出来，
 * 这种错误只有运行到对应 IPC 才会暴露。这里从 Electron 的真实入口递归
 * 收集可达模块，再核对 `const { a, b } = require('./x.cjs')` 的导出名。
 * 不被入口引用的旧实现不会继续出现在测试图里。
 *
 * 只检查本地相对路径模块；目标模块如果依赖 electron（非纯模块）就跳过，
 * 因此不需要启动 Electron、也不读取用户配置。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '../..');
const ELECTRON_DIR = path.join(ROOT, 'electron');
// 名称部分不允许出现 } ; =，避免跨语句匹配到下一个 require。
const REQUIRE_PATTERN = /const\s*\{([^};=]*)\}\s*=\s*require\(\s*'(\.[^']+)'\s*\)/g;
const LOCAL_REQUIRE_PATTERN = /require\(\s*'(\.[^']+)'\s*\)/g;
const SOURCE_EXTENSIONS = new Set(['.cjs', '.mjs', '.js']);

/** 从一个文件的源码里取出所有解构导入：[{ file, target, names }]。 */
function collectImports(file) {
  const source = fs.readFileSync(file, 'utf8');
  const imports = [];
  for (const match of source.matchAll(REQUIRE_PATTERN)) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(':')[0].trim());
    imports.push({ file, target: path.resolve(path.dirname(file), match[2]), names });
  }
  return imports;
}

function resolveLocal(fromFile, request) {
  const target = path.resolve(path.dirname(fromFile), request);
  for (const candidate of [
    target,
    `${target}.cjs`,
    `${target}.mjs`,
    `${target}.js`,
    path.join(target, 'index.cjs'),
  ]) {
    try {
      if (fs.statSync(candidate).isFile() && SOURCE_EXTENSIONS.has(path.extname(candidate))) {
        return candidate;
      }
    } catch {
      // Try the next supported extension.
    }
  }
  return undefined;
}

function reachableSources(entries) {
  const visited = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(LOCAL_REQUIRE_PATTERN)) {
      const target = resolveLocal(file, match[1]);
      if (target) pending.push(target);
    }
  }
  return [...visited];
}

/** 尝试加载目标模块；依赖 Electron 或缺失的模块返回 undefined（跳过）。 */
function loadModule(target) {
  for (const candidate of [target, `${target}.cjs`, `${target}.mjs`, path.join(target, 'index.cjs')]) {
    try {
      if (fs.statSync(candidate).isFile()) return require(candidate);
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return undefined;
}

test('local destructured imports point at real exports', () => {
  // Keep this entry list aligned with package.json main and contextBridge roots.
  // ipc/index is included so a domain file accidentally no longer required by
  // main still fails loudly during the refactor.
  const entries = [
    path.join(ELECTRON_DIR, 'main.cjs'),
    path.join(ELECTRON_DIR, 'preload.cjs'),
    path.join(ELECTRON_DIR, 'ipc', 'index.cjs'),
  ];
  const sources = reachableSources(entries);
  const imports = sources.flatMap(collectImports);
  assert.ok(imports.length > 0, 'expected to find local imports in electron/');

  const checked = [];
  for (const { file, target, names } of imports) {
    let exported;
    try {
      exported = loadModule(target);
    } catch {
      // 目标模块依赖 Electron / 原生模块：跳过（例如 core/state.cjs）
      continue;
    }
    if (!exported) continue;
    const relative = path.relative(ROOT, file);
    for (const name of names) {
      assert.ok(name in exported, `${relative}: '${name}' is not exported by ${path.relative(ROOT, target)}`);
    }
    checked.push(relative);
  }

  assert.ok(checked.length > 0, 'expected at least one import to be verifiable');
  // 防止正则或目录扫描失效后测试变成空跑。
  assert.ok(checked.some((file) => file.endsWith(path.join('services', 'durable-conversations.cjs'))));
});

/**
 * macOS 外部应用相关：列出可用应用、查询某文件能用哪些应用打开、取应用图标、
 * 用指定应用打开文件。
 *
 * 这些能力依赖 macOS 自带命令（osascript / sips / open），只在本平台可用。
 */

const { nativeImage, shell } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 系统应用所在目录。 */
const APPLICATION_ROOTS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];

/** 应用图标缓存：appPath → dataURL。 */
const appIconCache = new Map();
/** 已安装应用静态映射缓存（不查询进程号）：Array<{ name, displayName, bundleId, executableName, path }>。 */
let appMappingCache = null;

/** 扫描系统目录里的 .app（按路径去重）。 */
function applications() {
  const apps = new Map();
  for (const root of APPLICATION_ROOTS) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      const appPath = path.join(root, entry.name);
      const name = entry.name.slice(0, -4);
      if (!apps.has(name)) apps.set(name, { name, path: appPath });
    }
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 静态扫描本机已安装应用的「中文显示名 / 英文包名 / Bundle ID / 安装路径」映射。
 * 仅读取磁盘静态元数据（NSBundle + NSFileManager），不查询实时进程号，结果常驻内存直到手动刷新。
 */
function installedAppMappings({ refresh = false } = {}) {
  if (appMappingCache && !refresh) return appMappingCache;
  const baseApps = applications();
  if (process.platform !== 'darwin' || !baseApps.length) {
    appMappingCache = baseApps.map((item) => ({
      name: item.name,
      displayName: item.name,
      bundleId: '',
      executableName: item.name,
      path: item.path,
    }));
    return appMappingCache;
  }

  const paths = baseApps.map((item) => item.path);
  const metaByPath = new Map();
  try {
    const script = `
ObjC.import('Foundation');
function run(argv) {
  var list = [];
  try { list = JSON.parse(String(argv[0] || '[]')); } catch (e) { list = []; }
  var fm = $.NSFileManager.defaultManager;
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var p = String(list[i] || '');
    if (!p) continue;
    var bundleId = '';
    var execName = '';
    var displayName = '';
    try {
      var b = $.NSBundle.bundleWithPath(p);
      if (b) {
        bundleId = String(ObjC.unwrap(b.bundleIdentifier) || '');
        var info = b.infoDictionary;
        if (info) {
          execName = String(ObjC.unwrap(info.objectForKey('CFBundleExecutable')) || '');
        }
      }
    } catch (e) {}
    try {
      displayName = String(ObjC.unwrap(fm.displayNameAtPath(p)) || '').replace(/\\.app$/i, '');
    } catch (e) {}
    out.push({ path: p, bundleId: bundleId, executableName: execName, displayName: displayName });
  }
  return JSON.stringify(out);
}
`.trim();
    const stdout = execFileSync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, JSON.stringify(paths)],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (row && typeof row.path === 'string') metaByPath.set(row.path, row);
      }
    }
  } catch {
    /* Fall back gracefully to folder basenames if osascript is unavailable. */
  }

  appMappingCache = baseApps.map((item) => {
    const meta = metaByPath.get(item.path) || {};
    const displayName = String(meta.displayName || '').trim() || item.name;
    const bundleId = String(meta.bundleId || '').trim();
    const executableName = String(meta.executableName || '').trim() || item.name;
    return {
      name: item.name,
      displayName,
      bundleId,
      executableName,
      path: item.path,
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans'));

  return appMappingCache;
}

/**
 * 查询能打开某个文件的应用列表（系统「打开方式」菜单的顺序）。
 * 借助 NSWorkspace 实现；失败时退回全量应用列表。
 */
function applicationsForFile(target) {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    const script = `ObjC.import('AppKit');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const apps = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(url);
  return ObjC.unwrap(apps).map((item) => { const appPath = ObjC.unwrap(item.path); const displayName = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(appPath)); return appPath + '\\t' + displayName; }).join('\\n');
}`;
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, target], { timeout: 6000 }, (error, stdout) => {
      if (error || !stdout) {
        resolve(applications());
        return;
      }
      const seen = new Set();
      const apps = [];
      for (const raw of String(stdout).split('\n')) {
        const [appPath, displayName] = raw.trim().split('\t');
        if (!appPath || !appPath.endsWith('.app')) continue;
        const name = (displayName || path.basename(appPath, '.app')).replace(/\.app$/, '');
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        apps.push({ name, path: appPath });
      }
      resolve(apps.length > 0 ? apps : applications());
    });
  });
}

/**
 * 取应用图标（32×32 PNG dataURL）。
 * 先从 .icns 用 sips 转 PNG（清晰），失败再退回 nativeImage。
 */
function applicationIcon(appPath) {
  if (appIconCache.has(appPath)) return appIconCache.get(appPath);
  try {
    const resources = path.join(appPath, 'Contents', 'Resources');
    const files = fs.readdirSync(resources).filter((file) => file.endsWith('.icns'));
    const preferred = ['AppIcon.icns', 'app.icns', 'icon.icns'];
    const file = preferred.map((name) => files.find((entry) => entry === name)).find(Boolean) ?? files[0];
    if (!file) return undefined;

    const png = path.join(os.tmpdir(), `pi-app-icon-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', '32', '32', path.join(resources, file), '--out', png], { stdio: 'ignore' });
    const data = `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`;
    try {
      fs.unlinkSync(png);
    } catch {
      /* 临时文件清理失败可忽略 */
    }
    appIconCache.set(appPath, data);
    return data;
  } catch {
    try {
      const image = nativeImage.createFromPath(appPath);
      if (!image.isEmpty()) {
        const data = image.resize({ width: 32, height: 32 }).toDataURL();
        appIconCache.set(appPath, data);
        return data;
      }
    } catch {
      /* 没有图标 */
    }
    appIconCache.set(appPath, undefined);
    return undefined;
  }
}

/**
 * 用指定应用打开文件；不传应用时走系统默认打开方式。
 */
function openWithApp(target, appPath) {
  if (!appPath) {
    return shell.openPath(target).then((error) => {
      if (error) throw new Error(error);
    });
  }
  if (!appPath.endsWith('.app') || !fs.existsSync(appPath)) throw new Error('应用程序不存在');
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', appPath, target], (error) => (error ? reject(error) : resolve()));
  });
}

module.exports = { applications, installedAppMappings, applicationsForFile, applicationIcon, openWithApp };

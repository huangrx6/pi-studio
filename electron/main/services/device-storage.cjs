const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getAppCacheDir } = require('electron-updater/out/AppAdapter');
const { parse: parseYaml } = require('yaml');
const {
  DOWNLOADS_DIRECTORY,
  PLUGIN_DATA_DIRECTORY,
  PLUGIN_INSTALL_DIRECTORY,
  STUDIO_CACHE_DIR,
  STUDIO_DATA_DIRECTORY,
  STUDIO_MANAGED_DATA_DIR,
} = require('../core/studio-paths.cjs');
const { CHROMIUM_ENTRIES, cleanLegacyChromiumData, pruneEmptyManagedDirectories } = require('../core/user-data.cjs');
const { listDatabaseBackups, pruneDatabaseBackups } = require('../core/database-backups.cjs');

const studioCategories = new Map();
const studioExactCategories = new Map([
  [STUDIO_CACHE_DIR, 'resources'],
  ['Cache', 'client'],
]);
for (const [category, names] of Object.entries({
  attachments: ['attachments'],
  worktrees: ['worktrees'],
  media: ['background-media', 'browser-downloads', DOWNLOADS_DIRECTORY],
  resources: ['skills', 'skill-quarantine', 'extensions', 'extension-data', 'extension-cache', 'extension-state',
    'extension-publishers.json', PLUGIN_INSTALL_DIRECTORY, PLUGIN_DATA_DIRECTORY,
    'plugin-quarantine', 'model-catalogs', STUDIO_CACHE_DIR, 'AGENTS.md'],
  client: [...CHROMIUM_ENTRIES, 'Crashpad', 'Dictionaries', 'Network', 'WebStorage', 'logs', 'Variations'],
})) {
  for (const name of names) studioCategories.set(name.toLowerCase(), category);
}

const managedDataCategories = new Map();
for (const [category, names] of Object.entries({
  attachments: ['attachments'],
  worktrees: ['worktrees'],
  media: ['background-media'],
  resources: [PLUGIN_DATA_DIRECTORY, 'extension-data', 'extension-state'],
})) {
  for (const name of names) managedDataCategories.set(name.toLowerCase(), category);
}

const categories = ['database', 'attachments', 'worktrees', 'resources', 'media', 'client', 'other'];
const companions = ['', '-wal', '-shm', '-journal'];
const missing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

// The packaged updater chooses its own OS cache base, separately from Electron userData.
async function updateCacheDirectory(resources, cacheBase = getAppCacheDir()) {
  try {
    const config = parseYaml(await fs.readFile(path.join(resources, 'app-update.yml'), 'utf8'));
    const name = config?.updaterCacheDirName;
    if (typeof name === 'string' && name && !/[\\/:]/.test(name) && name !== '.' && name !== '..') return path.join(cacheBase, name);
  } catch (error) { if (!missing(error)) throw error; }
}

const pathKey = (file, paths = path) => paths === path.win32 ? paths.normalize(file).toLowerCase() : paths.normalize(file);
function contains(parent, file, paths = path) {
  const relative = paths.relative(parent, file);
  return relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative);
}

function allowedLocation(file, { home, appData }, paths = path) {
  return paths.isAbsolute(file) && paths.relative(paths.parse(file).root, file) !== ''
    && !contains(file, home, paths) && !contains(file, appData, paths)
    && paths.relative(home, file).split(paths.sep)[0].toLowerCase() !== '.pi';
}

// The renderer gets a recognizable location label and an opaque action ID. Only
// the main process resolves full paths, including redirected profiles and UNC shares.
function storageLocations(sources, paths = path) {
  const { studio, client, session, database, home, appData, projects, worktrees } = sources;
  const rows = new Map();
  function add(kind, file, place) {
    if (!paths.isAbsolute(file)) return;
    const target = paths.resolve(file);
    const key = pathKey(target, paths);
    const existing = rows.get(key);
    if (existing) {
      if (kind === 'client' && existing.kind === 'studio') existing.shared = true;
      return;
    }
    const parent = paths.dirname(target);
    const onWindows = paths === path.win32;
    if (!place && !paths.relative(home, parent)) place = '个人文件夹';
    if (!place && !paths.relative(appData, parent)) place = onWindows ? '应用数据文件夹' : '应用支持目录';
    if (!place && onWindows) place = target.startsWith('\\\\') ? '网络位置' : paths.parse(target).root.slice(0, 2);
    if (kind === 'worktrees' && paths.relative(paths.parse(parent).root, parent)) {
      place = [place, paths.basename(parent)].filter(Boolean).join(' · ');
    }
    const id = kind === 'worktrees' || kind === 'project'
      ? kind + '-' + createHash('sha256').update(key).digest('hex').slice(0, 24) : kind;
    rows.set(key, { id, kind, target, name: paths.basename(target), place: place || '自定义位置' });
  }
  add('studio', studio);
  add('client', client);
  add('session', session);
  if (sources.updates) add('updates', sources.updates, '系统缓存');
  for (const root of worktrees) add('worktrees', root);
  for (const cwd of projects) {
    if (paths.isAbsolute(cwd)) add('project', paths.join(cwd, STUDIO_DATA_DIRECTORY), paths.basename(cwd) || '工作区');
  }
  add('database', database);
  return [...rows.values()];
}

function isBackup(name, dbName) {
  const prefix = dbName + '.migration-backup-';
  return name.startsWith(prefix) && /^v\d+-to-v\d+(?:-copy-\d+)?\.sqlite(?:\.[\w-]+\.partial)?$/.test(name.slice(prefix.length));
}

async function inspectLocation(row, sources, physicalBounds) {
  const result = { ...row, bytes: 0, status: 'unavailable', canOpen: false };
  if (!allowedLocation(row.target, sources)) return result;
  try {
    let stat = await fs.lstat(row.target, { bigint: true });
    // A user may relocate the entire application profile. Only these explicitly
    // configured roots can be aliases; links inside a store are never traversed.
    if (stat.isSymbolicLink() && !['studio', 'client', 'session'].includes(row.kind)) return result;
    const physical = await fs.realpath(row.target);
    if (!allowedLocation(physical, physicalBounds)) return result;
    if (stat.isSymbolicLink()) stat = await fs.lstat(physical, { bigint: true });
    if (row.kind === 'database' ? !stat.isFile() : !stat.isDirectory()) return result;
    const identity = stat.ino ? stat.dev + '/' + stat.ino : undefined;
    return { ...result, physical, identity, status: 'ready', canOpen: true };
  } catch (error) {
    // Most projects never create a .pi-studio directory.
    return (row.kind === 'project' || row.kind === 'updates') && missing(error) ? undefined : result;
  }
}

async function measureStorage(sources) {
  const rows = [];
  const roots = new Map();
  const identities = new Map();
  const physicalBounds = {
    home: await fs.realpath(sources.home).catch(() => sources.home),
    appData: await fs.realpath(sources.appData).catch(() => sources.appData),
  };
  let database;
  for (const spec of storageLocations(sources)) {
    const row = await inspectLocation(spec, sources, physicalBounds);
    if (!row) continue;
    if (row.kind === 'database') { database = row; continue; }
    const key = pathKey(row.physical || row.target);
    const previous = roots.get(key) || identities.get(row.identity);
    if (previous) {
      if (previous.kind === 'studio' && row.kind === 'client') previous.shared = true;
      roots.set(key, previous);
      continue;
    }
    roots.set(key, row);
    if (row.identity) identities.set(row.identity, row);
    rows.push(row);
  }
  const dbFile = database?.physical || sources.database;
  const dbNames = new Set(companions.map(suffix => pathKey(dbFile + suffix)));
  const backupFolder = path.join(path.dirname(dbFile), 'backups', 'sqlite');
  const backupKey = pathKey(backupFolder);
  const dbName = path.basename(pathKey(dbFile));
  const ownsDatabase = rows.some(row => row.physical && contains(row.physical, dbFile));
  if (database && !ownsDatabase) rows.push(database);

  const totals = Object.fromEntries(categories.map(key => [key, 0]));
  const hardlinks = new Map();
  function count(row, file, stat, category) {
    const key = pathKey(file);
    if (dbNames.has(key) || (path.dirname(key) === backupKey && isBackup(path.basename(key), dbName))) category = 'database';
    const bytes = Number(stat.size);
    // Concurrent walks can encounter either name of a linked attachment first.
    // Prefer the more specific category consistently across refreshes.
    if (stat.nlink > 1n && stat.ino !== 0n) {
      const id = stat.dev + '/' + stat.ino;
      const previous = hardlinks.get(id);
      if (previous) {
        if (categories.indexOf(previous.category) <= categories.indexOf(category)) return;
        previous.row.bytes -= previous.bytes;
        totals[previous.category] -= previous.bytes;
      }
      hardlinks.set(id, { row, category, bytes });
    }
    row.bytes += bytes;
    totals[category] += bytes;
  }

  async function walk(row) {
    const initial = { project: 'resources', worktrees: 'worktrees', client: 'client', session: 'client', updates: 'client' }[row.kind] || 'other';
    const managedDataRoot = row.kind === 'studio' ? path.join(row.physical, STUDIO_MANAGED_DATA_DIR) : '';
    const pending = [{ file: row.physical, category: initial }];
    // Limit in-flight filesystem calls even for a checkout with thousands of files.
    while (pending.length) {
      await Promise.all(pending.splice(-24).map(async ({ file, category }) => {
        try {
          const stat = await fs.lstat(file, { bigint: true });
          if (stat.isFile()) { count(row, file, stat, category); return; }
          if (!stat.isDirectory()) return; // Includes symbolic links and Windows junctions.
          const owner = identities.get(stat.dev + '/' + stat.ino);
          if (owner && owner !== row) return;
          for (const name of await fs.readdir(file)) {
            const child = path.join(file, name);
            if (roots.has(pathKey(child))) continue; // Each nested location owns its own bytes.
            let nextCategory = category;
            if (row.kind === 'studio' && file === row.physical) {
              nextCategory = studioExactCategories.get(name) ?? studioCategories.get(name.toLowerCase()) ?? 'other';
            } else if (row.kind === 'studio' && file === managedDataRoot) {
              nextCategory = managedDataCategories.get(name.toLowerCase()) || 'other';
            }
            pending.push({ file: child, category: nextCategory });
          }
        } catch (error) {
          if (file === row.physical) { row.status = 'unavailable'; row.canOpen = false; }
          else if (!missing(error)) row.status = 'partial';
        }
      }));
    }
  }

  // An external SQLite file can share a parent directory with unrelated files.
  // Inspect only this database family and its named migration snapshots there.
  async function measureDatabase(row) {
    async function addFile(file) {
      try {
        const stat = await fs.lstat(file, { bigint: true });
        if (stat.isFile()) count(row, file, stat, 'database');
      } catch (error) { if (!missing(error) || file === dbFile) row.status = 'partial'; }
    }
    for (const suffix of companions) await addFile(dbFile + suffix);
    if ([...roots.values()].some(root => root.physical && contains(root.physical, backupFolder))) return;
    try {
      for (const dir of [path.dirname(backupFolder), backupFolder]) {
        if (!(await fs.lstat(dir)).isDirectory()) return;
      }
      for (const name of await fs.readdir(backupFolder)) {
        if (isBackup(path.basename(pathKey(name)), dbName)) await addFile(path.join(backupFolder, name));
      }
    } catch (error) { if (!missing(error)) row.status = 'partial'; }
  }

  for (const row of rows) {
    if (!row.physical) continue;
    if (row.kind === 'database') await measureDatabase(row);
    else await walk(row);
  }
  return {
    snapshot: {
      totalBytes: Object.values(totals).reduce((sum, bytes) => sum + bytes, 0),
      categories: totals,
      measuredAt: Date.now(),
      locationsIncomplete: Boolean(sources.locationsIncomplete),
      locations: rows.map(({ target, physical, identity, ...display }) => display),
    },
    targets: new Map(rows.filter(row => row.canOpen).map(row => [row.id, row])),
  };
}

const CLEANABLE_CACHE_DIRS = [
  [STUDIO_CACHE_DIR],
  ['model-catalogs'],
  ['extension-cache', 'quarantine'],
  ['plugin-quarantine'],
  ['skill-quarantine'],
];

async function directoryBytes(target) {
  let stat;
  try { stat = await fs.lstat(target); } catch { return 0; }
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let total = 0;
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      try {
        const childStat = await fs.lstat(child);
        if (childStat.isFile()) total += childStat.size;
        else if (childStat.isDirectory()) pending.push(child);
      } catch {
        // Ignore transient entries during measurement.
      }
    }
  }
  return total;
}

async function clearDirectoryContents(target) {
  let stat;
  try { stat = await fs.lstat(target); } catch { return 0; }
  if (!stat.isDirectory()) return 0;
  let freed = 0;
  let entries;
  try { entries = await fs.readdir(target, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    const bytes = await directoryBytes(child);
    try {
      await fs.rm(child, { recursive: true, force: true });
      freed += bytes;
    } catch {
      // Skip entries currently in use.
    }
  }
  return freed;
}

async function measureMaintenance(sources, getDatabaseStats) {
  let oldBackupCount = 0;
  let oldBackupBytes = 0;
  if (typeof sources.database === 'string' && path.isAbsolute(sources.database)) {
    try {
      const prunable = listDatabaseBackups(sources.database).slice(1);
      oldBackupCount = prunable.length;
      oldBackupBytes = prunable.reduce((sum, item) => sum + item.bytes, 0);
    } catch {
      // Best-effort backup scan.
    }
  }
  let reclaimableDatabaseBytes = 0;
  if (typeof getDatabaseStats === 'function') {
    try {
      const stats = await getDatabaseStats();
      reclaimableDatabaseBytes = Math.max(0, Number(stats?.reclaimableBytes) || 0);
    } catch {
      // Best-effort SQLite freelist reading.
    }
  }
  let cacheBytes = 0;
  if (typeof sources.studio === 'string' && path.isAbsolute(sources.studio)) {
    for (const segments of CLEANABLE_CACHE_DIRS) {
      cacheBytes += await directoryBytes(path.join(sources.studio, ...segments));
    }
  }
  return {
    oldBackupCount,
    oldBackupBytes,
    reclaimableDatabaseBytes,
    cacheBytes,
    totalCleanableBytes: oldBackupBytes + reclaimableDatabaseBytes + cacheBytes,
  };
}

function createDeviceStorageService({ getSources, shell, clipboard, getDatabaseStats, compactDatabase }) {
  let inFlight;
  let cleanupInFlight;
  let targets = new Map();
  async function takeSnapshot() {
    const sources = await getSources();
    const result = await measureStorage(sources);
    const maintenance = await measureMaintenance(sources, getDatabaseStats);
    targets = result.targets;
    return { ...result.snapshot, maintenance };
  }
  return {
    snapshot() {
      inFlight ??= takeSnapshot().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    cleanup() {
      cleanupInFlight ??= (async () => {
        const sources = await getSources();
        let freedBytes = 0;
        let removedBackups = 0;
        let removedEmptyDirs = 0;
        let prunedTraces = 0;

        if (typeof sources.database === 'string' && path.isAbsolute(sources.database)) {
          try {
            const pruned = pruneDatabaseBackups(sources.database, { keep: 1 });
            removedBackups = pruned.removed.length;
            freedBytes += pruned.freedBytes;
          } catch {
            // Keep cleanup resilient if backup folder is unavailable.
          }
        }

        if (typeof sources.studio === 'string' && path.isAbsolute(sources.studio)) {
          for (const segments of CLEANABLE_CACHE_DIRS) {
            freedBytes += await clearDirectoryContents(path.join(sources.studio, ...segments));
          }
          try { cleanLegacyChromiumData({ target: sources.studio }); } catch { /* best effort */ }
          try { removedEmptyDirs = pruneEmptyManagedDirectories({ target: sources.studio }).length; } catch { /* best effort */ }
        }

        if (typeof compactDatabase === 'function') {
          try {
            const compacted = await compactDatabase();
            freedBytes += Math.max(0, Number(compacted?.freedBytes) || 0);
            prunedTraces = Math.max(0, Number(compacted?.prunedTraces) || 0);
          } catch {
            // If another query holds a lock, still return refreshed storage snapshot.
          }
        }

        const snapshot = await takeSnapshot();
        return {
          snapshot,
          summary: { freedBytes, removedBackups, removedEmptyDirs, prunedTraces },
        };
      })().finally(() => { cleanupInFlight = undefined; });
      return cleanupInFlight;
    },
    async useLocation(id, action) {
      const row = targets.get(id);
      if (!row || !['open', 'copy'].includes(action)) throw new Error('请选择已统计的存储位置。');
      const physical = await fs.realpath(row.target).catch(() => '');
      const stat = physical === row.physical && await fs.lstat(physical).catch(() => null);
      if (!stat || (row.kind === 'database' ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('存储位置已变化，请刷新后重试。');
      }
      if (action === 'copy') clipboard.writeText(physical);
      else if (row.kind === 'database') shell.showItemInFolder(physical);
      else if (await shell.openPath(physical)) throw new Error('无法打开文件夹，请检查磁盘连接和访问权限。');
    },
  };
}

module.exports = { createDeviceStorageService, storageLocations, updateCacheDirectory };

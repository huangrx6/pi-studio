const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BACKUP_RETENTION = 2;
const STALE_PARTIAL_AGE_MS = 60 * 60 * 1000;
const BACKUP_SUFFIX_RE = /^v(\d+)-to-v(\d+)(?:-copy-(\d+))?\.sqlite$/;
const PARTIAL_SUFFIX_RE = /^v\d+-to-v\d+(?:-copy-\d+)?\.sqlite\.[\w-]+\.partial$/;

function backupDirectoryPath(filename) {
  return path.join(path.dirname(filename), 'backups', 'sqlite');
}

function backupDirectory(filename) {
  let directory = path.dirname(filename);
  for (const name of ['backups', 'sqlite']) {
    directory = path.join(directory, name);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('数据库备份位置不是普通目录');
  }
  return directory;
}

function migrationBackupPath(filename, from, to) {
  return path.join(backupDirectory(filename), `${path.basename(filename)}.migration-backup-v${from}-to-v${to}.sqlite`);
}

function parseMigrationBackupName(name, dbName) {
  const prefix = `${dbName}.migration-backup-`;
  if (!name.startsWith(prefix)) return null;
  const match = BACKUP_SUFFIX_RE.exec(name.slice(prefix.length));
  if (!match) return null;
  return {
    from: Number(match[1]),
    to: Number(match[2]),
    copy: match[3] ? Number(match[3]) : 0,
  };
}

function listDatabaseBackups(filename) {
  const folder = backupDirectoryPath(filename);
  let entries;
  try {
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory()) return [];
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
  const dbName = path.basename(filename);
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseMigrationBackupName(entry.name, dbName);
    if (!parsed) continue;
    const filePath = path.join(folder, entry.name);
    if (['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(filePath + suffix))) continue;
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    backups.push({
      name: entry.name,
      path: filePath,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ...parsed,
    });
  }
  backups.sort((left, right) => (
    right.to - left.to
    || right.from - left.from
    || right.mtimeMs - left.mtimeMs
    || right.copy - left.copy
    || right.name.localeCompare(left.name)
  ));
  return backups;
}

/**
 * Retain only the newest `keep` completed migration snapshots for `filename`
 * and remove abandoned `.partial` snapshot files left by interrupted upgrades.
 */
function pruneDatabaseBackups(filename, {
  keep = DEFAULT_BACKUP_RETENTION,
  partialMaxAgeMs = STALE_PARTIAL_AGE_MS,
  now = Date.now,
} = {}) {
  const limit = Number.isInteger(keep) && keep >= 0 ? keep : DEFAULT_BACKUP_RETENTION;
  const backups = listDatabaseBackups(filename);
  const kept = backups.slice(0, limit);
  const stale = backups.slice(limit);
  const removed = [];
  let freedBytes = 0;

  for (const item of stale) {
    try {
      fs.rmSync(item.path, { force: true });
      removed.push(item.name);
      freedBytes += item.bytes;
    } catch {
      // Locked or concurrently removed snapshots are skipped safely.
    }
  }

  const folder = backupDirectoryPath(filename);
  const dbName = path.basename(filename);
  const prefix = `${dbName}.migration-backup-`;
  const cutoff = now() - Math.max(0, partialMaxAgeMs);
  try {
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        if (!PARTIAL_SUFFIX_RE.test(entry.name.slice(prefix.length))) continue;
        const candidate = path.join(folder, entry.name);
        const fileStat = fs.lstatSync(candidate, { throwIfNoEntry: false });
        if (!fileStat?.isFile() || fileStat.mtimeMs > cutoff) continue;
        try {
          fs.rmSync(candidate, { force: true });
          removed.push(entry.name);
          freedBytes += fileStat.size;
        } catch {
          // Best-effort cleanup of stale partial files.
        }
      }
    }
  } catch {
    // Ignore missing/unreadable backup directory during cleanup.
  }

  return { removed, kept: kept.map(item => item.name), freedBytes };
}

// Layout v1. Move only standalone migration snapshots of this particular database.
// A second opener or an interrupted move must never overwrite either copy.
function organizeDatabaseBackups(filename) {
  const folder = path.dirname(filename);
  const prefix = path.basename(filename) + '.migration-backup-';
  let moved = 0;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !/^v\d+-to-v\d+\.sqlite$/.test(entry.name.slice(prefix.length))) continue;
    const source = path.join(folder, entry.name);
    if (['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(source + suffix))) continue;
    const destination = path.join(backupDirectory(filename), entry.name);
    for (let i = 0; ; i++) {
      const target = i ? destination.replace(/\.sqlite$/, `-copy-${i}.sqlite`) : destination;
      try {
        fs.linkSync(source, target);
      } catch (error) {
        if (error.code === 'ENOENT' && !fs.existsSync(source)) break;
        if (error.code === 'EEXIST') {
          const old = fs.statSync(source, { throwIfNoEntry: false });
          const existing = fs.lstatSync(target);
          if (!old) break;
          if (!old.ino || old.dev !== existing.dev || old.ino !== existing.ino) continue;
        } else if (['EPERM', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP'].includes(error.code)) {
          try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
          catch (copyError) { if (copyError.code === 'EEXIST') continue; throw copyError; }
        } else throw error;
      }
      try { fs.unlinkSync(source); moved++; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      break;
    }
  }
  return moved;
}

module.exports = {
  DEFAULT_BACKUP_RETENTION,
  backupDirectoryPath,
  listDatabaseBackups,
  migrationBackupPath,
  organizeDatabaseBackups,
  pruneDatabaseBackups,
};

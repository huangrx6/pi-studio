const fs = require('node:fs');
const path = require('node:path');

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

module.exports = { migrationBackupPath, organizeDatabaseBackups };

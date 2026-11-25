const fs = require('node:fs');
const path = require('node:path');
const pending = new Map();

// Only committed internal staging/backup paths enter this queue. Never discover
// arbitrary dot-directories, or delete a replacement the user put at that path.
function cleanupCommittedSkillDirectory(directory) {
  let identity;
  try { identity = fs.lstatSync(directory); }
  catch { return; }
  if (!identity.isDirectory() || identity.isSymbolicLink()) return;
  pending.set(directory, { dev: identity.dev, ino: identity.ino });
  retryCommittedSkillCleanup();
}

function retryCommittedSkillCleanup() {
  for (const [directory, identity] of pending) {
    try {
      const current = fs.lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
        pending.delete(directory);
        continue;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      pending.delete(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') pending.delete(directory);
    }
  }
}

// rmdir succeeds only after every concurrently prepared preview has released its files.
function removeEmptyQuarantine(directory) {
  try { fs.rmdirSync(directory); } catch { return; }
  const quarantineParent = path.dirname(directory);
  if (path.basename(quarantineParent) !== 'quarantine') return;
  try { fs.rmdirSync(quarantineParent); } catch { return; }
  const cacheParent = path.dirname(quarantineParent);
  if (path.basename(cacheParent) === 'cache') {
    try { fs.rmdirSync(cacheParent); } catch { /* cache may hold model-catalogs */ }
  }
}

module.exports = { cleanupCommittedSkillDirectory, retryCommittedSkillCleanup, removeEmptyQuarantine };

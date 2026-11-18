/**
 * pnpm's content-addressed store can materialize node-pty's Unix helper
 * without its executable bit. The helper must be runnable both from a normal
 * development install and from Electron's app.asar.unpacked tree.
 */

const fs = require('node:fs');
const path = require('node:path');

function ensurePtyHelpers(root) {
  if (process.platform === 'win32') return [];
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync(root);
  } catch {
    return [];
  }
  const changed = [];
  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile() && entry.name === 'spawn-helper') {
        fs.chmodSync(target, 0o755);
        changed.push(target);
      }
    }
  }
  return changed;
}

if (require.main === module) {
  const root = path.join(process.cwd(), 'node_modules', 'node-pty');
  const helpers = ensurePtyHelpers(root);
  if (helpers.length === 0 && !fs.existsSync(root)) {
    process.stderr.write('[pi-studio] node-pty is not installed; skipped helper check\n');
  }
}

module.exports = { ensurePtyHelpers };

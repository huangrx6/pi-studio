const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

// Git shares its object database, but checking out a tree still needs the file contents.
async function checkWorktreeSpace(repository, revision, parent) {
  let space;
  try { space = await fs.statfs(parent, { bigint: true }); }
  catch (error) {
    if (['ENOSYS', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  if (!space.bsize || !space.blocks) return;
  // Stream sizes in Git's long format, which is also supported by older Git installations.
  const available = space.bavail * space.bsize;
  let bytes = 0n;
  let pending = '';
  const list = spawn('git', ['-C', repository, 'ls-tree', '-rlz', revision], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  list.stdout.setEncoding('utf8');
  let errorText = '';
  list.stderr.on('data', chunk => { if (errorText.length < 1000) errorText += chunk; });
  await new Promise((resolve, reject) => {
    list.once('error', reject);
    list.stdout.on('data', chunk => {
      const rows = (pending + chunk).split('\0');
      pending = rows.pop();
      for (const row of rows) {
        const size = /^\d+ blob [0-9a-f]+\s+(\d+)\t/.exec(row)?.[1];
        if (size) bytes += BigInt(size);
      }
      if (bytes > available) list.kill();
    });
    list.once('close', code => {
      if (bytes > available) reject(new Error('目标磁盘空间不足，请选择其他工作树位置或释放磁盘空间。'));
      else if (code !== 0) reject(new Error(errorText.trim() || '无法估算工作树大小'));
      else resolve();
    });
  });
}

module.exports = { checkWorktreeSpace };

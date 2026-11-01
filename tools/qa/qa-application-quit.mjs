/** Real Electron quit regression. Never pre-set isQuitting or use close() to pass. */
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function descendants(pid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map(row => row.trim().split(/\s+/).map(Number));
  const found = new Set([pid]);
  let size;
  do { size = found.size; for (const [child, parent] of rows) if (found.has(parent)) found.add(child); } while (size !== found.size);
  return [...found];
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

for (const scenario of ['visible', 'hidden-with-popover', 'native-terminate']) {
  const profile = mkdtempSync(path.join(tmpdir(), 'pi-studio-quit-qa-'));
  const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_STUDIO_DEV;
  let app;
  let proc;
  let tracked = [];
  try {
    app = await _electron.launch({ args: [root], env });
    proc = app.process();
    tracked = descendants(proc.pid);
    await app.firstWindow();
    if (scenario === 'hidden-with-popover') {
      await app.evaluate(async ({ BrowserWindow }, repo) => {
        const main = BrowserWindow.getAllWindows()[0];
        main.close();
        if (main.isDestroyed() || main.isVisible()) throw Error('Window close must only hide');
        const require = process.getBuiltinModule('module').createRequire(`${repo}/package.json`);
        await require(`${repo}/electron/services/menu-bar.cjs`).showMenuBarPopover();
      }, root);
    }
    tracked = [...new Set([...tracked, ...descendants(proc.pid)])];
    let exit;
    const exited = new Promise(resolve => { exit = resolve; proc.once('exit', resolve); });
    await app.evaluate(({ app, ipcMain, Menu }, scenario) => {
      setImmediate(() => {
        if (scenario === 'hidden-with-popover') ipcMain.emit('pi:menu-bar-quit');
        else if (scenario === 'native-terminate') {
          Menu.sendActionToFirstResponder('terminate:');
        } else app.quit();
      });
    }, scenario);
    const deadline = setTimeout(exit, 15_000);
    await exited;
    clearTimeout(deadline);
    assert.equal(proc.exitCode, 0, `${scenario}: app did not exit cleanly`);
    await sleep(500);
    assert.deepEqual(tracked.filter(alive), [], `${scenario}: child processes remain`);
    console.log(`${scenario}: process exited 0, no remaining children`);
  } finally {
    // Cleanup is only a fallback, never the success criterion.
    if (proc?.exitCode === null) await app.close().catch(() => {});
    for (const pid of tracked.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

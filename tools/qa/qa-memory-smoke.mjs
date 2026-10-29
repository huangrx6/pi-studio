/**
 * Cold-start memory smoke test for the real Electron process tree.
 *
 * The app uses a temporary user-data directory so this script never reads or
 * mutates the user's Studio sessions, credentials, or preferences. Run it on a
 * macOS host while no other copy of the same development Electron bundle is
 * active.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('The Pi Studio desktop memory smoke test currently requires macOS.');
}

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const profile = mkdtempSync(path.join(os.tmpdir(), 'pi-studio-memory-smoke-'));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(
  process.execPath,
  ['tools/launch.mjs', `--user-data-dir=${profile}`],
  {
    cwd: root,
    env: environment,
    stdio: 'ignore',
  },
);
let lastTrackedPids = [];

function processRows() {
  const rows = new Map();
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8',
  });
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.set(Number(match[1]), {
      parent: Number(match[2]),
      rssKiB: Number(match[3]),
      command: match[4],
    });
  }
  return rows;
}

function descendants(rootPid) {
  const rows = processRows();
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, row] of rows) {
      if (selected.has(pid) || !selected.has(row.parent)) continue;
      selected.add(pid);
      changed = true;
    }
  }
  return {
    rows,
    pids: [...selected].filter((pid) => rows.has(pid)),
  };
}

function sample(label) {
  const { rows, pids } = descendants(child.pid);
  lastTrackedPids = [...new Set([...lastTrackedPids, ...pids])];
  const totalKiB = pids.reduce((total, pid) => total + rows.get(pid).rssKiB, 0);
  const electronKiB = pids.reduce((total, pid) => {
    const command = rows.get(pid).command;
    return total + (
      /Electron|Pi Studio/.test(command) ? rows.get(pid).rssKiB : 0
    );
  }, 0);
  const result = {
    processes: pids.length,
    totalMiB: totalKiB / 1024,
    electronMiB: electronKiB / 1024,
  };
  console.log(
    `${label}: processes=${result.processes} total=${result.totalMiB.toFixed(1)} MiB `
    + `electron=${result.electronMiB.toFixed(1)} MiB`,
  );
  return { ...result, pids };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopProcessTree() {
  const trackedPids = [...new Set([
    ...lastTrackedPids,
    ...descendants(child.pid).pids,
  ])];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of trackedPids.toReversed()) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await sleep(signal === 'SIGTERM' ? 1_000 : 250);
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(1_000),
  ]);
}

try {
  await sleep(6_000);
  sample('cold-start');
  await sleep(8_000);
  sample('idle-14s');
  await sleep(12_000);
  const finalSample = sample('idle-26s');
  if (child.exitCode !== null) {
    throw new Error(`Pi Studio exited before the memory sample completed (${child.exitCode}).`);
  }
  if (finalSample.totalMiB >= 1024) {
    throw new Error(
      `Idle Electron process tree reached ${finalSample.totalMiB.toFixed(1)} MiB `
      + 'at 26 seconds; investigate retained transcripts, workers, or renderer state.',
    );
  }
  console.log('Memory smoke passed: the isolated idle process tree stayed below 1 GiB.');
} finally {
  await stopProcessTree();
  rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 200,
  });
}

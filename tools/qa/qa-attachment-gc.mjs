/**
 * Real Electron startup coverage for managed attachment garbage collection.
 * Uses a temporary Studio profile and never contacts a model or provider.
 */
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'attachment-gc');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-attachment-gc-qa-'));
const outside = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-attachment-gc-outside-'));
const attachmentRoot = path.join(profile, 'attachments');
const databasePath = path.join(profile, 'studio.sqlite');
await mkdir(output, { recursive: true });

for (const name of ['active-public-id', '1', 'draft', 'orphan-a', 'orphan-b']) {
  await mkdir(path.join(attachmentRoot, name), { recursive: true });
  await writeFile(path.join(attachmentRoot, name, 'note.txt'), name);
}
await writeFile(path.join(attachmentRoot, 'keep.txt'), 'ordinary files are never collected');
await mkdir(path.join(attachmentRoot, 'name.with.dot'));
await writeFile(path.join(attachmentRoot, 'name.with.dot', 'keep.txt'), 'unmanaged naming stays');
await mkdir(path.join(outside, 'outside-session'));
await writeFile(path.join(outside, 'outside-session', 'keep.txt'), 'outside remains');
await symlink(outside, path.join(attachmentRoot, 'orphan-link'), 'dir');

const db = createStudioDatabase(databasePath);
db.insertConversation({
  id: '1',
  publicId: 'active-public-id',
  workspace: root,
  kind: 'conversation',
  title: '附件 GC QA',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
db.close();

const env = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: databasePath,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

const result = { pageErrors: [], removed: [], retained: [], checks: [] };
let app;
let page;
try {
  app = await _electron.launch({
    args: [
      root,
      '--disable-background-networking',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>',
    ],
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  await page.locator('.new-conversation-welcome').waitFor();

  for (const name of ['orphan-a', 'orphan-b']) {
    await assert.rejects(lstat(path.join(attachmentRoot, name)), { code: 'ENOENT' });
    result.removed.push(name);
  }
  for (const name of ['active-public-id', '1', 'draft']) {
    assert.equal(await readFile(path.join(attachmentRoot, name, 'note.txt'), 'utf8'), name);
    result.retained.push(name);
  }
  assert.equal(
    await readFile(path.join(attachmentRoot, 'keep.txt'), 'utf8'),
    'ordinary files are never collected',
  );
  assert.equal(
    await readFile(path.join(attachmentRoot, 'name.with.dot', 'keep.txt'), 'utf8'),
    'unmanaged naming stays',
  );
  assert.equal((await lstat(path.join(attachmentRoot, 'orphan-link'))).isSymbolicLink(), true);
  assert.equal(
    await readFile(path.join(outside, 'outside-session', 'keep.txt'), 'utf8'),
    'outside remains',
  );
  result.checks.push(
    'startup removed inactive managed session directories',
    'active, draft, ordinary files, unmanaged names, and symlink targets were retained',
  );
  assert.deepEqual(result.pageErrors, []);
  await page.screenshot({
    path: path.join(output, 'startup.png'),
    animations: 'disabled',
  });
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(`Attachment GC QA passed: removed ${result.removed.length} orphan directories; evidence: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  result.failure = error instanceof Error ? error.message : String(error);
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  throw error;
} finally {
  try { if (app) await app.close(); } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

/**
 * Real Electron startup coverage for managed attachment garbage collection.
 * Uses a temporary Studio profile and never contacts a model or provider.
 */
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const { createStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa', 'attachment-gc');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-attachment-gc-qa-'));
const outside = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-attachment-gc-outside-'));
const attachmentRoot = path.join(profile, 'data', 'attachments');
const databasePath = path.join(profile, 'studio.sqlite');
await mkdir(output, { recursive: true });

for (const name of ['active-public-id', '1', '2', 'draft', 'projects', 'orphan-a', 'orphan-b']) {
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
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kKp8AAAAASUVORK5CYII=';
const storage = await openNodeSqliteStorage(databasePath, { prefix: 'durable_' });
try {
  const { stored } = await storage.commit([[
    { type: 'conversation', value: { id: 1 } },
    { type: 'conversation', value: { id: 2, owner: { conversationId: 1, taskId: 4 } } },
    { type: 'entry', value: { id: 3, conversationId: 2, kind: 'studio.user',
      data: { imageNames: ['pixel.png'] }, model: [{ role: 'user', timestamp: Date.now(),
        content: [{ type: 'image', mimeType: 'image/png', data: pixel }] }] } },
  ]], () => {}, BACKGROUND_CONTEXT);
  assert.equal(stored, 1);
} finally { await storage.close(BACKGROUND_CONTEXT); }

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
  for (const name of ['active-public-id', '1', '2', 'draft', 'projects']) {
    assert.equal(await readFile(path.join(attachmentRoot, name, 'note.txt'), 'utf8'), name);
    result.retained.push(name);
  }
  const projects = path.join(attachmentRoot, 'projects');
  const manifestSuffix = path.join('sessions', 'active-public-id', 'agents', '2', 'inputs', '3', 'manifest.json');
  let manifest;
  const deadline = Date.now() + 15_000;
  while (!manifest && Date.now() < deadline) {
    manifest = (await readdir(projects, { recursive: true })).find(name => name.endsWith(manifestSuffix));
    if (!manifest) await delay(100);
  }
  assert.ok(manifest, 'startup must backfill the child image from the previous session');
  const childDir = path.join(projects, manifest.split(path.sep)[0], 'sessions', 'active-public-id', 'agents', '2');
  const { files } = JSON.parse(await readFile(path.join(projects, manifest), 'utf8'));
  assert.equal(files[0].name, 'pixel.png');
  assert.deepEqual(await readFile(path.join(childDir, files[0].file)), Buffer.from(pixel, 'base64'));
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
    'the historical child image was archived and its legacy attachment directory survived startup',
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

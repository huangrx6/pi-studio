import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activate } from '../../extensions/pi-project-scripts/extension.mjs';

test('project scripts follow the current workspace, honor packageManager and copy commands without executing or exposing scripts', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'studio-script-example-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const sources = activate().dataSources;
  assert.match((await sources.scripts.read({ cwd }))[0].text, /没有 package.json/);
  const manifest = { scripts: { dev: 'SECRET_INLINE_VALUE', 'test:ui': 'test', 'build docs': 'build', 'unsafe;command': 'x' } };
  const filename = path.join(cwd, 'package.json');
  await writeFile(filename, JSON.stringify(manifest));
  await writeFile(path.join(cwd, 'pnpm-lock.yaml'), '');
  assert.equal((await sources.summary.read({ cwd }))[0].text, 'pnpm · 3 个脚本');
  await writeFile(filename, JSON.stringify({ ...manifest, packageManager: 'yarn@4.0.0' }));
  const blocks = await sources.scripts.read({ cwd });
  assert.equal(blocks[0].buttons[0].action.kind, 'copyText'); assert.equal(blocks[0].buttons[0].action.text, 'yarn run dev');
  assert.equal(blocks[1].rows.find(row => row.script === 'build docs').run, "yarn run 'build docs'");
  assert.doesNotMatch(JSON.stringify(blocks), /SECRET_INLINE_VALUE|unsafe;command/);
  await writeFile(filename, '{'); assert.match((await sources.scripts.read({ cwd }))[0].text, /无法读取/);
  await rm(filename); await symlink(path.join(cwd, 'pnpm-lock.yaml'), filename);
  assert.match((await sources.summary.read({ cwd }))[0].text, /无法读取/);
});

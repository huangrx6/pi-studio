import { openToolPanel } from './fixtures/tool-panel.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';
import YAML from 'yaml';

// Run against the executable installed by NSIS, including its native terminal and updater files.
assert.equal(process.platform, 'win32');
const executable = path.resolve(process.argv[2]);
const resources = path.join(path.dirname(executable), 'resources');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const installer = `Pi-Studio-${version}-Windows-x64-Setup.exe`;
const metadata = YAML.parse(fs.readFileSync('release/latest.yml', 'utf8'));
const identity = JSON.parse(fs.readFileSync(path.join(resources, 'pi-studio-build.json'), 'utf8'));
assert.equal(identity.version, version);
assert.equal(identity.commit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 12));
assert.match(identity.buildId, /^[a-f0-9]{16}$/);
assert.equal(metadata.version, version);
assert.equal(metadata.buildId, identity.buildId);
assert.equal(metadata.path, installer);
const artifact = metadata.files.find(file => file.url === installer);
assert.ok(artifact, 'The Windows update feed must point to the installer');
const hash = createHash('sha512');
for await (const chunk of fs.createReadStream(path.join('release', installer))) hash.update(chunk);
assert.equal(hash.digest('base64'), artifact.sha512);
assert.ok(fs.statSync(path.join('release', installer + '.blockmap')).size > 0);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-windows-qa-'));
let app;
try {
  app = await _electron.launch({
    executablePath: executable,
    args: ['--disable-background-networking', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
    env: { ...process.env, PI_STUDIO_USER_DATA: profile },
    timeout: 60_000,
  });
  const installed = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged, version: app.getVersion(), path: app.getAppPath(),
  }));
  assert.equal(installed.packaged, true);
  assert.equal(installed.version, version);
  assert.equal(path.resolve(installed.path), path.join(resources, 'app.asar'));
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.locator('html[data-platform="win32"] .app').waitFor({ timeout: 60_000 });
  const state = await page.evaluate(() => window.piApi.state());
  assert.ok(Array.isArray(state.workspaces), 'The installed renderer must load Studio state');

  const tools = await openToolPanel(app, page, () => page.evaluate(async cwd => {
    await window.piApi.setToolWindowContext({key:'studio', title:'安装包验证', cwd});
    await window.piApi.openToolWindow({kind:'terminal'});
  }, profile));
  await tools.locator('.terminal-panel').waitFor();
  await tools.evaluate(async cwd => {
    const state = await window.toolWindowApi.state();
    const id = state.groups.find(group => group.context.key === state.key).active;
    window.__windowsPtyOutput = '';
    window.piApi.onTerminalEvent(event => {
      if (event.id === id && event.type === 'data') window.__windowsPtyOutput += event.data;
    });
    await window.piApi.terminalCreate({ id, cwd, cols: 96, rows: 24 });
    await window.piApi.terminalWrite(id, 'echo PI_STUDIO_%PI_STUDIO_TERMINAL%_OK\r');
  }, profile);
  await tools.waitForFunction(() => window.__windowsPtyOutput.includes('PI_STUDIO_1_OK'), undefined, { timeout: 30_000 });
  await tools.evaluate(async () => {
    const state = await window.toolWindowApi.state();
    await window.toolWindowApi.command(state.key, {kind:'close', id:state.groups.find(group => group.context.key === state.key).active});
  });
  console.log(`Windows x64 v${version}: installed app, renderer, terminal, and update files verified`);
} finally {
  try {
    await app?.close();
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

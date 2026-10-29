const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cli = path.resolve(__dirname, '../../tools/cli/pi-studio-extension.mjs');

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('publish dry-run is non-mutating and dirty repositories fail before artifacts are written', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '.gitignore'), 'release/\n');
  fs.writeFileSync(
    path.join(directory, 'pi-studio.extension.json'),
    `${JSON.stringify({
      format: 1,
      id: 'cli.fixture',
      name: 'CLI fixture',
      version: '1.0.0',
      description: 'Distribution CLI test',
      publisher: 'huangrx6',
      author: 'huangrx6',
      license: 'MIT',
      repository: 'https://github.com/huangrx6/cli-fixture',
      engines: { piStudio: '>=0.0.3 <0.1.0' },
      permissions: [],
      contributes: {},
    }, null, 2)}\n`,
  );
  git(['init'], directory);
  git(['config', 'user.email', 'pi-studio-test@example.com'], directory);
  git(['config', 'user.name', 'Pi Studio Test'], directory);
  git(['add', '.'], directory);
  git(['commit', '-m', 'fixture'], directory);

  const dryRun = run(['publish', '.', '--dry-run', '--json'], directory);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).dryRun, true);
  assert.equal(fs.existsSync(path.join(directory, 'release')), false);

  fs.writeFileSync(path.join(directory, 'dirty.txt'), 'uncommitted\n');
  const dirty = run(['publish', '.', '--json'], directory);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /工作区有未提交改动/);
  assert.equal(fs.existsSync(path.join(directory, 'release')), false);
});

test('init creates complete UI and Agent authoring templates', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-init-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const uiDirectory = path.join(directory, 'ui-extension');
  const ui = JSON.parse(run([
    'init',
    uiDirectory,
    '--template',
    'ui',
    '--id',
    'fixture.ui-template',
    '--name',
    'UI Template',
    '--publisher',
    'fixture-publisher',
    '--json',
  ], directory).stdout);
  assert.equal(ui.template, 'ui');
  assert.equal(fs.existsSync(path.join(uiDirectory, 'extension.mjs')), false);
  assert.equal(
    JSON.parse(run(['validate', uiDirectory, '--json'], directory).stdout).valid,
    true,
  );

  const agentDirectory = path.join(directory, 'agent-extension');
  const agent = JSON.parse(run([
    'init',
    agentDirectory,
    '--template',
    'agent',
    '--id',
    'fixture.agent-template',
    '--name',
    'Agent Template',
    '--publisher',
    'fixture-publisher',
    '--json',
  ], directory).stdout);
  assert.equal(agent.template, 'agent');
  assert.match(
    fs.readFileSync(path.join(agentDirectory, 'extension.mjs'), 'utf8'),
    /defineTool[\s\S]*activate[\s\S]*cleanup/,
  );
  assert.equal(
    JSON.parse(run(['validate', agentDirectory, '--json'], directory).stdout).valid,
    true,
  );
});

test('scope is validated consistently across authoring commands', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-scope-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const extension = path.join(directory, 'extension');
  assert.equal(run([
    'init',
    extension,
    '--id',
    'fixture.scope-template',
    '--name',
    'Scope Template',
    '--publisher',
    'fixture-publisher',
  ], directory).status, 0);

  for (const command of [
    ['validate', extension, '--scope', 'workspace'],
    ['seal', extension, '--scope', 'workspace'],
    ['pack', extension, '--scope', 'workspace'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...command], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--scope 只能是 user 或 project/);
  }
});

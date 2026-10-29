const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'tools/cli/pi-studio-extension.mjs');

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('keygen, sign, and verify establish an explicitly trusted publisher identity', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-signing-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const extension = path.join(directory, 'extension');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'pi-studio.extension.json'), `${JSON.stringify({
    format: 1,
    id: 'cli.signed-extension',
    name: 'Signed CLI extension',
    version: '1.0.0',
    description: 'Extension signing CLI test.',
    publisher: 'cli-publisher',
    author: 'cli-publisher',
    license: 'MIT',
    engines: { piStudio: '>=0.0.3 <0.1.0' },
    permissions: [],
    contributes: {},
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(extension, 'README.md'), '# Signed extension\n');

  const keys = path.join(directory, 'keys');
  const keygen = JSON.parse(run(['keygen', '--out', keys, '--json'], directory).stdout);
  assert.match(keygen.keyId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(keygen.privateKey), true);
  assert.equal(fs.existsSync(keygen.publicKey), true);

  const signed = JSON.parse(run([
    'sign',
    extension,
    '--private-key',
    keygen.privateKey,
    '--json',
  ], directory).stdout);
  assert.equal(signed.keyId, keygen.keyId);
  assert.equal(fs.existsSync(path.join(extension, 'signature.json')), true);

  const valid = JSON.parse(run(['verify', extension, '--json'], directory).stdout);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.identityTrusted, false);

  const trusted = JSON.parse(run([
    'verify',
    extension,
    '--public-key',
    keygen.publicKey,
    '--publisher',
    'cli-publisher',
    '--json',
  ], directory).stdout);
  assert.equal(trusted.status, 'trusted');
  assert.equal(trusted.identityTrusted, true);
});

test('signing refuses to read a private key from inside publishable extension content', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-signing-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const extension = path.join(directory, 'extension');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'pi-studio.extension.json'), `${JSON.stringify({
    format: 1,
    id: 'cli.private-key-guard',
    name: 'Private key guard',
    version: '1.0.0',
    description: 'Reject private keys inside extension.',
    publisher: 'cli-publisher',
    license: 'MIT',
    permissions: [],
    contributes: {},
  }, null, 2)}\n`);
  const privateKey = path.join(extension, 'publisher-private.pem');
  fs.writeFileSync(privateKey, 'not-a-real-key');

  const result = spawnSync(process.execPath, [
    cli,
    'sign',
    extension,
    '--private-key',
    privateKey,
  ], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /私钥不能位于扩展目录内/);
});

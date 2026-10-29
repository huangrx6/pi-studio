const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readSignature,
  signExtensionDirectory,
  verifyExtensionDirectory,
} = require('../../electron/core/extension-signature.cjs');
const {
  walkPackageFiles,
} = require('../../electron/core/extension-package.cjs');

function extensionFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-signature-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'pi-studio.extension.json'), `${JSON.stringify({
    format: 1,
    id: 'test.signed-extension',
    name: 'Signed extension',
    version: '1.2.3',
    description: 'Ed25519 package signature fixture.',
    author: 'Test Publisher',
    publisher: 'test-publisher',
    license: 'MIT',
    engines: { piStudio: '>=0.0.3 <0.1.0' },
    permissions: [],
    contributes: {},
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'extension.mjs'), 'export const value = 1;\n');
  return directory;
}

test('Ed25519 signatures bind extension identity, publisher, and exact signed content', (t) => {
  const directory = extensionFixture(t);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signed = signExtensionDirectory(directory, { privateKey });

  assert.equal(signed.signature.publisher, 'test-publisher');
  assert.match(signed.signature.keyId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(readSignature(directory).signature, signed.signature.signature);

  const valid = verifyExtensionDirectory(directory);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.verification.identityTrusted, false);

  const trusted = verifyExtensionDirectory(directory, {
    expectedPublicKey: publicKey,
    expectedPublisher: 'test-publisher',
  });
  assert.equal(trusted.status, 'trusted');
  assert.equal(trusted.verification.identityTrusted, true);

  fs.writeFileSync(path.join(directory, 'extension.mjs'), 'export const value = 2;\n');
  assert.throws(
    () => verifyExtensionDirectory(directory, { expectedPublicKey: publicKey }),
    /tree SHA-256/,
  );
});

test('a different trusted publisher key is rejected even when the embedded signature is valid', (t) => {
  const directory = extensionFixture(t);
  const signer = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  signExtensionDirectory(directory, { privateKey: signer.privateKey });

  assert.throws(
    () => verifyExtensionDirectory(directory, { expectedPublicKey: other.publicKey }),
    /受信任发布者公钥不一致/,
  );
});

test('identity fields in signature.json cannot be reassigned without invalidating the signature', (t) => {
  const directory = extensionFixture(t);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  signExtensionDirectory(directory, { privateKey });
  const file = path.join(directory, 'signature.json');
  const signature = JSON.parse(fs.readFileSync(file, 'utf8'));
  signature.publisher = 'someone-else';
  fs.writeFileSync(file, `${JSON.stringify(signature, null, 2)}\n`);

  assert.throws(
    () => verifyExtensionDirectory(directory),
    /发布者与 manifest publisher 不一致/,
  );
});

test('publishable extension content rejects private keys and credential files', (t) => {
  const directory = extensionFixture(t);
  fs.writeFileSync(path.join(directory, 'publisher-private.pem'), 'secret');
  assert.throws(
    () => walkPackageFiles(directory),
    /凭据或签名私钥/,
  );

  fs.rmSync(path.join(directory, 'publisher-private.pem'));
  fs.writeFileSync(
    path.join(directory, 'debug.txt'),
    '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
  );
  assert.throws(
    () => walkPackageFiles(directory),
    /PEM 私钥/,
  );
});

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ExtensionTrustStore,
  TRUST_STORE_NAME,
} = require('../../electron/core/extension-trust.cjs');
const {
  publicKeyFingerprint,
} = require('../../electron/core/extension-signature.cjs');

function storeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-trust-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    store: new ExtensionTrustStore({
      userDataPath: directory,
      now: () => 1_700_000_000_000,
    }),
  };
}

test('publisher keys are pinned by fingerprint and persisted with private file permissions', (t) => {
  const { directory, store } = storeFixture(t);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const trusted = store.trust({
    publisher: 'HuangRX6',
    publicKey,
    source: 'registry:test',
  });

  assert.equal(trusted.keyId, publicKeyFingerprint(publicKey));
  assert.equal(store.assertAllowed('huangrx6', trusted.keyId).status, 'trusted');
  assert.equal(store.lookup('HUANGrx6', trusted.keyId).publisher ?? undefined, undefined);
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, TRUST_STORE_NAME), 'utf8'));
  assert.equal(persisted.publishers[0].publisher, 'HuangRX6');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(directory, TRUST_STORE_NAME)).mode & 0o777, 0o600);
  }
});

test('a revoked publisher key cannot be silently re-trusted', (t) => {
  const { store } = storeFixture(t);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const key = store.trust({ publisher: 'publisher', publicKey });
  store.revoke({ publisher: 'publisher', keyId: key.keyId });

  assert.throws(
    () => store.assertAllowed('publisher', key.keyId),
    /已被撤销/,
  );
  assert.throws(
    () => store.trust({ publisher: 'publisher', publicKey }),
    /不能重新信任已撤销/,
  );
});

test('different publisher keys can coexist while a wrong key id is rejected', (t) => {
  const { store } = storeFixture(t);
  const first = crypto.generateKeyPairSync('ed25519').publicKey;
  const second = crypto.generateKeyPairSync('ed25519').publicKey;
  store.trust({ publisher: 'publisher', publicKey: first });
  store.trust({ publisher: 'publisher', publicKey: second });
  assert.equal(store.list().publishers[0].keys.length, 2);
  assert.throws(
    () => store.trust({
      publisher: 'publisher',
      publicKey: second,
      keyId: publicKeyFingerprint(first),
    }),
    /keyId 不一致/,
  );
});

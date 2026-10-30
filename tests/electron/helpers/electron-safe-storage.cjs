const Module = require('node:module');

function installElectronSafeStorage(t) {
  const originalLoad = Module._load;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`test-sealed:${value}`, 'utf8'),
    decryptString(value) {
      const decoded = Buffer.from(value).toString('utf8');
      if (!decoded.startsWith('test-sealed:')) throw new Error('Invalid test ciphertext');
      return decoded.slice('test-sealed:'.length);
    },
  };
  Module._load = function loadWithSafeStorage(request, parent, isMain) {
    if (request === 'electron') return { safeStorage };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
  });
  return safeStorage;
}

module.exports = { installElectronSafeStorage };

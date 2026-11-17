const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Each test worker, including its child processes, starts with a disposable Studio profile.
if (process.env.NODE_TEST_CONTEXT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-test-profile-'));
  process.env.PI_STUDIO_USER_DATA = root;
  delete process.env.PI_STUDIO_DB;
  process.once('exit', () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows can retain open handles at exit. */ }
  });
}

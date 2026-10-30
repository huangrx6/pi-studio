const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function loadAttachments(userData) {
  const filename = path.join(__dirname, '../../electron/services/attachments.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    process,
    Buffer,
    require: (name) => {
      if (name === 'electron') {
        return {
          app: { getPath: () => userData },
          BrowserWindow: { getFocusedWindow: () => undefined },
          dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        };
      }
      return nativeRequire(name);
    },
  }, { filename });
  return module.exports;
}

test('managed attachment previews stay inside the Studio attachment root', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachments-'));
  const root = path.join(userData, 'attachments');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'session-a'), { recursive: true });
    const allowed = path.join(root, 'session-a', 'notes.txt');
    const privateFile = path.join(outside, 'private.txt');
    const escapedLink = path.join(root, 'session-a', 'escaped.txt');
    fs.writeFileSync(allowed, 'managed attachment\n');
    fs.writeFileSync(privateFile, 'private\n');
    fs.symlinkSync(privateFile, escapedLink);

    const api = loadAttachments(userData);
    assert.equal(api.resolveAttachmentFile(allowed), fs.realpathSync(allowed));
    assert.equal(api.readAttachmentFile({ path: allowed }).text, 'managed attachment\n');
    assert.throws(
      () => api.resolveAttachmentFile(privateFile),
      /不在 Studio 附件目录中/,
    );
    assert.throws(
      () => api.resolveAttachmentFile(escapedLink),
      /不在 Studio 附件目录中/,
    );
    assert.throws(
      () => api.resolveAttachmentFile('session-a/notes.txt'),
      /需要附件绝对路径/,
    );
    assert.throws(
      () => api.resolveAttachmentFile(path.join(root, 'session-a')),
      /不是附件文件/,
    );
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

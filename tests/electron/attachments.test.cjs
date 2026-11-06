const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function loadAttachments(userData, { randomUUID, now } = {}) {
  const filename = path.join(__dirname, '../../electron/services/attachments.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const nativeRequire = createRequire(filename);
  const NativeDate = Date;
  class FixedDate extends NativeDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : now === undefined ? [] : [now]));
    }

    static now() {
      return now === undefined ? NativeDate.now() : now;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    process,
    Buffer,
    Date: now === undefined ? NativeDate : FixedDate,
    require: (name) => {
      if (name === 'electron') {
        return {
          app: { getPath: () => userData },
          BrowserWindow: { getFocusedWindow: () => undefined },
          dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        };
      }
      if (name === 'node:crypto' && randomUUID) {
        return { randomUUID };
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

test('same-name attachment writes are exclusive, unique and private', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-exclusive-'));
  const root = path.join(userData, 'attachments');
  const ids = ['first-id', 'second-id'];
  try {
    const api = loadAttachments(userData, {
      now: Date.UTC(2026, 0, 1, 0, 0, 0, 123),
      randomUUID: () => ids.shift(),
    });
    const payload = {
      sessionId: 'session-a',
      name: 'same-name.txt',
      mime: 'text/plain',
    };
    const first = await api.saveUpload({ ...payload, data: Buffer.from('first').toString('base64') });
    const second = await api.saveUpload({ ...payload, data: Buffer.from('second').toString('base64') });

    assert.notEqual(first.path, second.path);
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'first');
    assert.equal(fs.readFileSync(second.path, 'utf8'), 'second');
    assert.equal(path.dirname(first.path), fs.realpathSync(path.join(root, 'session-a')));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
      assert.equal(fs.statSync(second.path).mode & 0o777, 0o600);
    }

    const fixed = loadAttachments(userData, { randomUUID: () => 'fixed-id' });
    const existingName = path.join(root, 'session-a', 'fixed-id-collision.txt');
    fs.writeFileSync(existingName, 'keep me');
    await assert.rejects(
      fixed.saveUpload({
        ...payload,
        name: 'collision.txt',
        data: Buffer.from('replace?').toString('base64'),
      }),
      (error) => error?.code === 'EEXIST',
    );
    assert.equal(fs.readFileSync(existingName, 'utf8'), 'keep me');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('attachment writes reject symlinked root and session directories without touching targets', async () => {
  const rootUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-root-link-'));
  const sessionUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-session-link-'));
  const fileRootUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-root-file-'));
  const fileSessionUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-session-file-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-outside-'));
  const payload = {
    sessionId: 'session-a',
    name: 'private.txt',
    mime: 'text/plain',
    data: Buffer.from('private').toString('base64'),
  };
  try {
    fs.symlinkSync(outside, path.join(rootUserData, 'attachments'), 'dir');
    const rootApi = loadAttachments(rootUserData);
    await assert.rejects(rootApi.saveUpload(payload), /附件根目录/);
    assert.deepEqual(fs.readdirSync(outside), []);

    const sessionRoot = path.join(sessionUserData, 'attachments');
    fs.mkdirSync(sessionRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(sessionRoot, 'session-a'), 'dir');
    const sessionApi = loadAttachments(sessionUserData);
    await assert.rejects(sessionApi.saveUpload(payload), /会话附件目录/);
    assert.deepEqual(fs.readdirSync(outside), []);

    const rootFile = path.join(fileRootUserData, 'attachments');
    fs.writeFileSync(rootFile, 'keep root file');
    const fileRootApi = loadAttachments(fileRootUserData);
    await assert.rejects(fileRootApi.saveUpload(payload), /附件根目录/);
    assert.equal(fs.readFileSync(rootFile, 'utf8'), 'keep root file');

    const fileSessionRoot = path.join(fileSessionUserData, 'attachments');
    fs.mkdirSync(fileSessionRoot);
    const sessionFile = path.join(fileSessionRoot, 'session-a');
    fs.writeFileSync(sessionFile, 'keep session file');
    const fileSessionApi = loadAttachments(fileSessionUserData);
    await assert.rejects(fileSessionApi.saveUpload(payload), /会话附件目录/);
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), 'keep session file');
  } finally {
    fs.rmSync(rootUserData, { recursive: true, force: true });
    fs.rmSync(sessionUserData, { recursive: true, force: true });
    fs.rmSync(fileRootUserData, { recursive: true, force: true });
    fs.rmSync(fileSessionUserData, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('attachment cleanup removes one managed session and refuses links or files', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-cleanup-'));
  const linkedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-root-link-cleanup-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-cleanup-outside-'));
  const root = path.join(userData, 'attachments');
  try {
    fs.mkdirSync(path.join(root, 'session-a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'session-b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'session-a', 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'session-b', 'b.txt'), 'b');
    fs.writeFileSync(path.join(root, 'plain-file'), 'keep');
    const outsideFile = path.join(outside, 'keep.txt');
    fs.writeFileSync(outsideFile, 'outside');
    fs.mkdirSync(path.join(outside, 'session-a'));
    fs.writeFileSync(path.join(outside, 'session-a', 'keep.txt'), 'outside session');
    fs.symlinkSync(outside, path.join(root, 'session-link'), 'dir');
    fs.symlinkSync(outside, path.join(root, 'session-a', 'outside-link'), 'dir');

    const api = loadAttachments(userData);
    assert.equal(api.removeAttachmentDirectory('session-a'), true);
    assert.equal(fs.existsSync(path.join(root, 'session-a')), false);
    assert.equal(fs.existsSync(path.join(root, 'session-b', 'b.txt')), true);
    assert.equal(api.removeAttachmentDirectory('plain-file'), false);
    assert.equal(fs.readFileSync(path.join(root, 'plain-file'), 'utf8'), 'keep');
    assert.equal(api.removeAttachmentDirectory('session-link'), false);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside');
    assert.equal(fs.readFileSync(path.join(outside, 'session-a', 'keep.txt'), 'utf8'), 'outside session');
    assert.equal(api.removeAttachmentDirectory('../outside'), false);

    fs.symlinkSync(outside, path.join(linkedUserData, 'attachments'), 'dir');
    const linkedApi = loadAttachments(linkedUserData);
    assert.equal(linkedApi.removeAttachmentDirectory('session-a'), false);
    assert.equal(fs.readFileSync(path.join(outside, 'session-a', 'keep.txt'), 'utf8'), 'outside session');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(linkedUserData, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('startup cleanup removes only inactive managed session directories', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-gc-'));
  const linkedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-gc-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-attachment-gc-outside-'));
  const root = path.join(userData, 'attachments');
  try {
    for (const name of ['active-public', '123', 'draft', 'orphan-a', 'orphan-b']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'note.txt'), name);
    }
    fs.writeFileSync(path.join(root, 'unmanaged-file.txt'), 'keep');
    fs.mkdirSync(path.join(root, 'name.with.dot'));
    fs.writeFileSync(path.join(root, 'name.with.dot', 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(outside, 'outside-session'));
    fs.writeFileSync(path.join(outside, 'outside-session', 'keep.txt'), 'outside');
    fs.symlinkSync(outside, path.join(root, 'orphan-link'));
    fs.symlinkSync(outside, path.join(linkedUserData, 'attachments'), 'dir');

    const api = loadAttachments(userData);
    const cleanup = api.cleanupOrphanedAttachmentDirectories(['active-public', '123']);
    assert.equal(cleanup.removed, 2);
    assert.equal(cleanup.failed, 0);
    assert.equal(fs.existsSync(path.join(root, 'active-public', 'note.txt')), true);
    assert.equal(fs.existsSync(path.join(root, '123', 'note.txt')), true);
    assert.equal(fs.existsSync(path.join(root, 'draft', 'note.txt')), true);
    assert.equal(fs.existsSync(path.join(root, 'orphan-a')), false);
    assert.equal(fs.existsSync(path.join(root, 'orphan-b')), false);
    assert.equal(fs.readFileSync(path.join(root, 'unmanaged-file.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(root, 'name.with.dot', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.lstatSync(path.join(root, 'orphan-link')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(outside, 'outside-session', 'keep.txt'), 'utf8'), 'outside');
    const linkedApi = loadAttachments(linkedUserData);
    assert.throws(
      () => linkedApi.cleanupOrphanedAttachmentDirectories([]),
      /附件根目录/,
    );
    assert.equal(fs.readFileSync(path.join(outside, 'outside-session', 'keep.txt'), 'utf8'), 'outside');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(linkedUserData, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

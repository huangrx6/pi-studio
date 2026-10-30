const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadResolver() {
  const calls = [];
  const source = fs.readFileSync(
    path.join(__dirname, '../../electron/ipc/files.cjs'),
    'utf8',
  );
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    process,
    Buffer,
    require: (name) => {
      if (name === 'electron') {
        return {
          app: { getFileIcon: async () => ({ toDataURL: () => '' }) },
          BrowserWindow: class {},
          dialog: {},
          ipcMain: { handle: () => {} },
          shell: {},
        };
      }
      if (name === '../core/studio-db.cjs') {
        return { getStudioDatabase: () => ({ upsertWorkspace: () => {} }) };
      }
      if (name === '../core/state.cjs') return { getWindow: () => undefined };
      if (name === '../services/workspace.cjs') {
        return {
          workspaceFile: (cwd, requested) => {
            calls.push({ source: 'workspace', cwd, requested });
            return '/resolved/workspace';
          },
          searchWorkspaceFiles: async () => ({ files: [] }),
          listDirectory: () => ({ entries: [] }),
          readFileText: () => ({ text: '' }),
        };
      }
      if (name === '../services/attachments.cjs') {
        return {
          resolveAttachmentFile: (requested) => {
            calls.push({ source: 'attachment', requested });
            return '/resolved/attachment';
          },
        };
      }
      if (name === '../services/turn-diff.cjs') {
        return {
          resolveTurnDiffAbsoluteFile: ({ sessionId, path: requested }) => {
            calls.push({ source: 'diff', sessionId, requested });
            return '/resolved/diff';
          },
        };
      }
      if (name === '../core/external-url.cjs') return { normalizeExternalHttpUrl: (url) => url };
      if (name === '../services/mac-apps.cjs') return {};
      return require(name);
    },
  }, { filename: path.join(__dirname, '../../electron/ipc/files.cjs') });
  return { resolveFileRequest: module.exports.resolveFileRequest, calls };
}

test('file operations route workspace, attachment, and turn-diff paths through their own guards', () => {
  const { resolveFileRequest, calls } = loadResolver();

  assert.equal(
    resolveFileRequest({ cwd: '/workspace', path: 'src/app.ts' }),
    '/resolved/workspace',
  );
  assert.equal(
    resolveFileRequest({ path: '/app/attachments/a.txt', source: 'attachment' }),
    '/resolved/attachment',
  );
  assert.equal(
    resolveFileRequest({
      path: '/workspace/changed.ts',
      source: 'diff',
      sessionId: 'session-a',
    }),
    '/resolved/diff',
  );
  assert.throws(
    () => resolveFileRequest({ path: '/tmp/file', source: 'guess' }),
    /文件来源无效/,
  );
  assert.deepEqual(calls, [
    { source: 'workspace', cwd: '/workspace', requested: 'src/app.ts' },
    { source: 'attachment', requested: '/app/attachments/a.txt' },
    {
      source: 'diff',
      sessionId: 'session-a',
      requested: '/workspace/changed.ts',
    },
  ]);
});

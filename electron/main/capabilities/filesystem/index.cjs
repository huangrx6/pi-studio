const manifests = require('./manifest.cjs');
const {
  createFilesystemTools,
  resolveWorkspacePath,
  walkFiles,
} = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-filesystem-tools', createFilesystemTools(durable)],
  ]);
}

module.exports = {
  create,
  createFilesystemTools,
  manifests,
  resolveWorkspacePath,
  walkFiles,
};

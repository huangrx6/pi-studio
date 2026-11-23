const manifests = require('./manifest.cjs');
const { createBrowserTools } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-browser-tools', createBrowserTools(durable)],
  ]);
}

module.exports = {
  create,
  createBrowserTools,
  manifests,
};

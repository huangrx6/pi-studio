const manifests = require('./manifest.cjs');
const { createWorkbenchTools } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-workbench-tools', createWorkbenchTools(durable)],
  ]);
}

module.exports = {
  create,
  createWorkbenchTools,
  manifests,
};

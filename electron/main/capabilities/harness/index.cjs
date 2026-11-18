const manifests = require('./manifest.cjs');
const {
  createStudioHarnessExtension,
  renderSection,
} = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-harness', createStudioHarnessExtension(durable)],
  ]);
}

module.exports = {
  ...require('./extension.cjs'),
  create,
  manifests,
  createStudioHarnessExtension,
  renderSection,
};

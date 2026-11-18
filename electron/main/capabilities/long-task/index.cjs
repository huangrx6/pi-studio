const manifests = require('./manifest.cjs');
const { createLongTaskExtension } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-long-task', createLongTaskExtension(durable)],
  ]);
}

module.exports = {
  ...require('./extension.cjs'),
  create,
  manifests,
};

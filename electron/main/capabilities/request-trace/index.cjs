const manifests = require('./manifest.cjs');
const { createStudioRequestTraceExtension } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-request-trace', createStudioRequestTraceExtension(durable)],
  ]);
}

module.exports = {
  ...require('./extension.cjs'),
  create,
  manifests,
};

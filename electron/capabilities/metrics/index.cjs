const manifests = require('./manifest.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-metrics', durable.defineExtension({ name: 'studio-metrics' })],
  ]);
}

module.exports = {
  ...require('./runtime.cjs'),
  create,
  manifests,
};

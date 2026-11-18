const manifests = require('./manifest.cjs');
const { createPermissionsExtension } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-permissions', createPermissionsExtension(durable)],
  ]);
}

module.exports = {
  ...require('./mode.cjs'),
  ...require('../../core/permission-policy.cjs'),
  create,
  createPermissionsExtension,
  manifests,
};

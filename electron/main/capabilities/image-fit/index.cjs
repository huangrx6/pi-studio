const manifests = require('./manifest.cjs');
const { createStudioImageFitExtension } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-image-fit', createStudioImageFitExtension(durable)],
  ]);
}

module.exports = {
  ...require('./fit.cjs'),
  ...require('./extension.cjs'),
  create,
  manifests,
};

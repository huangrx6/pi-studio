const manifests = require('./manifest.cjs');
const { createDesktopControlTools } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-desktop-control', createDesktopControlTools(durable)],
  ]);
}

module.exports = {
  create,
  createDesktopControlTools,
  manifests,
};

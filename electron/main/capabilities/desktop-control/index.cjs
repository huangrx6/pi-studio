const manifests = require('./manifest.cjs');
const { createDesktopControlTools } = require('./extension.cjs');

function create({ durable, observeDesktopRun }) {
  return new Map([
    ['builtin:studio-desktop-control', createDesktopControlTools(durable, observeDesktopRun)],
  ]);
}

module.exports = {
  create,
  createDesktopControlTools,
  manifests,
};

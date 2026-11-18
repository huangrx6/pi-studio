const manifests = require('./manifest.cjs');

function create({ toolSearch }) {
  if (!toolSearch) throw new Error('Durable tool_search 尚未提供');
  return new Map([['builtin:studio-tool-search', toolSearch]]);
}

module.exports = {
  create,
  manifests,
};

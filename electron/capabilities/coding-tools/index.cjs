const manifests = require('./manifest.cjs');

function create({ codingTools }) {
  if (!codingTools) throw new Error('Durable CodingTools 尚未提供');
  return new Map([['builtin:durable-coding-tools', codingTools]]);
}

module.exports = {
  create,
  manifests,
};

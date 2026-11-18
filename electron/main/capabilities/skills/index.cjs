const manifests = require('./manifest.cjs');
const { createStudioSkillsExtension } = require('./extension.cjs');

function create({ durable }) {
  return new Map([
    ['builtin:studio-skills', createStudioSkillsExtension(durable)],
  ]);
}

module.exports = {
  ...require('./instructions.cjs'),
  ...require('./sources.cjs'),
  create,
  createStudioSkillsExtension,
  manifests,
};

const manifests = require('./manifest.cjs');
const { createSubagentExtension } = require('./extension.cjs');

function create({ durable, piAi, chordContext }) {
  const { parentExtension, channel } = createSubagentExtension(
    durable,
    piAi,
    chordContext,
  );
  return new Map([
    ['builtin:studio-subagents', parentExtension],
    ['builtin:studio-subagent-channel', channel],
  ]);
}

module.exports = {
  ...require('./protocol.cjs'),
  ...require('./settings.cjs'),
  ...require('./transcripts.cjs'),
  ...require('./usage.cjs'),
  ...require('./worktrees.cjs'),
  create,
  createSubagentExtension,
  manifests,
};

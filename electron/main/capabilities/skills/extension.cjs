const { renderSection } = require('../harness/index.cjs');
const { skillInstructions } = require('./instructions.cjs');

function createStudioSkillsExtension(durable) {
  return durable.defineExtension({
    name: 'studio-skills',
    sections: [
      durable.section('studio-skills', (input) => {
        const cwd = input.rolePrompt?.workspace || input.env?.cwd || input.agent?.cwd;
        return renderSection(input, 'skills', () => (
          cwd ? skillInstructions(cwd, input.agent?.tools, input.rolePrompt?.skills) : undefined
        ));
      }),
    ],
  });
}

module.exports = {
  createStudioSkillsExtension,
};

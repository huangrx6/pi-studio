const { randomInt } = require('node:crypto');

// Each permanent ID names one illustration together with its original palette.
const avatarIds = ['fox-apricot', 'frog-pistachio', 'puffin-seafoam', 'koala-ice', 'owl-lavender', 'panda-rose'];

function legacyAvatar(conversationId) {
  // Unregistered children predate saved portraits. Keep this first-edition
  // mapping stable even when new artwork is appended to the catalog.
  return avatarIds[Number(conversationId) % 6];
}

function assignAvatar(agents, conversationId, chooseIndex = randomInt) {
  const counts = new Map(avatarIds.map(id => [id, 0]));
  for (const agent of Object.values(agents)) {
    const id = agent.avatarId || legacyAvatar(agent.conversationId);
    if (agent.conversationId === conversationId) return id;
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
  }
  const minimum = Math.min(...counts.values());
  const choices = avatarIds.filter(id => counts.get(id) === minimum);
  return choices[chooseIndex(choices.length)];
}

module.exports = { assignAvatar, legacyAvatar };

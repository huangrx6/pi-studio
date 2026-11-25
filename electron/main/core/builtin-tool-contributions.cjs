const descriptions = require('../../../assets/settings/builtin-tool-descriptions.zh-CN.json');

function builtinToolContributions(names) {
  return names.map(name => ({ name, description: descriptions[name] }));
}

module.exports = { builtinToolContributions };

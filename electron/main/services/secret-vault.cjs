const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  expandSecretReferences,
  isValidSecretName,
  redactSecretValues,
  secretReferences,
} = require('../core/secret-vault.cjs');

function listSecrets() {
  return getStudioDatabase().listSecretNames();
}

async function writeSecret({ name, value } = {}) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedValue = typeof value === 'string' ? value : '';
  if (!isValidSecretName(normalizedName)) {
    throw new Error('凭据名称必须以大写字母开头，只能包含大写字母、数字和下划线');
  }
  if (!normalizedValue || Buffer.byteLength(normalizedValue, 'utf8') > 64 * 1024) {
    throw new Error('凭据值不能为空，且不能超过 64KB');
  }
  return getStudioDatabase().writeSecretValueAsync(normalizedName, normalizedValue);
}

function removeSecret(name) {
  if (!isValidSecretName(name)) throw new Error('凭据名称无效');
  getStudioDatabase().deleteSecretValue(name);
}

async function resolveToolSecrets(argumentsValue) {
  const referenced = secretReferences(argumentsValue);
  if (referenced.length === 0) {
    return {
      arguments: argumentsValue,
      referenced,
      expanded: false,
      redact: (value) => value,
    };
  }
  const secrets = await getStudioDatabase().readSecretValuesAsync();
  const resolved = expandSecretReferences(argumentsValue, secrets);
  return {
    arguments: resolved.value,
    referenced,
    expanded: true,
    redact: (value) => redactSecretValues(value, secrets),
  };
}

async function redactToolSecrets(value) {
  return redactSecretValues(value, await getStudioDatabase().readSecretValuesAsync());
}

module.exports = {
  listSecrets,
  redactToolSecrets,
  removeSecret,
  resolveToolSecrets,
  writeSecret,
};

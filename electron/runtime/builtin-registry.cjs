const capabilityModules = Object.freeze([
  require('../capabilities/coding-tools/index.cjs'),
  require('../capabilities/filesystem/index.cjs'),
  require('../capabilities/todo/index.cjs'),
  require('../capabilities/long-task/index.cjs'),
  require('../capabilities/harness/index.cjs'),
  require('../capabilities/tool-search/index.cjs'),
  require('../capabilities/skills/index.cjs'),
  require('../capabilities/request-trace/index.cjs'),
  require('../capabilities/permissions/index.cjs'),
  require('../capabilities/subagents/index.cjs'),
  require('../capabilities/metrics/index.cjs'),
]);

const BUILTIN_MANIFESTS = Object.freeze(
  capabilityModules.flatMap((capability) => capability.manifests),
);

function assertRegistryIntegrity(manifests, extensions) {
  const manifestIds = manifests.map((manifest) => `builtin:${manifest.id}`);
  const knownIds = new Set(manifestIds);
  if (knownIds.size !== manifestIds.length) {
    throw new Error('内置能力注册表包含重复的 manifest ID');
  }
  if (extensions.size !== knownIds.size) {
    throw new Error('内置能力注册表生成的 extension 数量与 manifest 不一致');
  }

  const runtimeNames = new Set();
  for (const manifest of manifests) {
    const id = `builtin:${manifest.id}`;
    if (!extensions.has(id)) throw new Error(`内置能力缺少 extension：${id}`);
    const declaredNames = manifest.runtimeNames || [manifest.runtimeName];
    for (const name of declaredNames) {
      if (runtimeNames.has(name)) throw new Error(`内置能力包含重复 runtime：${name}`);
      runtimeNames.add(name);
    }
    for (const dependency of manifest.requires || []) {
      if (!knownIds.has(dependency)) {
        throw new Error(`${id} 依赖不存在的内置能力：${dependency}`);
      }
    }
  }
}

/**
 * Build the complete built-in extension map from explicit capability modules.
 * Static imports keep packaging, ordering, and dependency failures visible.
 */
function createStudioBuiltins(context) {
  const extensions = new Map();
  for (const capability of capabilityModules) {
    for (const [id, extension] of capability.create(context)) {
      if (extensions.has(id)) throw new Error(`内置能力重复注册：${id}`);
      extensions.set(id, extension);
    }
  }
  assertRegistryIntegrity(BUILTIN_MANIFESTS, extensions);
  return extensions;
}

module.exports = {
  BUILTIN_MANIFESTS,
  createStudioBuiltins,
};

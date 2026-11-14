/**
 * Keep credential expansion outside Durable's persisted tool intent.
 * This is a data-handling boundary for trusted Node tools, not a sandbox.
 */
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { createSecretRedactor, expandSecretReferences } = require('../core/secret-vault.cjs');

function protectTool(tool, readSecrets) {
  return {
    ...tool,
    async execute(args, api, context) {
      const secrets = await readSecrets();
      const { value } = expandSecretReferences(args, secrets);
      const redactor = createSecretRedactor(secrets);
      const safeApi = {
        ...api,
        output(chunk, skipped) {
          const safe = redactor.push(chunk);
          if (safe || skipped) api.output(safe, skipped);
        },
        details: (details, ...rest) => api.details(redactor.redact(details), ...rest),
        diagnostic: (diagnostic) => api.diagnostic(redactor.redact(diagnostic)),
        // Nested calls persist their input before executing. Restore references
        // here; the child's own execution wrapper expands them again.
        executeTool: (name, argumentsValue, ...rest) => (
          api.executeTool(name, redactor.redact(argumentsValue), ...rest)
        ),
      };
      try {
        return redactor.redact(await tool.execute(value, safeApi, context));
      } catch (error) {
        throw new Error(redactor.redact(error instanceof Error ? error.message : String(error)));
      } finally {
        const tail = redactor.push('', true);
        if (tail) api.output(tail);
      }
    },
  };
}

function createSecretAwareRegistry(registry, readSecrets = () => getStudioDatabase().readSecretValuesAsync()) {
  return {
    snapshot: () => registry.snapshot(),
    subscribe: (listener) => registry.subscribe(listener),
    uninstall: (extension) => registry.uninstall(extension),
    install(extension) {
      registry.install({
        ...extension,
        ...(extension.tools ? { tools: extension.tools.map((tool) => protectTool(tool, readSecrets)) } : {}),
      });
    },
  };
}

module.exports = { createSecretAwareRegistry };

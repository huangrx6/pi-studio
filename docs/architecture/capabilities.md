# Capability Architecture

Pi Studio uses two related but separate architectural concepts:

- An **extension** is a product and distribution boundary. It has a manifest, trust rules, lifecycle, and enable/disable state.
- A **capability** is a source boundary. It owns the implementation, persistence adapters, protocol, and registration entry for one coherent behavior.

The same feature can use both concepts. For example, `studio-subagents` is an extension in the product catalog and a capability in the source tree.

## Boundaries

| Area | Owns | Does not own |
| --- | --- | --- |
| `electron/core/` | Stable primitives, SQLite, model metadata, extension contracts | Agent-loop assembly or capability-specific behavior |
| `electron/runtime/` | Durable startup, explicit built-in registry, shared runtime contracts | Product UI or external service implementations |
| `electron/capabilities/<name>/` | One Agent capability and its public `index.cjs` | Other capabilities' internals |
| `electron/integrations/<name>/` | External systems and adapters | Product distribution or feature UI |
| `electron/services/` | General application services | Capabilities that participate directly in the Agent loop |
| `electron/ipc/` | Thin typed transport boundaries | Domain implementation |
| `web/src/features/<name>/` | UI, hooks, styles, and renderer-safe helpers for one capability | Electron-only state or credentials |
| `web/src/shared/` | Reusable UI primitives with no capability ownership | Feature-specific business logic |
| `web/src/shell/` | Frame, navigation, and global page structure | Individual feature screens |

## Registration contract

Each built-in capability exports:

```js
module.exports = {
  manifests: Object.freeze([/* one or more manifests owned by this capability */]),
  create(context) {
    return new Map([
      ['builtin:<id>', extension],
    ]);
  },
};
```

`electron/runtime/builtin-registry.cjs` imports capability modules in an explicit order. It validates that:

- every manifest maps to exactly one extension;
- every extension is produced by exactly one manifest;
- dependency IDs exist;
- runtime names and contribution declarations remain consistent.

Runtime directory scanning is intentionally unsupported. Explicit imports make packaging, dependency ordering, security review, and test failures deterministic.

## Capability map

| Capability | Durable contribution | Primary stage | Main implementations |
| --- | --- | --- | --- |
| Coding tools | Tool provider | Tool task | Durable CodingTools |
| Tool search | Tool discovery | Tool task | Durable tool search |
| Filesystem | Read-only tools | Tool task | `electron/capabilities/filesystem/` |
| Permissions | Tool guard | Tool task hook | `electron/capabilities/permissions/` |
| Harness | Prompt assembly | Section | `electron/capabilities/harness/` |
| Skills | Progressive disclosure | Section | `electron/capabilities/skills/` |
| Todo | Planning state | Tool task and projection | `electron/capabilities/todo/` |
| Long task | Continuation policy | Generation task | `electron/capabilities/long-task/` |
| Request trace | Observation | Section and generation hook | `electron/capabilities/request-trace/` |
| Image fit | Request image guard | Generation hook | `electron/capabilities/image-fit/` |
| Subagents | Orchestration | Tool task, owned conversation, background task | `electron/capabilities/subagents/` |
| Metrics | Observation and UI projection | Telemetry plus extension data source | `electron/capabilities/metrics/` |
| MCP | External tool source and adapter | Tool registration and section | `electron/integrations/mcp/` |
| Auto compaction | Runtime policy | Generation request boundary | Pi Durable, configured through `electron/runtime/durable-runtime.cjs` |
| Quota status | UI data source | Extension UI projection | `extensions/pi-quota-status/` |
| Extension distribution | Trust and installation | Application service | `electron/services/` |
| Credentials | Platform security | Main process storage | `electron/core/` and `electron/services/` |

## Migration rules

1. Move a capability together with its manifest, protocol, adapter, and related tests.
2. Update every consumer to the new public entry point in the same change.
3. Keep tests under the matching `tests/{electron,web,integration}/` boundary and include the owning capability or feature in the file name. A multi-file suite may use a domain subdirectory.
4. Do not add forwarding files for removed source paths.
5. Validate behavior before moving another capability.

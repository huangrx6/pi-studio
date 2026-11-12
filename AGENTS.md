# Pi Studio Repository Instructions

## Product boundary

- Pi Studio is a standalone Electron application built on Pi Durable. Do not read or modify the legacy `~/.pi` directory, Pi CLI settings, `settings.json`, `auth.json`, or `models.json`.
- Studio owns its data through SQLite and managed directories under `~/.pi-studio` (its own data root, separate from Electron's `userData`), plus explicit project resources under `.pi-studio/`. Tests and QA may override the directory with `PI_STUDIO_USER_DATA`.
- Preserve the trust boundary: extensions execute as explicitly trusted Node code in the Electron main process. Do not describe integrity hashes or static command checks as an operating-system sandbox.

## Source layout

- `electron/core/`: application state, SQLite, models, extension contracts, and shared primitives.
- `electron/runtime/`: Durable composition, the explicit built-in registry, and runtime-only helpers.
- `electron/capabilities/`: cohesive Agent capabilities. Each capability owns its manifest and one public `index.cjs` entry point.
- `electron/integrations/`: external systems such as MCP and model providers.
- `electron/services/`: application services that do not own an Agent capability, such as updates, menus, windows, and distribution.
- `electron/ipc/`: typed preload/IPC boundaries grouped by domain.
- `web/src/shell/`: application frame, navigation, and shared page chrome.
- `web/src/features/`: capability-aligned React UI, hooks, styles, and pure helpers.
- `web/src/shared/`: small components and helpers used by more than one feature.
- `web/src/types/`: renderer contracts.
- `web/src/styles/`: global tokens, palettes, and component styles.
- `tests/electron/`, `tests/web/`, `tests/integration/`: automated Node tests by execution boundary. File names identify the owning capability, feature, or service.
- `tools/qa/`: local Playwright QA scripts, with ignored output under `.qa/`.
- `tools/cli/` and `tools/icons/`: maintainer tooling.
- `examples/extensions/`: author-facing examples.
- `extensions/`: first-party official extensions.
- `docs/assets/`: the small reviewed screenshot set used by README and GitHub Pages.

Do not add source, tests, generated output, and screenshots to the same first-level directory. Put new files in the domain directory above instead of creating another general-purpose bucket.

## Implementation rules

- Keep Pi Durable as the execution source of truth. Studio SQLite stores only projections, settings, resource trust, and metadata it owns.
- Register built-ins through an explicit static table. Do not scan directories at runtime; packaged Electron builds need deterministic ordering, dependency validation, and visible imports.
- A capability's internals are private. Other areas depend on its `index.cjs` or a shared runtime contract.
- Do not add compatibility shims for deleted Pi Coding Agent modules or old IPC shapes. Data migrations are allowed only when they protect existing Studio data and must be versioned.
- Keep the renderer contract JSON-safe. Durable handles, task objects, storage paths, credentials, and raw extension implementations must not cross into the renderer.
- Extension UI is declarative and token-based. Do not execute extension-provided HTML, JavaScript, or CSS in the renderer.
- Credentials remain in the main process behind `safeStorage`; never log, project into extension data, or send plaintext secrets to the renderer.
- Global, user, workspace, project, and session settings must use an explicit scope and precedence. Do not infer a broader scope from a narrower one.
- Hot reload is required for tools, skills, MCP, Harness, subagents, and extension resource changes at the next safe request boundary.

## Verification

Run the narrowest relevant check while editing, then the full gate:

```sh
pnpm run extension:schema
pnpm test
pnpm run build
git diff --check
```

For extension changes also run:

```sh
node tools/cli/pi-studio-extension.mjs validate examples/extensions/agent-starter --scope user --json
```

Desktop visual and interaction checks live in `tools/qa/` and write to `.qa/`. Do not commit QA output or add screenshots unless README or the reviewed documentation gallery uses them.

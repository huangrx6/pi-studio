# Pi Studio Repository Instructions

## Product boundary

- Pi Studio is a standalone Electron application built on Pi Durable. Do not read or modify the legacy `~/.pi` directory, Pi CLI settings, `settings.json`, `auth.json`, or `models.json`.
- Studio owns its data through SQLite and managed directories under Electron `userData`, plus explicit project resources under `.pi-studio/`.
- Preserve the trust boundary: extensions execute as explicitly trusted Node code in the Electron main process. Do not describe integrity hashes or static command checks as an operating-system sandbox.

## Source layout

- `electron/core/`: application state, SQLite, models, extension contracts, and shared primitives.
- `electron/services/`: Durable runtime and application services.
- `electron/ipc/`: typed preload/IPC boundaries grouped by domain.
- `web/src/components/`: React UI components.
- `web/src/lib/`: renderer-safe pure helpers.
- `web/src/types/`: renderer contracts.
- `web/src/styles/`: global tokens, palettes, and component styles.
- `tests/electron/`, `tests/web/`, `tests/integration/`: automated Node tests by boundary.
- `tools/qa/`: local Playwright QA scripts, with ignored output under `.qa/`.
- `tools/cli/` and `tools/icons/`: maintainer tooling.
- `examples/extensions/`: author-facing examples.
- `extensions/`: first-party official extensions.
- `docs/assets/`: the small reviewed screenshot set used by README and GitHub Pages.

Do not add source, tests, generated output, and screenshots to the same first-level directory. Put new files in the domain directory above instead of creating another general-purpose bucket.

## Implementation rules

- Keep Pi Durable as the execution source of truth. Studio SQLite stores only projections, settings, resource trust, and metadata it owns.
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

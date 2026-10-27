# Pi Studio

A desktop Pi workspace built with Electron and
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi).

The kernel is Pi. Pi `SessionManager` JSONL is the only source of conversations.
DeepSeek Harness contributes visual tokens/styles only; no DSH Host, plugin
runtime, session persistence or workspace registry is used.

## Run

```bash
pnpm install
npm run build
MINIMAX_CN_API_KEY=... PI_MODEL_REF=minimax-cn/MiniMax-M3.1-Flash npm start
```

Development:

```bash
pnpm dev
```

## Current MVP

- Packaged macOS `.app` at `release/mac-arm64/Pi Studio.app` (unsigned)
- Model picker backed by the local Pi catalog; selection persists in app data

- Desktop Electron window
- Pi session and workspace discovery from `~/.pi/agent/sessions`
- New session + streaming Pi chat
- Pi JSONL history restored on restart
- Right-hand workspace file tree and text preview

## Settings and Pi resources

- Providers: edit API keys, add OpenAI/Anthropic/Google-compatible providers to
  `models.json`, and add custom model metadata (context window, max output,
  image input, reasoning).
- Models: enable a subset per provider. The composer picker shows enabled
  models first, and `enabledModels` is shared with the local Pi settings.
- Skills: reads `~/.pi/agent/skills`, `.agents/skills`, `.agents`, and the
  current project's `.pi/skills`; groups global and project skills.
- Extensions: lists `settings.json` packages and `extensions-data`, and can
  install/remove npm/git package sources through Pi's package manager.
- MCP: reads/writes `mcp.json`; can add stdio/HTTP servers and toggle them.

## Pi data sharing

Pi Studio deliberately shares the local Pi agent directory:

```text
~/.pi/agent/sessions
~/.pi/agent/auth.json
~/.pi/agent/models.json
~/.pi/agent/mcp.json
~/.pi/agent/skills
~/.pi/agent/extensions
```

Sessions, keys, MCP, skills and extensions are visible in the desktop app and in
the local `pi` CLI. Changes made in Settings are written back to those Pi files.

## Not yet

- OAuth login UI (API keys are editable in Settings)
- Plugin/automation pages and trace view
- Skill enable/disable and extension enable/disable
- Line-numbered/Shiki syntax highlighting in the file preview
- Signed/notarized packaging

See `THIRD_PARTY_NOTICES.md` for the MIT attribution of copied DSH styles.

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

- Desktop Electron window
- Pi session and workspace discovery from `~/.pi/agent/sessions`
- New session + streaming Pi chat
- Pi JSONL history restored on restart
- Right-hand workspace file tree and text preview

## Not yet

- Full model picker/login UI
- Settings, plugins/MCP/skills management
- Line-numbered/Shiki syntax highlighting in the file preview
- Signed/notarized packaging

See `THIRD_PARTY_NOTICES.md` for the MIT attribution of copied DSH styles.

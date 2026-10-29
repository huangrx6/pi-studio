# Agent Extension Starter

This example demonstrates both extension layers:

- `extension.mjs` registers the `extension_echo` Durable tool and a command handler.
- `pi-studio.extension.json` declares the tool, command, permission, and JSON-only UI.

From the Pi Studio repository:

```sh
node tools/cli/pi-studio-extension.mjs validate examples/extensions/agent-starter
node tools/cli/pi-studio-extension.mjs pack examples/extensions/agent-starter --out release
```

Install the generated `.pi-extension.zip` through the Studio extension installer.
Review the source and permissions before trusting an Agent extension.

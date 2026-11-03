# Interaction work, November 2026

This records the November 2026 interaction delivery alongside the Pi Durable
1.5 upgrade. The checklist below reflects implemented product behavior; known
security and platform boundaries remain documented elsewhere.

- Delivered: searchable conversation actions shared by the composer and Cmd/Ctrl+K; declarative extension commands; responsive list/detail shell.
- Delivered: compact subagent overview, controls, independent accounting and safe-boundary budgets.
- Delivered: MCP connection test, tool inspection and OAuth using Pi MCP 1.5.
- Delivered: scoped sensitive-information checks, exact-value session exemptions and encrypted `{{secret:NAME}}` tool placeholders.
- Delivered: skill source adapters and a consistent discover/install/update UI.
- Delivered: managed worktrees with preservation, adoption, discard and reclamation lifecycle.
- Delivered: isolated model comparison through the same action registry. It is a view inside the conversation tab, not a fourth top-level tab.

Implementation constraints: Durable owns execution, budgets and task state;
SQLite holds Studio projections/configuration only. Secrets stay in the main
process. No archive cleanup may silently discard unique worktree outcomes.
The complete delivery is included in Pi Studio v0.0.9.

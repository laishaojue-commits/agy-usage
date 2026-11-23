# agy-usage Plugin for Antigravity

Pure local, 100% read-only Antigravity MCP App plugin (`SEP-1865` + `com.google.antigravity/ui` dual entrypoints: side pane `+` menu & left sidebar global view), powered by the GravityBox Windows SQLite & storage analysis engine.

## Features (Pure Local Read-Only L0 Mode)

- **Zero Process Probing & Zero Credentials**: Reads only local Antigravity conversation SQLite databases and cache directories in-process over MCP stdio (`node`). Never spawns PowerShell/Win32 process probes, never reads OAuth credentials, never probes Named Pipes or loopback ports, and never calls cloud quota APIs.
- **Focused 6-Tab Dashboard**: `overview`, `context`, `usage`, `storage`, `settings`, and `about` — highlighting today's tokens, estimated cost, request counts, conversation context windows & Swarm/subagent watermarks, 24h stacked model breakdown charts, and protected/reclaimable storage distribution.
- **Strict Read-Only Gate**: Destructive cache mutations and account switching remain blocked (`READ_ONLY_UNSUPPORTED`), and legacy external/quota control commands return `PURE_LOCAL_READ_ONLY` without side effects.

## Entrypoints

- Side pane (`aux_pane`): Click `+` in the Antigravity auxiliary pane and select **agy-usage**.
- Sidebar (`global`): Click **agy-usage** in the left navigation sidebar for the full-page dashboard.

## Upgrading from a Release ZIP

1. **Disable** `agy-usage` in Antigravity's Plugins page first so the active MCP `node.exe` process releases any directory locks.
2. **Back up and move away or remove the entire old `plugins/agy-usage/` directory** — never extract a new ZIP directly over an existing `plugins/agy-usage/` directory, as removed modules from older versions would otherwise remain on disk.
3. **Extract** the new release ZIP into a fresh `plugins/agy-usage/` directory (with `plugin.json` directly inside `plugins/agy-usage/plugin.json`).
4. **Re-enable** `agy-usage` in Antigravity's Plugins page. Your personal UI preferences (`ui-prefs.json`) are stored separately in the plugin data directory and will not be lost when replacing the plugin folder.

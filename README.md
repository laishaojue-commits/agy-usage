# agy-usage

**agy-usage shows how you use Antigravity.** Open the dashboard to see how many tokens you used today, which models used the most, and how much room is left in your current conversation. You can also check context usage by subagent and see how much disk space your local cache takes up. Everything stays on your device; cost estimates are not actual charges.

[简体中文文档](./README.zh-CN.md)

## Screenshots

![Overview: daily token usage, estimated costs, and active models](./assets/screenshots/overview.png)

![Context: how much context the current conversation and subagents are using](./assets/screenshots/context.png)

![Usage: token trends by model, estimated costs, and cache hit rate](./assets/screenshots/usage.png)

## Key Features

- **Overview Dashboard**: Today's token total, estimated USD cost, request counts, an active conversation context summary card, 24-hour stacked model usage chart, and top active models.
- **Context Window & Swarm Monitor**:
  - Tracks current context occupancy vs. capacity (`used / capacity`) with explicit DB threshold vs. model reference indicators and compaction counts.
  - Supports multi-model / Orchestrator planner & executor stage breakdown.
  - Monitors Swarm / subagent members independently (running, waiting, collapsed completed members, plus combined swarm usage & cost totals).
- **Usage & Cost Analytics**:
  - Interactive stacked bar charts (`Tokens` / `Requests` toggle, hover tooltip with bucket + model + value) across `Today`, `7d`, `30d`, and `All`.
  - Shared deterministic color palette linking the stacked trend chart and API Cost Donut chart.
  - Searchable, paginated request log and built-in offline pricing catalog.
- **Read-Only Storage Inspection**:
  - Measures reclaimable Antigravity cache/log buckets alongside protected core data allowlists (`conversations`, `knowledge`, `brain`, etc.) with destructive mutations locked (`READ_ONLY_UNSUPPORTED`).

## Architecture & L0 Security Guarantees

`agy-usage` operates strictly at **L0 (Pure Local Read-Only)**:

- **34-Module Backend Allowlist**: `tools/plugin-allowlist.mjs` enforces an AST-verified graph of exactly 34 local `.js` modules with zero `fetch()`, `require()`, `eval()`, or dynamic imports.
- **Zero Process Probing & Zero Credentials**: Never spawns PowerShell/Win32/POSIX process scanners, never reads OAuth tokens, never probes CDP ports or Named Pipes/Unix sockets, and never calls cloud quota APIs.
- **Self-Contained Single-File MCP App UI**: Built with Vite + `@modelcontextprotocol/ext-apps` into a single HTML bundle (`ui/mcp-app.html`) with strict CSP (`connect-src 'none'`, per-build `sha256` inline script hash) and dual Antigravity entrypoints (`aux_pane` `+` menu & `global` left sidebar).
- **Hardened Transport & File Boundaries**: `1 MiB` stdio frame cap, `assertSafeJson` prototype-pollution check, `SAFE_CONVERSATION_ID_RE` (`/^[a-zA-Z0-9_-]{4,128}$/`) input validation, `realpathSync`/`lstatSync` symlink and sidecar checks on SQLite reads, and rollback-preserving plugin installer.

See [SECURITY.md](./SECURITY.md) for full details and known non-atomic SQLite/WAL read boundaries.

## Installation

### Option 1: Install from Release ZIP

1. Download `agy-usage-v0.0.0.zip` (and verify against `SHA256SUMS.txt` if desired) from Releases.
2. Extract its contents into a clean Antigravity plugins directory:
   - **Windows**: `%USERPROFILE%\.gemini\config\plugins\agy-usage\`
   - **macOS / Linux**: `~/.gemini/config/plugins/agy-usage/`
   Ensure `plugin.json` is located directly inside `plugins/agy-usage/plugin.json`.
3. Reload or enable **agy-usage** in Antigravity's Plugins manager.

#### Manual ZIP Upgrade Steps

1. **Disable** `agy-usage` in Antigravity's Plugins page first (on Windows this releases the `node.exe` directory lock).
2. **Back up and move away or remove the entire old `plugins/agy-usage/` directory** — **never extract a new ZIP over an existing `plugins/agy-usage/` directory**, otherwise removed modules from older releases will remain on disk.
3. **Extract** the new release ZIP into a fresh `plugins/agy-usage/` directory.
4. **Re-enable** `agy-usage` in Antigravity's Plugins page (your personal UI preferences in `ui-prefs.json` are stored separately in the plugin data directory and will not be lost when replacing the plugin directory).

### Option 2: Build & Install from Source

Requires **Node.js >= 22.15.0** (for built-in `node:sqlite`).

```bash
npm ci --ignore-scripts
npm run plugin:install
```

> **Windows Upgrade Tip**: When upgrading an already-running `agy-usage` plugin on Windows, Antigravity's active `node.exe` MCP server process may hold a directory lock on `plugins/agy-usage`. If installation reports a file lock, disable **agy-usage** in Antigravity's Plugins panel first, then run `npm run plugin:install` (which replaces the entire directory cleanly) or follow the manual ZIP replacement steps above, and re-enable it. If you still encounter a directory lock (`EPERM`/`EBUSY`) after disabling **agy-usage** in the Plugins page (because Antigravity's main process file watcher may still hold a handle on the plugin directory), **completely quit Antigravity** before running the installer or replacing the directory, then reopen Antigravity afterwards.

## Development & Verification

```bash
# Compile 34 backend TypeScript modules
npm run build

# Build self-contained single-file MCP App UI (ui/dist-mcp/mcp-app.html)
npm run ui:build

# Assemble & verify standalone plugin bundle (artifacts/agy-usage/)
npm run plugin:build

# Package deterministic cross-platform release archive (artifacts/agy-usage-v0.0.0.zip + SHA256SUMS.txt)
npm run plugin:zip

# Run all cross-platform tests (0 skipped)
npm test

# Run privacy & PII gate across source + build artifacts
npm run check:privacy -- --include-build
```

## License & Attribution

Released under the [MIT License](./LICENSE) (`Copyright (c) 2026 Enzoo404`).

`agy-usage` is built upon and gratefully acknowledges the upstream project **[Enzoo404/gravitybox](https://github.com/Enzoo404/gravitybox)** (`v1.1.3`, MIT License) for its local SQLite usage ledger scanner, conversation HUD context telemetry, model catalog, and pricing engine. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for full notices.

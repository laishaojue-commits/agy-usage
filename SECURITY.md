# Security Policy

`agy-usage-tool` is designed strictly around an **L0 Pure Local Read-Only** security boundary.

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `0.1.0` | Yes |

## L0 Pure Local Read-Only Architecture

`agy-usage-tool` enforces multiple layered controls so it can inspect local Antigravity usage and storage metadata without touching credentials, processes, or external networks:

1. **Zero Network / Outbound Calls**:
   - The backend allowlist (`tools/plugin-allowlist.mjs`) enforces an exact 34-module dependency graph with an AST check prohibiting `fetch()`, `require()`, `eval()`, dynamic `import()`, and external packages.
   - The MCP UI HTML (`ui/dist-mcp/mcp-app.html`) embeds a strict Content Security Policy (`default-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'`) with a per-build `sha256-...` inline script hash, and MCP resource metadata declares `csp.connectDomains: []`.
2. **Zero Process Probing & Zero Credential Access**:
   - Never spawns shells or Win32/macOS process probes (`ps`, `wmic`, PowerShell/CIM), never connects to Named Pipes or Unix sockets, never connects to CDP loopback ports, and never reads OAuth credential files or cloud quota APIs.
3. **Strict Command & Input Gates**:
   - Mutating actions (such as cache deletion or account switching) are rejected by `read-only-gate.ts` with `READ_ONLY_UNSUPPORTED`.
   - External/probe commands (such as `quota_probe_live`, `quota_refresh`, `pricing_sync_check`, `hud_set`, `launch_antigravity`) return `PURE_LOCAL_READ_ONLY` without side effects.
   - Stdio JSON-RPC frames are capped at `1 MiB` (`MAX_MESSAGE_BYTES`) prior to buffering/parsing, JSON payloads reject prototype-pollution keys via `assertSafeJson`, and `conversationId` parameters are strictly validated against `SAFE_CONVERSATION_ID_RE` (`/^[a-zA-Z0-9_-]{4,128}$/`).
4. **Symlink & Sidecar File Hardening**:
   - SQLite inspection (`sqlite-path.ts`) resolves the database directory via `realpathSync(dirname(resolved))`—allowing legitimate ancestor-level directory junctions/symlinks (such as a Windows `~/.gemini` junction or macOS `/var -> /private/var`)—while enforcing `lstatSync` regular non-symlink checks (`!isFile() || isSymbolicLink()`) and `realpathSync` parent-directory consistency on the `.db` file and `-wal`/`-shm` sidecars prior to opening read-only connections, strictly rejecting symlinked/reparse-point or directory `.db` and sidecar files (this pre-check is not atomic with the subsequent SQLite open).
   - Plugin installation (`tools/install-plugin.mjs`) validates destination directories upfront (`lstat` non-symlink directory + `plugin.json` `name === 'agy-usage-tool'`), builds into an isolated staging directory, runs allowlist and privacy gates before swap, and preserves existing rollback backups if validation or swap fails.

## Known Boundaries (Non-Atomic SQLite/WAL Reads)

- `agy-usage-tool` opens live Antigravity SQLite conversation databases in read-only mode via `node:sqlite` (`new DatabaseSync(path, { readOnly: true })` with `PRAGMA query_only = ON` and bounded `busy_timeout` retries in worker threads) while Antigravity may concurrently write to the `.db` and `-wal` / `-shm` sidecar files.
- Even in read-only mode, active WAL shared-memory coordination in SQLite/OS layers can still involve `-wal` and `-shm` sidecars, and `agy-usage-tool` never acquires cross-process filesystem snapshots with Antigravity. Consequently, reading an actively mutating WAL database is **non-atomic across processes**: `sqlite-worker.ts` verifies `PRAGMA data_version` consistency around reads and degrades transient churn (`cached_or_partial` / `failed` diagnostics) rather than blocking Antigravity.

## Reporting a Vulnerability

Please **do not** disclose security vulnerabilities or attach personal SQLite/log files in public GitHub issues.

- Report vulnerabilities privately via **GitHub Security Advisories** (**Security -> Advisories -> Report a vulnerability**) in the repository.
- Include reproduction steps, affected version/platform, and impact details without sharing personal credentials or private home paths.

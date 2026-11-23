# Third-Party Notices and Attribution

`agy-usage` is a standalone, pure local read-only MCP App plugin extracted and refactored from **GravityBox** under the MIT License.

## 1. Upstream Project Attribution

- **Project**: `Enzoo404/gravitybox` (`v1.1.3`)
- **License**: MIT License (`Copyright (c) 2026 Enzoo404`)
- **Scope Used**: L0 pure local read-only SQLite usage scanner, conversation context & Swarm watermark engine, model catalog and built-in pricing engine, read-only storage inspection catalog, bilingual UI packs, and MCP App dashboard components.

## 2. Model Brand Icons & Trademarks

- Model vendor icons stored under `assets/model-icons/` (`gemini.png`, `claude.png`, `openai.png`) are documented with source URLs and SHA-256 digests in [`assets/model-icons/sources.json`](assets/model-icons/sources.json).
- **Google**, **Antigravity**, and **Gemini** are trademarks or registered trademarks of Google LLC.
- **Claude** is a trademark or registered trademark of Anthropic PBC.
- **OpenAI** and **GPT** are trademarks or registered trademarks of OpenAI Inc.

**Trademark Disclaimer**: `agy-usage` is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Google LLC, Anthropic PBC, or OpenAI Inc. Brand names and model icons are used solely for technical identification and compatibility reference (nominative fair use).

## 3. Open-Source Runtime & Build Dependencies

- **Node.js** (built-in `node:sqlite`, `node:worker_threads`, `node:crypto`, etc.) — MIT License ([nodejs.org](https://nodejs.org/)).
- **`@modelcontextprotocol/sdk`** — MIT License (bundled in the plugin runtime `node_modules`).
- **`@modelcontextprotocol/ext-apps`** — MIT License (bundled at build time into the self-contained `ui/mcp-app.html`).
- **`typescript`**, **`vite`**, **`vite-plugin-singlefile`** — Apache-2.0 / MIT Licenses (development/build tooling only).

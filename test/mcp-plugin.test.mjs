import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { getCacheMetadata } from '../dist/maintenance-catalog.js';
import { getActiveLocale, setActiveLocale } from '../dist/i18n.js';
import { getDefaultPluginPaths, installPlugin } from '../tools/install-plugin.mjs';
import { ALLOWED_BACKEND_MODULES, inspectPluginBackend } from '../tools/plugin-allowlist.mjs';
import { packagePluginZip } from '../tools/package-zip.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const mcpHtmlPath = join(repoRoot, 'ui', 'dist-mcp', 'mcp-app.html');
const pluginDir = join(repoRoot, 'plugin');

function parseZipEntries(zipBuf) {
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65557); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'ZIP EOCD signature not found');
  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.equal(zipBuf.readUInt32LE(cursor), 0x02014b50, 'Invalid central directory signature');
    const method = zipBuf.readUInt16LE(cursor + 10);
    const dosTime = zipBuf.readUInt16LE(cursor + 12);
    const dosDate = zipBuf.readUInt16LE(cursor + 14);
    const compSize = zipBuf.readUInt32LE(cursor + 20);
    const uncompSize = zipBuf.readUInt32LE(cursor + 24);
    const nameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const externalAttrs = zipBuf.readUInt32LE(cursor + 38);
    const localOffset = zipBuf.readUInt32LE(cursor + 42);
    const name = zipBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    assert.equal(zipBuf.readUInt32LE(localOffset), 0x04034b50, `Invalid local header for ${name}`);
    const lfhNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const lfhExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
    const compData = zipBuf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? inflateRawSync(compData) : compData;
    assert.equal(raw.length, uncompSize, `Size mismatch extracting ${name}`);
    entries.push({ name, raw, posixMode: (externalAttrs >>> 16) & 0o777777, dosTime, dosDate });
  }
  return entries;
}

function createStdioMcpClient(serverScript, args, env = {}) {
  const child = spawn(process.execPath, [serverScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  const rawStdoutLines = [];

  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    while (true) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      rawStdoutLines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        for (const p of pending.values()) {
          p.reject(new Error(`Non-JSON line emitted on MCP stdout: ${line}`));
        }
        pending.clear();
        return;
      }
      if (msg.jsonrpc !== '2.0') {
        for (const p of pending.values()) {
          p.reject(new Error(`Invalid JSON-RPC version on stdout: ${line}`));
        }
        pending.clear();
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      }
    }
  });

  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  function request(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timeout (${method}): stderr=${stderr}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async function close() {
    try {
      child.stdin.end();
    } catch {}
    return await Promise.race([
      closed,
      new Promise((resolve) =>
        setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve({ code: null, signal: 'SIGKILL' });
        }, 4000)
      ),
    ]);
  }

  return {
    request,
    notify,
    close,
    getStderr: () => stderr,
    getStdoutLines: () => rawStdoutLines,
    getExitCode: () => child.exitCode,
  };
}

test('Single-file MCP App HTML, plugin manifest, and 34-module AST allowlist validation', async () => {
  assert.equal(existsSync(mcpHtmlPath), true, `Missing single-file HTML build: ${mcpHtmlPath}`);
  const st = await stat(mcpHtmlPath);
  assert.ok(st.size > 10_000, 'mcp-app.html must not be empty');
  assert.ok(st.size < 10 * 1024 * 1024, `mcp-app.html exceeds 10 MiB limit (${st.size} bytes)`);

  const html = await readFile(mcpHtmlPath, 'utf8');
  assert.equal(/<script[^>]+src=/i.test(html), false, 'mcp-app.html must not contain external <script src=...>');
  assert.equal(/<link[^>]+rel=["']stylesheet/i.test(html), false, 'mcp-app.html must not contain external <link rel="stylesheet">');
  assert.equal(/["']\.?\/assets\//i.test(html), false, 'mcp-app.html must not reference external /assets/ files');
  assert.equal(/<meta name="gb-runtime-mode" content="mcp-app"/i.test(html), true);
  assert.equal(/<title>agy-usage<\/title>/i.test(html), true, 'mcp-app.html title must be agy-usage');
  assert.equal(/<style\b/i.test(html), true, 'mcp-app.html must inline CSS styles');
  assert.equal(/<script\b/i.test(html), true, 'mcp-app.html must inline JS bundle');
  assert.equal(html.includes('agy_usage_ipc'), true, 'mcp-app.html must call agy_usage_ipc');
  assert.equal(html.includes('gravitybox_ipc'), false, 'mcp-app.html must not call legacy gravitybox_ipc');
  assert.equal(html.includes('open_gravitybox'), false, 'mcp-app.html must not reference legacy open_gravitybox');
  assert.ok((html.match(/data:image\/png;base64,/g) || []).length >= 4, 'mcp-app.html must inline PNG icons');

  const pluginJson = JSON.parse(await readFile(join(pluginDir, 'plugin.json'), 'utf8'));
  const allowedTopLevel = new Set([
    'name', 'displayName', 'version', 'description', 'logo', 'suggestedPrompts', 'author', 'homepage', 'repository', 'disabled',
  ]);
  for (const key of Object.keys(pluginJson)) {
    assert.ok(allowedTopLevel.has(key), `Unexpected top-level field in plugin.json: ${key}`);
  }
  assert.equal(pluginJson.name, 'agy-usage');
  assert.equal(pluginJson.displayName, 'agy-usage');
  assert.equal(pluginJson.logo, 'assets/logo.png');
  assert.equal(pluginJson.suggestedPrompts.length, 3);
  assert.equal(pluginJson.suggestedPrompts.every((p) => p.includes('agy-usage')), true);

  const pluginPkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(pluginPkg.name, 'agy-usage');

  const pluginReadme = await readFile(join(pluginDir, 'README.md'), 'utf8');
  assert.equal(pluginReadme.includes('# agy-usage Plugin'), true);
  assert.equal(pluginReadme.includes('Pure Local Read-Only'), true);

  const mcpCfg = JSON.parse(await readFile(join(pluginDir, 'mcp_config.json'), 'utf8'));
  assert.equal(mcpCfg.mcpServers.gravitybox, undefined);
  assert.equal(mcpCfg.mcpServers['agy-usage'].command, 'node');
  assert.deepEqual(mcpCfg.mcpServers['agy-usage'].args, [
    '${PLUGIN_ROOT}/bin/server.mjs',
    '--data-dir',
    '${PLUGIN_DATA}',
  ]);

  const capabilitiesTs = await readFile(join(repoRoot, 'ui', 'src', 'ui', 'capabilities.ts'), 'utf8');
  assert.equal(capabilitiesTs.includes('getUiCapabilities'), true);
  assert.equal(capabilitiesTs.includes('resolveAllowedView'), true);
  const mainTs = await readFile(join(repoRoot, 'ui', 'src', 'main.ts'), 'utf8');
  assert.equal(mainTs.includes('getUiCapabilities'), true);
  assert.equal(mainTs.includes('resolveAllowedView'), true);
  const aboutTs = await readFile(join(repoRoot, 'ui', 'src', 'views', 'about.ts'), 'utf8');
  assert.equal(aboutTs.includes('capabilities.brandTitle'), true);
  const l10nTs = await readFile(join(repoRoot, 'ui', 'src', 'i18n', 'l10n.ts'), 'utf8');
  assert.equal(l10nTs.includes('Enzoo404/gravitybox'), true);

  const logoBuf = await readFile(join(pluginDir, 'assets', 'logo.png'));
  assert.equal(logoBuf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(logoBuf.readUInt32BE(16), logoBuf.readUInt32BE(20), 'logo.png must be square');

  const modules = await inspectPluginBackend(join(repoRoot, 'dist'), join(pluginDir, 'bin', 'server.mjs'));
  assert.equal(modules.length, 34);
  assert.deepEqual(modules, [...ALLOWED_BACKEND_MODULES].sort());
});

test('Stdio MCP Server protocol contract, pure local read-only gate, and UI preferences persistence', { timeout: 30000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agy-mcp-server-'));
  const dataDir = join(tempRoot, 'plugin-data');
  const geminiDir = join(tempRoot, 'gemini');
  const stateDir = join(tempRoot, 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'pricing-preferences.json'), '{"enabled":true}');
  await mkdir(geminiDir, { recursive: true });

  const client = createStdioMcpClient(
    join(pluginDir, 'bin', 'server.mjs'),
    [
      '--data-dir', dataDir,
      '--state-dir', stateDir,
      '--gemini-dir', geminiDir,
      '--app', join(tempRoot, 'missing-antigravity'),
      '--profile', join(tempRoot, 'missing-profile'),
    ],
    {
      GRAVITYBOX_HOME_DIR: tempRoot,
      GRAVITYBOX_APP_SUPPORT_DIR: tempRoot,
    }
  );
  t.after(async () => {
    await client.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const init = await client.request('initialize', {
    protocolVersion: '2025-11-21',
    capabilities: {},
    clientInfo: { name: 'agy-usage-test', version: '1.0.0' },
  });
  assert.equal(init.serverInfo?.name, 'agy-usage');
  assert.ok(init.capabilities?.tools, 'Server must declare tools capability');
  assert.ok(init.capabilities?.resources, 'Server must declare resources capability');
  client.notify('notifications/initialized', {});

  const resList = await client.request('resources/list', {});
  const appResource = resList.resources.find((r) => r.uri === 'ui://agy-usage/app.html');
  assert.ok(appResource, 'ui://agy-usage/app.html must be in resources/list');
  assert.equal(appResource.name, 'agy-usage Dashboard');
  assert.equal(appResource.mimeType, 'text/html;profile=mcp-app');
  assert.equal(appResource._meta?.ui?.prefersBorder, false);

  const resRead = await client.request('resources/read', { uri: 'ui://agy-usage/app.html' });
  assert.deepEqual(resRead.contents[0]._meta.ui.csp.connectDomains, []);
  assert.deepEqual(resRead.contents[0]._meta.ui.permissions, {});
  assert.equal(resRead.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resRead.contents[0].text.includes('<div id="app"></div>'));

  const toolsList = await client.request('tools/list', {});
  const openTool = toolsList.tools.find((tool) => tool.name === 'open_agy_usage');
  const ipcTool = toolsList.tools.find((tool) => tool.name === 'agy_usage_ipc');
  assert.ok(openTool, 'open_agy_usage tool must exist');
  assert.ok(ipcTool, 'agy_usage_ipc tool must exist');

  assert.equal(openTool.title, 'agy-usage');
  assert.deepEqual(openTool.inputSchema?.properties?.view?.enum, ['overview', 'context', 'usage', 'storage', 'settings', 'about']);
  assert.equal(openTool.inputSchema?.properties?.conversationId?.type, 'string');
  assert.equal(openTool._meta?.ui?.resourceUri, 'ui://agy-usage/app.html');
  assert.deepEqual(openTool._meta?.ui?.visibility, ['model', 'app']);
  assert.deepEqual(openTool._meta?.['com.google.antigravity/ui']?.entrypoints, [
    { type: 'aux_pane', title: 'agy-usage' },
    { type: 'global', title: 'agy-usage' },
  ]);
  assert.equal(ipcTool.title, 'agy-usage IPC Bridge');
  assert.deepEqual(ipcTool._meta?.ui?.visibility, ['app']);

  const openEmptyRes = await client.request('tools/call', { name: 'open_agy_usage', arguments: {} });
  assert.ok(Buffer.byteLength(JSON.stringify(openEmptyRes), 'utf8') < 1024 * 1024);
  assert.ok(openEmptyRes.content[0].text.includes('agy-usage opened'));
  assert.equal(openEmptyRes.structuredContent.initialView, 'overview');
  assert.equal(openEmptyRes.structuredContent.runtimeInfo.mode, 'mcp-app');
  assert.equal(openEmptyRes.structuredContent.runtimeInfo.readOnlyMode, true);
  assert.equal(openEmptyRes.structuredContent.runtimeInfo.pipeEndpoint, '');
  assert.equal(openEmptyRes.structuredContent.runtimeInfo.backendRunning, false);
  assert.equal(openEmptyRes.structuredContent.runtimeInfo.winHelperActive, false);

  const openQuotaFallback = await client.request('tools/call', {
    name: 'open_agy_usage',
    arguments: { view: 'quota' },
  });
  assert.equal(openQuotaFallback.structuredContent.initialView, 'overview');

  const openStorageRes = await client.request('tools/call', {
    name: 'open_agy_usage',
    arguments: { view: 'storage' },
  });
  assert.equal(openStorageRes.structuredContent.initialView, 'storage');

  async function callIpc(payload) {
    const res = await client.request('tools/call', {
      name: 'agy_usage_ipc',
      arguments: { payload },
    });
    assert.ok(res.structuredContent && typeof res.structuredContent === 'object');
    return res.structuredContent;
  }

  const ping = await callIpc({ command: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(typeof ping.pid, 'number');

  const tStatus0 = Date.now();
  const status = await callIpc({ command: 'status' });
  const statusElapsedMs = Date.now() - tStatus0;
  assert.equal(status.ok, true);
  assert.equal(status.status.mode, 'mcp-direct');
  assert.equal(status.status.readOnlyMode, true);
  assert.ok(statusElapsedMs < 2000, `status must return promptly (took ${statusElapsedMs}ms)`);

  const tDash0 = Date.now();
  const dashboard = await callIpc({ command: 'dashboard_summary' });
  const dashElapsedMs = Date.now() - tDash0;
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.accounts, null);
  assert.ok(dashboard.usage);
  assert.ok(dashElapsedMs < 2000, `dashboard_summary must return promptly (took ${dashElapsedMs}ms)`);

  const usage = await callIpc({ command: 'usage_summary', period: 'today' });
  assert.equal(usage.ok, true);
  assert.equal(usage.period, 'today');

  const events = await callIpc({ command: 'usage_events', period: 'today', limit: 10 });
  assert.equal(events.ok, true);
  assert.ok(Array.isArray(events.rows));

  const pricing = await callIpc({ command: 'api_pricing_get' });
  assert.equal(pricing.ok, true);

  for (const command of ['pricing_sync_check', 'pricing_sync_set']) {
    const reply = await callIpc({ command, enabled: true });
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'PURE_LOCAL_READ_ONLY');
  }
  const invalidLanguage = await callIpc({ command: 'ui_prefs_set', language: 'a'.repeat(200) });
  assert.equal(invalidLanguage.ok, false);

  const langZh = await callIpc({ command: 'language_set', language: 'zh-Hans' });
  assert.equal(langZh.ok, true);
  assert.equal(langZh.status.locale, 'zh-Hans');

  const scan = await callIpc({ command: 'maintenance_scan' });
  assert.equal(scan.ok, true);
  assert.equal(scan.running, false);
  assert.ok(Array.isArray(scan.protectedEntries));

  const prevLocale = getActiveLocale();
  try {
    setActiveLocale('zh-Hans');
    const expectedGpuZh = getCacheMetadata('GPUCache')?.subtitle;
    const gpuEntry = scan.entries.find((e) => e.name === 'GPUCache');
    assert.ok(gpuEntry && expectedGpuZh);
    assert.equal(gpuEntry.subtitle, expectedGpuZh);
  } finally {
    setActiveLocale(prevLocale);
  }

  const hist = await callIpc({ command: 'maintenance_history' });
  assert.equal(hist.ok, true);
  assert.ok(Array.isArray(hist.snapshots));

  const prefsSet = await callIpc({ command: 'ui_prefs_set', theme: 'dark', language: 'en' });
  assert.equal(prefsSet.ok, true);
  assert.equal(prefsSet.prefs.theme, 'dark');
  assert.equal(prefsSet.prefs.language, 'en');

  const prefsGet = await callIpc({ command: 'ui_prefs_get' });
  assert.equal(prefsGet.ok, true);
  assert.equal(prefsGet.prefs.theme, 'dark');
  assert.equal(prefsGet.prefs.language, 'en');

  const persistedPrefs = JSON.parse(await readFile(join(dataDir, 'ui-prefs.json'), 'utf8'));
  assert.equal(persistedPrefs.theme, 'dark');
  assert.equal(persistedPrefs.language, 'en');

  for (const legacyCmd of [
    { command: 'quota_probe_live' },
    { command: 'quota_refresh' },
    { command: 'quota_refresh_all' },
    { command: 'auto_switch_best' },
    { command: 'hud_set', enabled: false },
    { command: 'pause' },
    { command: 'resume' },
    { command: 'launch_antigravity', safeRelaunch: true },
  ]) {
    const reply = await callIpc(legacyCmd);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'PURE_LOCAL_READ_ONLY');
    assert.equal(reply.readOnlyMode, true);
  }

  for (const blocked of [
    { command: 'account_switch', id: 'acc-1' },
    { command: 'maintenance_clear', token: 't', selectedNames: ['Cache'] },
    { command: 'auto_switch_best', execute: true, confirmed: true },
  ]) {
    const reply = await callIpc(blocked);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'READ_ONLY_UNSUPPORTED');
  }

  assert.deepEqual(await readdir(stateDir), ['pricing-preferences.json']);
  assert.deepEqual(await readdir(dataDir), ['ui-prefs.json']);

  assert.ok(client.getStdoutLines().length >= 12);
  const exitResult = await client.close();
  assert.equal(exitResult.code, 0);
});

test('Self-contained plugin install runs isolated and cleans legacy gravitybox safely', { timeout: 30000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agy-mcp-installed-'));
  const defaults = getDefaultPluginPaths(tempRoot);
  const installedDir = defaults.dest;
  const legacyDir = defaults.legacyDir;
  const dataDir = join(tempRoot, 'plugin-data');
  const geminiDir = join(tempRoot, 'gemini');
  await mkdir(geminiDir, { recursive: true });
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, 'plugin.json'), JSON.stringify({ name: 'gravitybox', version: '1.1.3' }), 'utf8');

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const info = await installPlugin({ homeDir: tempRoot, build: false });
  assert.equal(info.dest, installedDir);
  assert.equal(info.removedLegacyDir, legacyDir);
  assert.equal(existsSync(legacyDir), false);
  assert.equal(existsSync(join(installedDir, 'plugin.json')), true);
  assert.equal(existsSync(join(installedDir, 'mcp_config.json')), true);
  assert.equal(existsSync(join(installedDir, 'ui', 'mcp-app.html')), true);
  assert.equal(existsSync(join(installedDir, 'backend', 'package.json')), true);
  assert.equal(existsSync(join(installedDir, 'backend', 'dist', 'usage-core.js')), true);
  assert.equal(existsSync(join(installedDir, 'backend', 'assets', 'i18n', 'zh-Hans.json')), true);
  assert.equal(existsSync(join(installedDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')), true);

  const client = createStdioMcpClient(
    join(installedDir, 'bin', 'server.mjs'),
    [
      '--data-dir', dataDir,
      '--state-dir', dataDir,
      '--gemini-dir', geminiDir,
      '--app', join(tempRoot, 'missing-antigravity'),
      '--profile', join(tempRoot, 'missing-profile'),
    ],
    {
      GRAVITYBOX_HOME_DIR: tempRoot,
      GRAVITYBOX_APP_SUPPORT_DIR: tempRoot,
    }
  );
  t.after(async () => {
    await client.close();
  });

  const init = await client.request('initialize', {
    protocolVersion: '2025-11-21',
    capabilities: {},
    clientInfo: { name: 'agy-usage-installed-test', version: '1.0.0' },
  });
  assert.equal(init.serverInfo?.name, 'agy-usage');
  client.notify('notifications/initialized', {});

  const htmlRes = await client.request('resources/read', { uri: 'ui://agy-usage/app.html' });
  assert.equal(htmlRes.contents[0].mimeType, 'text/html;profile=mcp-app');

  const scanRes = await client.request('tools/call', {
    name: 'agy_usage_ipc',
    arguments: { payload: { command: 'maintenance_scan' } },
  });
  assert.equal(scanRes.structuredContent.ok, true);

  const exitRes = await client.close();
  assert.equal(exitRes.code, 0);
});

test('MCP drops an oversized stdio frame before parsing', { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, [join(pluginDir, 'bin', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.on('error', () => {});
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.write(Buffer.alloc(1024 * 1024 + 1, 0x20));
  assert.equal(await closed, 0);
});

test('installPlugin preserves rollback backups on rejected destination and cleans only after swap succeeds', { timeout: 30000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agy-mcp-backup-preserve-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const defaults = getDefaultPluginPaths(tempRoot);
  const installedDir = defaults.dest;
  const stageRoot = join(tempRoot, '.gemini', 'config', '.agy-usage-install-stage');
  const oldBackup = join(stageRoot, 'stage-1000-2000-previous');
  const oldBackupManifest = join(oldBackup, 'plugin.json');
  const oldBackupContent = JSON.stringify({ name: 'agy-usage', version: '0.8.0' });
  await mkdir(oldBackup, { recursive: true });
  await writeFile(oldBackupManifest, oldBackupContent, 'utf8');
  await writeFile(join(oldBackup, 'mcp_config.json'), '{}', 'utf8');

  // Case 1: other plugin in dest -> reject & preserve backup
  await mkdir(installedDir, { recursive: true });
  const otherManifest = JSON.stringify({ name: 'other-plugin', version: '1.0.0' });
  await writeFile(join(installedDir, 'plugin.json'), otherManifest, 'utf8');

  await assert.rejects(
    installPlugin({ homeDir: tempRoot, build: false }),
    /does not contain an agy-usage installation/i
  );
  assert.equal(await readFile(join(installedDir, 'plugin.json'), 'utf8'), otherManifest);
  assert.equal(await readFile(oldBackupManifest, 'utf8'), oldBackupContent);

  // Case 2: regular file in dest -> reject & preserve backup
  await rm(installedDir, { recursive: true, force: true });
  await writeFile(installedDir, 'regular-file-blocker', 'utf8');

  await assert.rejects(
    installPlugin({ homeDir: tempRoot, build: false }),
    /Invalid plugin destination/i
  );
  assert.equal(await readFile(installedDir, 'utf8'), 'regular-file-blocker');
  assert.equal(await readFile(oldBackupManifest, 'utf8'), oldBackupContent);

  // Case 3: valid agy-usage in dest -> install succeeds & cleans stale backup
  await rm(installedDir, { force: true });
  await mkdir(installedDir, { recursive: true });
  await writeFile(join(installedDir, 'plugin.json'), JSON.stringify({ name: 'agy-usage', version: '0.9.0' }), 'utf8');

  const info = await installPlugin({ homeDir: tempRoot, build: false });
  assert.equal(info.dest, installedDir);
  assert.equal(existsSync(oldBackup), false);
  assert.equal(existsSync(stageRoot), false);
  assert.deepEqual(await readdir(defaults.pluginsRoot), ['agy-usage']);
});

test('installPlugin preserves backup manifests when swap and rollback both fail', { timeout: 30000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agy-mcp-rollback-fail-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const defaults = getDefaultPluginPaths(tempRoot);
  const installedDir = defaults.dest;
  const stageRoot = join(tempRoot, '.gemini', 'config', '.agy-usage-install-stage');
  const oldBackup = join(stageRoot, 'stage-1000-2000-previous');
  await mkdir(oldBackup, { recursive: true });
  await writeFile(join(oldBackup, 'plugin.json'), JSON.stringify({ name: 'agy-usage', version: '0.7.0' }), 'utf8');

  await mkdir(installedDir, { recursive: true });
  await writeFile(join(installedDir, 'plugin.json'), JSON.stringify({ name: 'agy-usage', version: '0.9.0' }), 'utf8');
  await writeFile(join(installedDir, 'mcp_config.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
  await writeFile(join(installedDir, 'marker.txt'), 'original-install', 'utf8');

  let calls = 0;
  let capturedBackup = '';
  await assert.rejects(
    installPlugin({
      homeDir: tempRoot,
      build: false,
      _rename: async (from, to) => {
        calls++;
        if (calls === 1) {
          capturedBackup = to;
          return rename(from, to);
        }
        if (calls === 2) throw new Error('simulated swap error');
        if (calls === 3) throw new Error('simulated rollback error');
        return rename(from, to);
      },
    }),
    (err) => err.message.includes(capturedBackup) && /rollback failed/i.test(err.message)
  );
  assert.equal(existsSync(join(capturedBackup, 'plugin.json')), true);
  assert.equal(existsSync(join(capturedBackup, 'mcp_config.json')), true);
  assert.equal(existsSync(join(capturedBackup, '.agy-usage-managed-backup.json')), false);
  assert.equal(await readFile(join(capturedBackup, 'marker.txt'), 'utf8'), 'original-install');
  assert.equal(existsSync(join(oldBackup, 'plugin.json')), true);
});

test('installPlugin never cleans sibling dirs in custom dest', { timeout: 30000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agy-mcp-custom-dest-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Scenario A: Custom destination must never scan or delete sibling directories in parentDir
  const customRoot = join(tempRoot, 'custom');
  const customDest = join(customRoot, 'agy-usage');
  const customOtherTool = join(customRoot, 'stage-other-tool-previous');
  const customNumericDir = join(customRoot, 'stage-123-456-previous');
  await mkdir(customDest, { recursive: true });
  await writeFile(join(customDest, 'plugin.json'), JSON.stringify({ name: 'agy-usage', version: '0.9.0' }), 'utf8');
  await mkdir(customOtherTool, { recursive: true });
  await mkdir(customNumericDir, { recursive: true });
  await writeFile(join(customOtherTool, 'keep.txt'), 'other-tool-data', 'utf8');
  await writeFile(join(customNumericDir, 'keep.txt'), 'unrelated-numeric-data', 'utf8');

  await installPlugin({ dest: customDest, build: false });
  assert.equal(await readFile(join(customOtherTool, 'keep.txt'), 'utf8'), 'other-tool-data');
  assert.equal(await readFile(join(customNumericDir, 'keep.txt'), 'utf8'), 'unrelated-numeric-data');
});

test('installPlugin cleans only verified agy-usage backups inside sibling stage', { timeout: 30000 }, async (t) => {
  const homeRoot = await mkdtemp(join(tmpdir(), 'agy-mcp-stage-proof-'));
  t.after(async () => {
    await rm(homeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Scenario B: Inside .agy-usage-install-stage, clean only exact-format + verified agy-usage backups
  const stageRoot = join(homeRoot, '.gemini', 'config', '.agy-usage-install-stage');
  const stageOtherTool = join(stageRoot, 'stage-other-tool-previous');
  const stageUnproven = join(stageRoot, 'stage-999-999-previous');
  const stageVerifiedManifest = join(stageRoot, 'stage-111-222-previous');
  const stageVerifiedMarker = join(stageRoot, 'stage-333-444-previous');
  const stageVerifiedPkg = join(stageRoot, 'stage-555-666-previous');
  const stageConflictingManifest = join(stageRoot, 'stage-777-888-previous');

  await mkdir(stageOtherTool, { recursive: true });
  await writeFile(join(stageOtherTool, 'keep.txt'), 'keep-other-tool', 'utf8');
  await mkdir(stageUnproven, { recursive: true });
  await writeFile(join(stageUnproven, 'keep.txt'), 'keep-unproven', 'utf8');
  await mkdir(stageVerifiedManifest, { recursive: true });
  await writeFile(join(stageVerifiedManifest, 'plugin.json'), JSON.stringify({ name: 'agy-usage' }), 'utf8');
  await mkdir(stageVerifiedMarker, { recursive: true });
  await writeFile(
    join(stageVerifiedMarker, '.agy-usage-managed-backup.json'),
    JSON.stringify({ managedBy: 'agy-usage-installer', plugin: 'agy-usage' }),
    'utf8'
  );
  await mkdir(join(stageVerifiedPkg, 'backend'), { recursive: true });
  await writeFile(join(stageVerifiedPkg, 'package.json'), JSON.stringify({ name: 'agy-usage-mcp-plugin' }), 'utf8');
  await writeFile(join(stageVerifiedPkg, 'backend', 'package.json'), JSON.stringify({ name: 'agy-usage-backend' }), 'utf8');
  await mkdir(stageConflictingManifest, { recursive: true });
  await writeFile(join(stageConflictingManifest, 'plugin.json'), JSON.stringify({ name: 'other-plugin' }), 'utf8');
  await writeFile(
    join(stageConflictingManifest, '.agy-usage-managed-backup.json'),
    JSON.stringify({ managedBy: 'agy-usage-installer', plugin: 'agy-usage' }),
    'utf8'
  );

  await installPlugin({ homeDir: homeRoot, build: false });
  assert.equal(existsSync(stageVerifiedManifest), false);
  assert.equal(existsSync(stageVerifiedMarker), false);
  assert.equal(existsSync(stageVerifiedPkg), false);
  assert.equal(await readFile(join(stageOtherTool, 'keep.txt'), 'utf8'), 'keep-other-tool');
  assert.equal(await readFile(join(stageUnproven, 'keep.txt'), 'utf8'), 'keep-unproven');
  assert.equal(existsSync(join(stageConflictingManifest, 'plugin.json')), true);
});

test('installPlugin marks locked backup with managed marker and cleans it on next install', { timeout: 30000 }, async (t) => {
  const homeRoot = await mkdtemp(join(tmpdir(), 'agy-mcp-locked-backup-'));
  t.after(async () => {
    await rm(homeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const defaults = getDefaultPluginPaths(homeRoot);
  const stageRoot = join(homeRoot, '.gemini', 'config', '.agy-usage-install-stage');
  await mkdir(defaults.dest, { recursive: true });
  await writeFile(join(defaults.dest, 'plugin.json'), JSON.stringify({ name: 'agy-usage', version: '0.9.0' }), 'utf8');
  await writeFile(join(defaults.dest, 'mcp_config.json'), '{}', 'utf8');

  // Scenario C: Locked backup on successful swap strips manifests + writes managed marker, then next install cleans it
  await installPlugin({
    homeDir: homeRoot,
    build: false,
    _rm: async (targetPath, opts) => {
      if (targetPath.endsWith('-previous')) {
        const err = new Error('simulated EBUSY');
        err.code = 'EBUSY';
        throw err;
      }
      return rm(targetPath, opts);
    },
  });
  const stageEntries = await readdir(stageRoot);
  const retainedName = stageEntries.find((name) => /^stage-\d+-\d+-previous$/.test(name));
  assert.ok(retainedName, 'Locked backup directory must be retained');
  const retainedDir = join(stageRoot, retainedName);
  assert.equal(existsSync(join(retainedDir, 'plugin.json')), false);
  assert.equal(existsSync(join(retainedDir, 'mcp_config.json')), false);
  assert.deepEqual(
    JSON.parse(await readFile(join(retainedDir, '.agy-usage-managed-backup.json'), 'utf8')),
    { managedBy: 'agy-usage-installer', plugin: 'agy-usage' }
  );

  await installPlugin({ homeDir: homeRoot, build: false });
  assert.equal(existsSync(retainedDir), false, 'Previously locked marked backup must be cleaned on next install');
  assert.equal(existsSync(stageRoot), false, 'Empty .agy-usage-install-stage should be removed');
});

test('packagePluginZip builds verifiable cross-platform archive with exact 34 backend modules and zero .git', { timeout: 30000 }, async (t) => {
  const pkgResult = await packagePluginZip({ rebuild: false });
  assert.equal(existsSync(pkgResult.zipPath), true);
  assert.equal(existsSync(pkgResult.sumsPath), true);
  assert.equal(pkgResult.backendModuleCount, 34);

  const zipBuf = await readFile(pkgResult.zipPath);
  const actualSha = createHash('sha256').update(zipBuf).digest('hex');
  const sumsText = await readFile(pkgResult.sumsPath, 'utf8');
  assert.equal(sumsText.trim(), `${actualSha}  ${pkgResult.zipName}`);

  const entries = parseZipEntries(zipBuf);
  const names = new Set(entries.map((e) => e.name));
  assert.equal(names.has('plugin.json'), true);
  assert.equal(names.has('ui/mcp-app.html'), true);
  assert.equal(names.has('LICENSE'), true);
  assert.equal(entries.some((e) => /(?:^|\/)\.git(?:\/|$)/.test(e.name)), false, 'ZIP must never contain .git');
  const expectedDosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    assert.equal(entry.dosTime, 0, `Deterministic UTC midnight time expected for ${entry.name}`);
    assert.equal(entry.dosDate, expectedDosDate, `Deterministic 2026-01-01 date expected for ${entry.name}`);
    assert.equal(
      entry.posixMode,
      entry.name === 'bin/server.mjs' ? 0o100755 : 0o100644,
      `Unexpected POSIX mode for ${entry.name}`
    );
  }

  const backendJs = entries
    .filter((e) => e.name.startsWith('backend/dist/') && e.name.endsWith('.js'))
    .map((e) => e.name.slice('backend/dist/'.length))
    .sort();
  assert.equal(backendJs.length, 34);
  assert.deepEqual(backendJs, [...ALLOWED_BACKEND_MODULES].sort());

  // Verify real OS extraction on Windows (tar -xf) or POSIX (unzip) when available
  const extractDir = await mkdtemp(join(tmpdir(), 'agy-zip-extract-'));
  t.after(async () => {
    await rm(extractDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', pkgResult.zipPath, '-C', extractDir], { stdio: 'ignore' });
  } else {
    execFileSync('unzip', ['-q', pkgResult.zipPath, '-d', extractDir], { stdio: 'ignore' });
  }
  assert.equal(existsSync(join(extractDir, 'plugin.json')), true);
  assert.equal(existsSync(join(extractDir, 'ui', 'mcp-app.html')), true);
  assert.equal(existsSync(join(extractDir, 'LICENSE')), true);
});

test('packagePluginZip rejects bundles with unreferenced files inside backend/dist', { timeout: 30000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agy-zip-parity-'));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const bundleDir = join(tempRoot, 'bundle');
  const outDir = join(tempRoot, 'out');
  const defaultArtifactsBundle = join(repoRoot, 'artifacts', 'agy-usage');
  if (existsSync(join(defaultArtifactsBundle, 'plugin.json'))) {
    await cp(defaultArtifactsBundle, bundleDir, { recursive: true });
  } else {
    await installPlugin({ dest: bundleDir, build: false });
  }

  const extraModulePath = join(bundleDir, 'backend', 'dist', 'unreferenced-extra.js');
  await writeFile(extraModulePath, 'export const unused = true;\n', 'utf8');

  await assert.rejects(
    packagePluginZip({ bundleDir, outDir, rebuild: false }),
    /parity check failed.*unreferenced-extra\.js/i
  );
  assert.equal(existsSync(outDir), false, 'ZIP output directory must not be written when parity check fails');

  await rm(extraModulePath, { force: true });
  const cleanPkg = await packagePluginZip({ bundleDir, outDir, rebuild: false });
  assert.equal(cleanPkg.backendModuleCount, 34);
  assert.equal(existsSync(cleanPkg.zipPath), true);
  assert.equal(existsSync(cleanPkg.sumsPath), true);
});

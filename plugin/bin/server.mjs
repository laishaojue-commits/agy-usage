#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// CRITICAL: Guard stdio before importing any backend module so process.stdout carries only MCP JSON-RPC frames.
const redirectToStderr = (...args) => console.error(...args);
console.log = redirectToStderr;
console.info = redirectToStderr;
console.debug = redirectToStderr;

const UI_RESOURCE_URI = 'ui://agy-usage-tool/app.html';
const VALID_VIEWS = new Set(['overview', 'context', 'usage', 'storage', 'settings', 'about']);
const VALID_THEMES = new Set(['system', 'light', 'dark']);
const MAX_UI_HTML_BYTES = 10 * 1024 * 1024;
const PURE_LOCAL_DISABLED_COMMANDS = new Set([
  'quota_probe_live',
  'quota_refresh',
  'quota_refresh_all',
  'auto_switch_best',
  'pause',
  'resume',
  'restore',
  'reapply',
  'hud_set',
  'launch_antigravity',
  'pricing_sync_check',
  'pricing_sync_set',
]);

const hereDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(hereDir, '..');

function resolveBackendLayout() {
  const installedDist = join(pluginRoot, 'backend', 'dist');
  if (existsSync(join(installedDist, 'read-only-gate.js'))) {
    return {
      distDir: installedDist,
      pkgJsonPath: join(pluginRoot, 'backend', 'package.json'),
      defaultHtmlPath: join(pluginRoot, 'ui', 'mcp-app.html'),
    };
  }
  const repoRoot = resolve(pluginRoot, '..');
  return {
    distDir: join(repoRoot, 'dist'),
    pkgJsonPath: join(repoRoot, 'package.json'),
    defaultHtmlPath: join(repoRoot, 'ui', 'dist-mcp', 'mcp-app.html'),
  };
}

function parseCliArgs(argv) {
  const opts = {
    dataDir: undefined,
    stateDir: undefined,
    geminiDir: undefined,
    appPath: undefined,
    profileDir: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readVal = (prefix) => {
      if (arg.startsWith(prefix + '=')) return arg.slice(prefix.length + 1);
      if (arg === prefix && i + 1 < argv.length) {
        i++;
        return argv[i];
      }
      return undefined;
    };
    const dataDir = readVal('--data-dir') ?? readVal('--data_dir');
    if (dataDir !== undefined) {
      opts.dataDir = dataDir;
      continue;
    }
    const stateDir = readVal('--state-dir');
    if (stateDir !== undefined) {
      opts.stateDir = stateDir;
      continue;
    }
    const geminiDir = readVal('--gemini-dir');
    if (geminiDir !== undefined) {
      opts.geminiDir = geminiDir;
      continue;
    }
    const appPath = readVal('--app');
    if (appPath !== undefined) {
      opts.appPath = appPath;
      continue;
    }
    const profileDir = readVal('--profile');
    if (profileDir !== undefined) {
      opts.profileDir = profileDir;
    }
  }
  return opts;
}

const layout = resolveBackendLayout();
const cli = parseCliArgs(process.argv.slice(2));

function importBackend(fileName) {
  return import(pathToFileURL(join(layout.distDir, fileName)).href);
}

const [
  gateMod,
  inputMod,
  usageMod,
  contextMod,
  maintenanceMod,
  i18nMod,
  filesMod,
  projectionsMod,
  pricingMod,
  pathsMod,
] = await Promise.all([
  importBackend('read-only-gate.js'),
  importBackend('safe-input.js'),
  importBackend('usage-core.js'),
  importBackend('conversation-context.js'),
  importBackend('maintenance-core.js'),
  importBackend('i18n.js'),
  importBackend('files.js'),
  importBackend('usage-projections.js'),
  importBackend('pricing.js'),
  importBackend('platform/paths.js'),
]);

const {
  isReadOnlyBlockedRequest,
  readOnlyBlockedError,
} = gateMod;
const { assertSafeJson, parseSafeJson, SAFE_CONVERSATION_ID_RE, MAX_MESSAGE_BYTES } = inputMod;
const { LocalUsageStatsManager } = usageMod;
const { ConversationContextService } = contextMod;
const { LocalCacheMaintenance } = maintenanceMod;
const { bt } = i18nMod;
const { atomicJson, sanitizeError } = filesMod;
const {
  projectAllUsagePeriodSummaries,
  projectUsagePeriodSummary,
} = projectionsMod;
const { resolvePricingCatalogSnapshot } = pricingMod;
const {
  defaultAntigravityAppDirs,
  defaultAntigravityProfileDir,
  defaultCacheDir,
  defaultStateDir,
  isWindows,
} = pathsMod;

const pkgVersion = await readFile(layout.pkgJsonPath, 'utf8')
  .then((raw) => JSON.parse(raw).version || '0.1.1')
  .catch(() => '0.1.1');

const dataDir = resolve(
  cli.dataDir || process.env.GRAVITYBOX_DATA_DIR || join(defaultStateDir(), 'agy-usage-tool')
);
const stateDir = resolve(
  cli.stateDir || process.env.GRAVITYBOX_STATE_DIR || defaultStateDir()
);
const geminiDir = resolve(
  cli.geminiDir || process.env.GRAVITYBOX_GEMINI_DIR || process.env.GEMINI_DIR || join(homedir(), '.gemini')
);
const readOnlyMode = true;
const uiPrefsPath = join(dataDir, 'ui-prefs.json');

function sanitizeUiPrefs(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const theme = VALID_THEMES.has(obj.theme) ? obj.theme : 'system';
  return {
    theme,
    ...(typeof obj.updatedAt === 'string' ? { updatedAt: obj.updatedAt } : {}),
  };
}

async function readPreferenceFile() {
  try {
    if (!(await lstat(uiPrefsPath)).isFile()) return null;
    const handle = await open(uiPrefsPath, 'r');
    try {
      const data = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      return bytesRead >= data.length ? null : parseSafeJson(data.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

let runtimeCtxPromise = null;

async function ensureContext() {
  if (runtimeCtxPromise) return runtimeCtxPromise;
  runtimeCtxPromise = (async () => {
    const appPath = cli.appPath || defaultAntigravityAppDirs()[0] || '';
    const profile = cli.profileDir || defaultAntigravityProfileDir();
    const initialPrefs = sanitizeUiPrefs(await readPreferenceFile());
    let cachedUiPrefs = { ...initialPrefs };

    const trashDir = isWindows() ? join(defaultCacheDir(), 'maintenance-trash') : join(homedir(), '.Trash');
    // Disable process probing hooks so storage inspection stays 100% pure local filesystem/SQLite reads.
    const cacheMaintenance = new LocalCacheMaintenance(profile, trashDir, async () => false, {
      stateDir,
      geminiDir,
      appPath,
      browserRunning: async () => false,
    });
    const usageManager = new LocalUsageStatsManager({ stateDir, geminiDir });
    const contextService = new ConversationContextService({ stateDir, geminiDir });
    await usageManager.hydratePricingCatalog().catch(() => {});

    async function buildPricingCatalogPayload() {
      const catalogRaw = await usageManager.getRawPricingCatalog();
      const payload = resolvePricingCatalogSnapshot({
        rawPricingTable: catalogRaw.raw,
        publicPricingKeys: catalogRaw.publicKeys,
        live: null,
        snapshot: null,
        activeAccount: null,
        poolAccounts: [],
      });
      usageManager.setActiveOfficialModels(
        Object.keys(payload.prices),
        payload.unpricedLiveModels.map((m) => m.key)
      );
      return payload;
    }

    async function syncActiveOfficialModelsToUsageManager() {
      try {
        await buildPricingCatalogPayload();
      } catch {}
    }

    async function readUiPrefs() {
      const fresh = await readPreferenceFile();
      if (fresh) cachedUiPrefs = sanitizeUiPrefs(fresh);
      return { ...cachedUiPrefs };
    }

    async function writeUiPrefs(patch) {
      const prev = await readUiPrefs();
      const next = sanitizeUiPrefs({
        ...prev,
        ...(VALID_THEMES.has(patch.theme) ? { theme: patch.theme } : {}),
        updatedAt: new Date().toISOString(),
      });
      await mkdir(dataDir, { recursive: true });
      if (!(await lstat(dataDir)).isDirectory()) throw new Error('Invalid preference directory');
      await atomicJson(uiPrefsPath, next);
      cachedUiPrefs = next;
      return { ...next };
    }

    async function getRuntimeInfoSnapshot() {
      return {
        mode: 'mcp-app',
        platform: process.platform,
        appVersion: pkgVersion,
        readOnlyMode,
        stateDir: '',
        pipeEndpoint: '',
        backendRunning: false,
        backendPid: process.pid,
        nodeVersion: process.version,
        winHelperActive: false,
        antigravityAppPath: '',
        antigravityProfileDir: '',
      };
    }

    async function buildStandaloneStatus() {
      return {
        schema: 1,
        mode: 'mcp-direct',
        message: '纯本地只读模式已就绪',
        windows: 0,
        errors: [],
        rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        locale: 'zh-Hans',
        readOnlyMode,
        platform: process.platform,
        pricingRevision: usageManager.getPricingRevision(),
      };
    }

    async function buildPureLocalDashboard() {
      let usage = null;
      let usageError = '';
      try {
        const [summary] = await Promise.all([
          usageManager.getUsageSummary(),
          syncActiveOfficialModelsToUsageManager(),
        ]);
        const pricing = await usageManager.getActivePricingTable();
        const allPeriodsProjected =
          Array.isArray(summary?.today?.by_model) && Array.isArray(summary?.today_hourly)
            ? projectAllUsagePeriodSummaries(summary)
            : undefined;
        const todayProjected = allPeriodsProjected?.today;
        usage = {
          todayTokens: summary.today.totals.total_tokens,
          totalTokens: summary.all_time.totals.total_tokens,
          estimatedUsd: summary.today.estimated_usd,
          allTimeEstimatedUsd: summary.all_time.estimated_usd,
          requestCount: summary.today.totals.request_count,
          totalRequestCount: summary.all_time.totals.request_count,
          pricingModels: Object.keys(pricing).length,
          todayPricedModels: summary.today.priced_models ?? 0,
          todayUnpricedModels: summary.today.unpriced_models ?? 0,
          unpricedModels: summary.unpriced_models ?? 0,
          pricedModels: summary.priced_models ?? 0,
          databasesScanned: summary.databases_scanned ?? 0,
          databasesDiscovered: summary.databases_discovered ?? 0,
          scanScopeDescription: summary.scan_scope_description ?? '',
          hasError: summary.has_error ?? false,
          failedDatabasesCount: summary.failed_databases_count ?? 0,
          skippedLargeRecords: summary.skipped_large_records ?? 0,
          availability: summary.availability ?? 'complete',
          unknownTimeRecords: summary.unknown_time_records ?? 0,
          unknownTimeTokens: summary.unknown_time_tokens ?? 0,
          databaseDiagnostics: summary.database_diagnostics ?? [],
          ...(todayProjected ? {
            todayHourly: todayProjected.todayHourly,
            todayByModel: todayProjected.byModel,
          } : {}),
          ...(allPeriodsProjected ? { periods: allPeriodsProjected } : {}),
        };
      } catch (err) {
        usageError = sanitizeError(err instanceof Error ? err.message : String(err));
      }
      return {
        ok: true,
        accounts: null,
        usage,
        accountsError: '',
        usageError,
        revision: '',
        generatedAt: new Date().toISOString(),
      };
    }

    async function handleIpcPayload(rawPayload) {
      if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
        return { ok: false, error: bt('main.request_invalid_format') };
      }
      const parsed = rawPayload;
      const command = typeof parsed.command === 'string' ? parsed.command.trim() : '';
      if (!command) {
        return { ok: false, error: bt('main.unknown_command') };
      }

      if (isReadOnlyBlockedRequest({ ...parsed, command }, readOnlyMode)) {
        return readOnlyBlockedError(command);
      }

      if (PURE_LOCAL_DISABLED_COMMANDS.has(command)) {
        return {
          ok: false,
          code: 'PURE_LOCAL_READ_ONLY',
          readOnlyMode: true,
          error:
            'agy-usage-tool 当前运行在纯本地只读模式：已禁用进程探测、OAuth 凭据读取与外部控制命令（仅提供本地 SQLite 用量分析与存储体检）。',
        };
      }

      if (command === 'ping') {
        return { ok: true, pid: process.pid, mode: 'mcp-app' };
      }

      if (command === 'runtime_info') {
        return { ok: true, runtime: await getRuntimeInfoSnapshot() };
      }

      if (command === 'ui_prefs_get') {
        return { ok: true, prefs: await readUiPrefs() };
      }

      if (command === 'ui_prefs_set') {
        if (parsed.theme !== undefined && !VALID_THEMES.has(parsed.theme)) {
          return { ok: false, error: 'Unsupported theme' };
        }
        const prefs = await writeUiPrefs({ theme: parsed.theme });
        return { ok: true, prefs };
      }

      if (command === 'status') {
        return {
          ok: true,
          status: await buildStandaloneStatus(),
          taskRevision: 0,
          runningTasks: 0,
        };
      }

      if (command === 'dashboard_summary') {
        return await buildPureLocalDashboard();
      }

      if (command === 'context_conversations_list') {
        const limit = typeof parsed.limit === 'number' && Number.isFinite(parsed.limit) ? parsed.limit : undefined;
        return {
          ok: true,
          ...(await contextService.listRecentConversations({ limit })),
        };
      }

      if (command === 'context_conversation_detail') {
        const conversationId =
          typeof parsed.conversationId === 'string' && parsed.conversationId.trim()
            ? parsed.conversationId.trim()
            : undefined;
        return {
          ok: true,
          snapshot: await contextService.getConversationContextSnapshot(conversationId),
        };
      }

      if (command === 'usage_summary') {
        const force = Boolean(parsed.force);
        const targetAccountId =
          typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : undefined;
        if (parsed.period === 'session') {
          const rawConvId = typeof parsed.conversationId === 'string' ? parsed.conversationId.trim() : '';
          if (rawConvId && !SAFE_CONVERSATION_ID_RE.test(rawConvId)) {
            return { ok: false, error: 'Invalid conversation ID' };
          }
          const reqConvId = rawConvId ? rawConvId.toLowerCase() : undefined;
          const fam = await contextService.resolveConversationFamily(reqConvId);
          const scopeLabel = fam.rootConversationId
            ? fam.memberCount > 0
              ? `当前对话 · ${fam.title}（含 ${fam.memberCount} 个子智能体）`
              : `当前对话 · ${fam.title}`
            : '暂无活跃对话';
          const sess = await usageManager.getConversationUsageSummary(fam.dbFileNames, {
            scopeLabel,
            forceRefresh: force,
            accountId: targetAccountId,
          });
          return {
            ...projectUsagePeriodSummary(sess.usage, 'session', {
              includeAllPeriods: false,
              sessionHourly: sess.sessionHourly,
              isSingleDay: sess.isSingleDay,
              sessionDateLabel: sess.sessionDateLabel,
            }),
            conversationId: fam.rootConversationId,
            conversationTitle: fam.title,
            memberCount: fam.memberCount,
          };
        }
        const usage = await usageManager.getUsageSummary(force, targetAccountId);
        return projectUsagePeriodSummary(usage, parsed.period, {
          includeAllPeriods: !targetAccountId || targetAccountId === 'all',
        });
      }

      if (command === 'usage_events') {
        const period = ['session', 'today', '7d', '30d', 'all'].includes(String(parsed.period))
          ? String(parsed.period)
          : 'today';
        const targetAccountId =
          typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : undefined;
        if (period === 'session') {
          const rawConvId = typeof parsed.conversationId === 'string' ? parsed.conversationId.trim() : '';
          if (rawConvId && !SAFE_CONVERSATION_ID_RE.test(rawConvId)) {
            return { ok: false, error: 'Invalid conversation ID' };
          }
          const reqConvId = rawConvId ? rawConvId.toLowerCase() : undefined;
          const fam = await contextService.resolveConversationFamily(reqConvId);
          const scopeLabel = fam.rootConversationId ? `当前对话 · ${fam.title}` : '暂无活跃对话';
          return {
            ok: true,
            ...(await usageManager.getConversationUsageEvents(
              fam.dbFileNames,
              String(parsed.query ?? ''),
              Number(parsed.offset),
              Number(parsed.limit),
              Boolean(parsed.force),
              targetAccountId,
              scopeLabel
            )),
          };
        }
        return {
          ok: true,
          ...(await usageManager.getUsageEvents(
            period,
            String(parsed.query ?? ''),
            Number(parsed.offset),
            Number(parsed.limit),
            typeof parsed.snapshotId === 'string' ? parsed.snapshotId : undefined,
            parsed.pinSnapshot === true,
            Boolean(parsed.force),
            targetAccountId
          )),
        };
      }

      if (command === 'usage_ledger_review') {
        return { ok: true, review: await usageManager.ledgerReview() };
      }

      if (command === 'usage_snapshot_release') {
        usageManager.releaseSnapshot(String(parsed.snapshotId ?? ''));
        return { ok: true };
      }

      if (command === 'api_pricing_get') {
        const catalogPayload = await buildPricingCatalogPayload();
        return {
          ok: true,
          ...catalogPayload,
          status: await usageManager.getPricingSyncStatus(),
        };
      }

      if (command === 'pricing_sync_status') {
        await syncActiveOfficialModelsToUsageManager();
        return { ok: true, status: await usageManager.getPricingSyncStatus() };
      }

      if (command === 'maintenance_scan') {
        return await cacheMaintenance.scan({ retentionDays: parsed.retentionDays });
      }

      if (command === 'maintenance_history') {
        return { ok: true, snapshots: await cacheMaintenance.history() };
      }

      return { ok: false, error: bt('main.unknown_command') };
    }

    return {
      usageManager,
      readUiPrefs,
      getRuntimeInfoSnapshot,
      buildStandaloneStatus,
      handleIpcPayload,
    };
  })();
  return runtimeCtxPromise;
}

function resolveHtmlPath() {
  const override = process.env.GRAVITYBOX_MCP_APP_HTML?.trim();
  if (override) return resolve(override);
  return layout.defaultHtmlPath;
}

const server = new Server(
  {
    name: 'agy-usage-tool',
    version: pkgVersion,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: UI_RESOURCE_URI,
        name: 'agy-usage-tool Dashboard',
        description: 'agy-usage-tool 纯本地只读面板（单文件自包含 MCP App）',
        mimeType: 'text/html;profile=mcp-app',
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            permissions: {},
          },
        },
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params?.uri;
  if (uri !== UI_RESOURCE_URI) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${String(uri)}`);
  }
  const htmlPath = resolveHtmlPath();
  let html;
  try {
    const file = await open(htmlPath, 'r');
    try {
      const buf = Buffer.alloc(MAX_UI_HTML_BYTES + 1);
      const { bytesRead } = await file.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_UI_HTML_BYTES) throw new Error('HTML exceeds limit');
      html = buf.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read agy-usage-tool MCP App HTML (${sanitizeError(err?.message || String(err))})`
    );
  }
  if (!html || Buffer.byteLength(html, 'utf8') > MAX_UI_HTML_BYTES) {
    throw new McpError(ErrorCode.InternalError, 'agy-usage-tool MCP App HTML is empty or exceeds 10 MiB limit');
  }
  return {
    contents: [
      {
        uri: UI_RESOURCE_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: html,
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            permissions: {},
          },
        },
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'open_agy_usage_tool',
        title: 'agy-usage-tool',
        description:
          '打开 agy-usage-tool 纯本地只读面板（总览、对话上下文与 Swarm 水位监控、Token/费用统计、存储体检、设置与诊断）。',
        inputSchema: {
          type: 'object',
          properties: {
            view: {
              type: 'string',
              enum: ['overview', 'context', 'usage', 'storage', 'settings', 'about'],
              description: 'Optional initial dashboard tab (defaults to overview).',
            },
            conversationId: {
              type: 'string',
              description: 'Optional conversation UUID to focus when inspecting conversation context.',
            },
          },
          additionalProperties: false,
        },
        _meta: {
          ui: {
            resourceUri: UI_RESOURCE_URI,
            visibility: ['model', 'app'],
          },
          'com.google.antigravity/ui': {
            entrypoints: [
              { type: 'aux_pane', title: 'agy-usage-tool' },
              { type: 'global', title: 'agy-usage-tool' },
            ],
          },
        },
      },
      {
        name: 'agy_usage_tool_ipc',
        title: 'agy-usage-tool IPC Bridge',
        description: 'App-only IPC bridge for agy-usage-tool MCP App dashboard calls.',
        inputSchema: {
          type: 'object',
          properties: {
            payload: {
              type: 'object',
              description: 'IPC payload containing a command string and optional arguments.',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
              additionalProperties: true,
            },
          },
          required: ['payload'],
          additionalProperties: false,
        },
        _meta: {
          ui: {
            visibility: ['app'],
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  const args = request.params?.arguments && typeof request.params.arguments === 'object'
    ? request.params.arguments
    : {};

  try { assertSafeJson(args); } catch { throw new McpError(ErrorCode.InvalidParams, 'Invalid input'); }
  const ctx = await ensureContext();

  if (toolName === 'open_agy_usage_tool') {
    const requestedView = typeof args.view === 'string' ? args.view : 'overview';
    const initialView = VALID_VIEWS.has(requestedView) ? requestedView : 'overview';
    const initialConversationId = args.conversationId;
    if (initialConversationId !== undefined &&
        (typeof initialConversationId !== 'string' || !SAFE_CONVERSATION_ID_RE.test(initialConversationId))) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid conversation ID');
    }
    const [runtimeInfo, uiPrefs] = await Promise.all([
      ctx.getRuntimeInfoSnapshot(),
      ctx.readUiPrefs(),
    ]);
    const summaryText = `agy-usage-tool opened (view: ${initialView}${initialConversationId ? `, conversationId: ${initialConversationId}` : ''}, mode: mcp-app, pureLocalReadOnly: true, readOnlyMode: ${readOnlyMode}, locale: zh-Hans).`;
    return {
      content: [{ type: 'text', text: summaryText }],
      structuredContent: {
        initialView,
        ...(initialConversationId ? { initialConversationId } : {}),
        runtimeInfo,
        uiPrefs,
      },
    };
  }

  if (toolName === 'agy_usage_tool_ipc') {
    try {
      const payload = args.payload;
      const reply = await ctx.handleIpcPayload(payload);
      return {
        content: [{ type: 'text', text: JSON.stringify(reply) }],
        structuredContent: reply,
      };
    } catch (err) {
      const message = sanitizeError(err instanceof Error ? err.message : String(err));
      const errReply = { ok: false, error: message };
      return {
        content: [{ type: 'text', text: JSON.stringify(errReply) }],
        structuredContent: errReply,
      };
    }
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${String(toolName)}`);
});

const shutdown = async () => {
  try {
    const ctx = await runtimeCtxPromise?.catch(() => null);
    ctx?.usageManager?.cancelRead?.();
  } catch {}
  try {
    await server.close();
  } catch {}
  process.exit(0);
};

// Cap each JSON-RPC frame before the SDK accumulates/parses it.
let lineBytes = 0;
const boundedStdin = new Transform({
  transform(chunk, _encoding, callback) {
    for (const byte of chunk) {
      if (byte === 10) lineBytes = 0;
      else if (++lineBytes > MAX_MESSAGE_BYTES) {
        callback(new Error('MCP input frame exceeds limit'));
        return;
      }
    }
    callback(null, chunk);
  },
});
const transport = new StdioServerTransport(boundedStdin);
boundedStdin.on('error', () => void shutdown());
process.stdin.pipe(boundedStdin);
await server.connect(transport);

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.stdin.once('end', () => void shutdown());

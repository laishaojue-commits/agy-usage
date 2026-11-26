import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { IpcBaseReply, IpcDynamicReply, RuntimeInfo } from './types';

export interface McpHostThemeInfo {
  theme?: 'light' | 'dark';
  locale?: string;
  inline?: boolean;
}

export interface McpAppBridgeHandlers {
  onToolInput?: (args: Record<string, unknown>) => void;
  onToolResult?: (structuredContent: Record<string, unknown>) => void;
  onHostContextChanged?: (info: McpHostThemeInfo) => void;
}

const MAX_MCP_TOOLS_IN_FLIGHT = 3;

let mcpApp: App | null = null;
let mcpConnectPromise: Promise<McpHostThemeInfo | null> | null = null;
let mcpHandlers: McpAppBridgeHandlers | undefined;
let cachedMcpRuntime: RuntimeInfo | null = null;
let lastHostTheme: 'light' | 'dark' | null = null;
let mcpToolsInFlight = 0;
const mcpToolWaiters: Array<() => void> = [];

export function isMcpAppRuntime(): boolean {
  if (typeof document === 'undefined') return false;
  const modeMeta = document.querySelector<HTMLMetaElement>('meta[name="gb-runtime-mode"]')?.content?.trim();
  return modeMeta === 'mcp-app' || document.documentElement.dataset.gbMode === 'mcp-app';
}

export function applyMcpThemePreference(theme: 'system' | 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  if (theme === 'light' || theme === 'dark') {
    applyDocumentTheme(theme);
    return;
  }
  if (lastHostTheme) {
    applyDocumentTheme(lastHostTheme);
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
  }
}

async function runWithMcpConcurrencyLimit<R>(task: () => Promise<R>): Promise<R> {
  if (mcpToolsInFlight >= MAX_MCP_TOOLS_IN_FLIGHT) {
    await new Promise<void>((resolve) => mcpToolWaiters.push(resolve));
  }
  mcpToolsInFlight++;
  try {
    return await task();
  } finally {
    mcpToolsInFlight--;
    const next = mcpToolWaiters.shift();
    if (next) next();
  }
}

function syncHostContext(ctx: Partial<McpUiHostContext> | undefined, applyThemeAttr: boolean): McpHostThemeInfo {
  const info: McpHostThemeInfo = {};
  if (!ctx) return info;
  if (ctx.theme === 'light' || ctx.theme === 'dark') {
    lastHostTheme = ctx.theme;
    info.theme = ctx.theme;
    if (applyThemeAttr) {
      applyDocumentTheme(ctx.theme);
    }
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (typeof ctx.locale === 'string' && ctx.locale.trim()) {
    info.locale = ctx.locale.trim();
  }
  const container = ctx.containerDimensions as { maxHeight?: number } | undefined;
  if (typeof document !== 'undefined') {
    if (typeof container?.maxHeight === 'number') {
      info.inline = true;
      document.documentElement.setAttribute('data-gb-inline', '1');
    } else if (ctx.containerDimensions) {
      info.inline = false;
      document.documentElement.removeAttribute('data-gb-inline');
    }
  }
  return info;
}

export async function initMcpAppBridge(handlers?: McpAppBridgeHandlers): Promise<McpHostThemeInfo | null> {
  if (!isMcpAppRuntime()) return null;
  if (handlers) mcpHandlers = handlers;
  if (!mcpConnectPromise) {
    mcpConnectPromise = (async () => {
      const app = new App({ name: 'agy-usage-tool', version: '0.1.0' }, {});
      mcpApp = app;

      // Register notification handlers strictly before connect() so initial notifications are never missed.
      app.ontoolinput = (params) => {
        const args = params?.arguments;
        if (args && typeof args === 'object') {
          mcpHandlers?.onToolInput?.(args);
        }
      };
      app.ontoolresult = (result) => {
        const sc = result?.structuredContent;
        if (sc && typeof sc === 'object') {
          const runtime = (sc as { runtimeInfo?: RuntimeInfo }).runtimeInfo;
          if (runtime && typeof runtime === 'object') {
            cachedMcpRuntime = runtime;
          }
          mcpHandlers?.onToolResult?.(sc as Record<string, unknown>);
        }
      };
      app.onhostcontextchanged = (ctx) => {
        const info = syncHostContext(ctx, false);
        mcpHandlers?.onHostContextChanged?.(info);
      };

      await app.connect();
      return syncHostContext(app.getHostContext(), true);
    })().catch((err) => {
      mcpConnectPromise = null;
      mcpApp = null;
      throw err;
    });
  }
  return mcpConnectPromise;
}

export async function ipcCall<T extends IpcBaseReply = IpcDynamicReply>(
  payload: Record<string, unknown>
): Promise<T> {
  if (!mcpApp) {
    await initMcpAppBridge(mcpHandlers);
  }
  const activeApp = mcpApp;
  if (!activeApp) {
    throw new Error('MCP App connection unavailable');
  }
  const result = await runWithMcpConcurrencyLimit(() =>
    activeApp.callServerTool({
      name: 'agy_usage_tool_ipc',
      arguments: { payload },
    })
  );
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as T;
  }
  const textBlock = Array.isArray(result?.content)
    ? result.content.find(
        (item): item is { type: 'text'; text: string } =>
          item?.type === 'text' && typeof (item as { text?: unknown }).text === 'string'
      )
    : undefined;
  if (textBlock?.text) {
    try {
      return JSON.parse(textBlock.text) as T;
    } catch {
      return { ok: !result?.isError, error: textBlock.text } as T;
    }
  }
  if (result?.isError) {
    return { ok: false, error: 'MCP tool call failed' } as T;
  }
  throw new Error('Invalid MCP IPC reply');
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (cachedMcpRuntime) return cachedMcpRuntime;
  const res = await ipcCall<{ ok: boolean; runtime?: RuntimeInfo; error?: string }>({ command: 'runtime_info' });
  if (!res.ok || !res.runtime) {
    throw new Error(res.error || 'Runtime info unavailable');
  }
  cachedMcpRuntime = res.runtime;
  return res.runtime;
}

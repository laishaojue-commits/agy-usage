export type ViewId = 'overview' | 'context' | 'usage' | 'storage' | 'settings' | 'about';

export type UiMode = 'mcp-app';

export interface UiCapabilities {
  mode: UiMode;
  brandTitle: string;
  visibleViews: readonly ViewId[];
  defaultView: ViewId;
}

const MCP_APP_CAPABILITIES: UiCapabilities = Object.freeze({
  mode: 'mcp-app',
  brandTitle: 'agy-usage-tool',
  visibleViews: Object.freeze(['overview', 'context', 'usage', 'storage', 'settings', 'about'] as const),
  defaultView: 'overview',
});

/** Returns the pure local read-only MCP App UI capability profile. */
export function getUiCapabilities(_mode: UiMode = 'mcp-app'): UiCapabilities {
  return MCP_APP_CAPABILITIES;
}

/** Resolves a requested view against visibleViews, falling back to defaultView when hidden or invalid. */
export function resolveAllowedView(
  view: string | null | undefined,
  capabilities: UiCapabilities = MCP_APP_CAPABILITIES
): ViewId {
  if (typeof view === 'string' && (capabilities.visibleViews as readonly string[]).includes(view)) {
    return view as ViewId;
  }
  return capabilities.defaultView;
}

import { isWindows } from './platform/paths.js';
import { join, relative, resolve, sep } from 'node:path';
import { bt } from './i18n.js';

export type CacheCategory = 'safe' | 'stateful';
export type CacheSection = 'runtime' | 'history';

export interface CacheItemMetadata {
  title: string;
  subtitle: string;
  icon: string;
  category: CacheCategory;
  section?: CacheSection;
  defaultSelected: boolean;
  impactWarning?: string;
}

// 核心常驻无损缓存（始终展示，默认勾选）
export const CACHE_NAMES = ['Cache', 'Code Cache', 'GPUCache'] as const;

// 扩展无损加速与废弃垃圾缓存（存在时自动发现并纳入，默认勾选，应删尽删）
export const EXTENDED_CACHE_NAMES = [
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'CachedData',
  'CachedExtensionVSIXs',
  'CachedProfilesData',
  'Crashpad',
  'logs',
  'blob_storage',
] as const;

// 多路径聚合无损缓存与孤儿残留（存在非零体积或受阻时纳入分组 1，默认勾选）
export const MULTI_SAFE_CACHE_NAMES = [
  'PartitionsCache',
  'AgentBrowserCache',
  'OrphanAgentData',
] as const;

// Agent 历史深度瘦身项（分组 2，按保留天数扫描，默认不勾选，供用户按需勾选）
export const HISTORY_SLIMMING_NAMES = [
  'AgentTaskStepLogs',
  'AgentVerboseTranscripts',
  'AgentSubagentDatabases',
] as const;

// 受保护的会话、站点存储与网络授权状态目录（严禁纳入清理，仅作只读保护统计）
export const STATEFUL_CACHE_NAMES = [
  'Service Worker',
  'Session Storage',
  'WebStorage',
  'Local Storage',
  'Cookies',
  'Network Persistent State',
] as const;

export const ALL_SAFE_CACHE_NAMES = [
  ...CACHE_NAMES,
  ...EXTENDED_CACHE_NAMES,
  ...MULTI_SAFE_CACHE_NAMES,
] as const;

export const ALL_ALLOWED_CACHE_NAMES = [
  ...ALL_SAFE_CACHE_NAMES,
  ...HISTORY_SLIMMING_NAMES,
] as const;

export const PARTITION_SAFE_SUBDIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'blob_storage',
] as const;

export const BROWSER_TOP_SAFE_SUBDIRS = [
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'component_crx_cache',
  'WasmTtsEngine',
  'Crashpad',
] as const;

export const BROWSER_PROFILE_SAFE_SUBDIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'blob_storage',
  join('Service Worker', 'CacheStorage'),
  join('Service Worker', 'ScriptCache'),
] as const;

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRetentionDays(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const rounded = Math.max(0, Math.min(365, Math.floor(raw)));
    return rounded;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(365, Math.floor(parsed)));
    }
  }
  return 7;
}

export const MAINTENANCE_SCOPES = ['runtime_cache', 'history_logs'] as const;
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number];

export function normalizeMaintenanceScopes(raw: unknown): MaintenanceScope[] {
  if (raw === undefined) {
    return ['runtime_cache'];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Error(bt('maintenance.err.invalid_selection'));
  }
  const allowed = new Set<string>(MAINTENANCE_SCOPES);
  const selected = new Set<MaintenanceScope>();
  for (const item of raw) {
    if (typeof item !== 'string' || !allowed.has(item)) {
      throw Error(bt('maintenance.err.invalid_selection'));
    }
    selected.add(item as MaintenanceScope);
  }
  return MAINTENANCE_SCOPES.filter(scope => selected.has(scope));
}

export function namesForMaintenanceScopes(scopes: readonly MaintenanceScope[]): string[] {
  const names: string[] = [];
  if (scopes.includes('runtime_cache')) {
    names.push(...ALL_SAFE_CACHE_NAMES);
  }
  if (scopes.includes('history_logs')) {
    names.push(...HISTORY_SLIMMING_NAMES);
  }
  return Array.from(new Set(names));
}

interface CacheCatalogSpec {
  key: string;
  icon: string;
  category: CacheCategory;
  section?: CacheSection;
  defaultSelected: boolean;
  hasImpact?: boolean;
}

const CACHE_CATALOG_SPECS: Record<string, CacheCatalogSpec> = {
  'Cache': { key: 'cache', icon: 'internaldrive', category: 'safe', section: 'runtime', defaultSelected: true },
  'Code Cache': { key: 'code_cache', icon: 'cpu', category: 'safe', section: 'runtime', defaultSelected: true },
  'GPUCache': { key: 'gpu_cache', icon: 'sparkles.rectangle.stack', category: 'safe', section: 'runtime', defaultSelected: true },
  'DawnCache': { key: 'dawn_cache', icon: 'cube.transparent', category: 'safe', section: 'runtime', defaultSelected: true },
  'DawnWebGPUCache': { key: 'dawn_webgpu_cache', icon: 'cube.transparent', category: 'safe', section: 'runtime', defaultSelected: true },
  'DawnGraphiteCache': { key: 'dawn_graphite_cache', icon: 'cube.transparent', category: 'safe', section: 'runtime', defaultSelected: true },
  'GraphiteDawnCache': { key: 'graphite_dawn_cache', icon: 'sparkles.rectangle.stack', category: 'safe', section: 'runtime', defaultSelected: true },
  'ShaderCache': { key: 'shader_cache', icon: 'sparkles.rectangle.stack', category: 'safe', section: 'runtime', defaultSelected: true },
  'CachedData': { key: 'cached_data', icon: 'memorychip', category: 'safe', section: 'runtime', defaultSelected: true },
  'CachedExtensionVSIXs': { key: 'cached_vsix', icon: 'shippingbox', category: 'safe', section: 'runtime', defaultSelected: true },
  'CachedProfilesData': { key: 'cached_profiles', icon: 'doc.badge.gearshape', category: 'safe', section: 'runtime', defaultSelected: true },
  'Crashpad': { key: 'crashpad', icon: 'exclamationmark.triangle', category: 'safe', section: 'runtime', defaultSelected: true },
  'logs': { key: 'logs', icon: 'doc.text', category: 'safe', section: 'runtime', defaultSelected: true },
  'blob_storage': { key: 'blob_storage', icon: 'archivebox', category: 'safe', section: 'runtime', defaultSelected: true },
  'PartitionsCache': { key: 'partitions_cache', icon: 'square.split.2x2', category: 'safe', section: 'runtime', defaultSelected: true },
  'AgentBrowserCache': { key: 'agent_browser_cache', icon: 'globe', category: 'safe', section: 'runtime', defaultSelected: true },
  'OrphanAgentData': { key: 'orphan_agent_data', icon: 'trash.slash', category: 'safe', section: 'runtime', defaultSelected: true },
  'AgentTaskStepLogs': { key: 'task_step_logs', icon: 'terminal', category: 'stateful', section: 'history', defaultSelected: false, hasImpact: true },
  'AgentVerboseTranscripts': { key: 'verbose_transcripts', icon: 'doc.on.doc', category: 'stateful', section: 'history', defaultSelected: false, hasImpact: true },
  'AgentSubagentDatabases': { key: 'subagent_dbs', icon: 'arrow.triangle.branch', category: 'stateful', section: 'history', defaultSelected: false, hasImpact: true },
  'Service Worker': { key: 'service_worker', icon: 'gearshape.2', category: 'stateful', defaultSelected: false, hasImpact: true },
  'Session Storage': { key: 'session_storage', icon: 'rectangle.stack', category: 'stateful', defaultSelected: false, hasImpact: true },
  'WebStorage': { key: 'web_storage', icon: 'globe', category: 'stateful', defaultSelected: false, hasImpact: true },
  'Local Storage': { key: 'local_storage', icon: 'externaldrive.badge.person.crop', category: 'stateful', defaultSelected: false, hasImpact: true },
  'Cookies': { key: 'cookies', icon: 'key.horizontal', category: 'stateful', defaultSelected: false, hasImpact: true },
  'Network Persistent State': { key: 'network_state', icon: 'network', category: 'stateful', defaultSelected: false, hasImpact: true },
};

export function getCacheMetadata(name: string): CacheItemMetadata | undefined {
  const spec = CACHE_CATALOG_SPECS[name];
  if (!spec) return undefined;
  const subtitleKey = spec.key === 'gpu_cache' && isWindows()
    ? 'maintenance.catalog.gpu_cache.sub_win'
    : `maintenance.catalog.${spec.key}.sub`;
  return {
    title: bt(`maintenance.catalog.${spec.key}.title`),
    subtitle: bt(subtitleKey),
    icon: spec.icon,
    category: spec.category,
    ...(spec.section ? { section: spec.section } : {}),
    defaultSelected: spec.defaultSelected,
    ...(spec.hasImpact ? { impactWarning: bt(`maintenance.catalog.${spec.key}.impact`) } : {}),
  };
}

export const CACHE_METADATA: Record<string, CacheItemMetadata> = new Proxy({} as Record<string, CacheItemMetadata>, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(CACHE_CATALOG_SPECS, prop)) {
      return getCacheMetadata(prop);
    }
    return Reflect.get(target, prop, receiver);
  },
  has(_target, prop) {
    return typeof prop === 'string' && Object.prototype.hasOwnProperty.call(CACHE_CATALOG_SPECS, prop);
  },
  ownKeys() {
    return Object.keys(CACHE_CATALOG_SPECS);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(CACHE_CATALOG_SPECS, prop)) {
      return { enumerable: true, configurable: true, value: getCacheMetadata(prop) };
    }
    return undefined;
  },
});

export interface CacheMaintenanceOptions {
  appPath?: string;
  stateDir?: string;
  fallbackTrashDir?: string;
  geminiDir?: string;
  browserRunning?: () => Promise<boolean>;
  archiveDatabases?: (dbPaths: string[]) => Promise<unknown>;
  onMutated?: () => void | Promise<void>;
}

export interface SubTargetSpec {
  path: string;
  isUsageDb?: boolean;
}

export interface InspectedCacheEntry {
  name: string;
  title: string;
  subtitle: string;
  icon: string;
  category: CacheCategory;
  section: CacheSection;
  defaultSelected: boolean;
  impactWarning?: string;
  bytes: number;
  fileCount: number;
  itemCount?: number;
  lastModifiedAt: number;
  exists: boolean;
  clearable: boolean;
  fingerprint: string;
  reason?: string;
  isSingleLegacyRoot: boolean;
  subTargets: SubTargetSpec[];
}

export interface ConversationIndexSnapshot {
  available: boolean;
  summaryMap: Map<string, { parentId: string; status: string }>;
  runningTreeIds: Set<string>;
  archivedTreeIds: Set<string>;
}

export function isStrictSubpath(parentDir: string, candidatePath: string): boolean {
  const rel = relative(resolve(parentDir), resolve(candidatePath));
  return Boolean(rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) && rel !== '.');
}


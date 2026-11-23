import { atomicJson, readBoundedText, readOptionalJson } from './files.js';
import {
  FEED_MODEL_KEYS,
  resetAndRegisterRemoteModelMetadata,
  sanitizeRemoteModelMetadata,
} from './model-catalog.js';
import {
  DEFAULT_API_PRICES,
  PRICING_METADATA,
  isInternalNonChatModelId,
  mergePricingEntries,
  resolvePricingFromTable,
  validateRawPrices,
  type ApiPricing,
  type ApiPricingEntry,
  type ApiPricingInterval,
} from './pricing.js';
import { bt } from './i18n.js';

export interface PricingSyncMutableState {
  lastRemoteSyncAt: number;
  lastSyncSuccess: boolean;
  lastCheckAt: number;
  lastCheckSuccess: boolean;
  nextAutoSyncAt: number;
  lastSyncError: string | null;
  lastSyncedSourceUrl: string;
  lastSyncedVersion: string;
  lastSyncedUpdatedAt?: string;
  lastSyncedEtag?: string;
  lastSyncedSha256?: string;
}

export function compareDatedFeedVersion(left: string, right: string): number | null {
  const pattern = /^(\d{4}-\d{2}-\d{2})(?:[.-]r?(\d+))?$/i;
  const leftMatch = left.trim().match(pattern);
  const rightMatch = right.trim().match(pattern);
  if (!leftMatch || !rightMatch) return null;
  const dateDiff = leftMatch[1]!.localeCompare(rightMatch[1]!);
  if (dateDiff !== 0) return dateDiff;
  const leftRev = leftMatch[2] ? Number.parseInt(leftMatch[2], 10) : 0;
  const rightRev = rightMatch[2] ? Number.parseInt(rightMatch[2], 10) : 0;
  return leftRev - rightRev;
}

export function compareFeedFreshness(
  incoming: { version?: string | null; updatedAt?: string | null },
  baseline: { version?: string | null; updatedAt?: string | null }
): number | null {
  const verDiff = compareDatedFeedVersion(String(incoming.version ?? ''), String(baseline.version ?? ''));
  if (verDiff === null) return null;
  if (verDiff !== 0) return verDiff;
  const inUpdated = typeof incoming.updatedAt === 'string' ? incoming.updatedAt.trim() : '';
  const baseUpdated = typeof baseline.updatedAt === 'string' ? baseline.updatedAt.trim() : '';
  if (inUpdated && baseUpdated) {
    const inMs = Date.parse(inUpdated);
    const baseMs = Date.parse(baseUpdated);
    if (Number.isFinite(inMs) && Number.isFinite(baseMs) && inMs !== baseMs) {
      return inMs > baseMs ? 1 : -1;
    }
  }
  return 0;
}

export async function loadRawPricingTable(
  remotePricingCachePath: string,
  pricingCachePath: string
): Promise<{
  merged: Record<string, ApiPricingEntry>;
  billingPrices: Record<string, ApiPricingEntry>;
  warnings: string[];
  publicKeys: Set<string>;
}> {
  const warnings: string[] = [];
  const merged: Record<string, ApiPricingEntry> = Object.assign(Object.create(null), DEFAULT_API_PRICES);
  const publicKeys = new Set<string>(FEED_MODEL_KEYS);

  // 1. 尝试合并本地远程缓存（禁止早于内置目录日期的旧远端缓存降级覆盖较新的官方目录）
  resetAndRegisterRemoteModelMetadata({});
  try {
    const rawRemote = await readBoundedText(remotePricingCachePath, 2 * 1024 * 1024);
    const parsedRemote = JSON.parse(rawRemote);
    const remotePrices = parsedRemote && typeof parsedRemote === 'object' && parsedRemote.prices ? parsedRemote.prices : parsedRemote;
    const remoteVer = typeof parsedRemote?.feedVersion === 'string' ? parsedRemote.feedVersion.trim() : '';
    const remoteUpdatedAt = typeof parsedRemote?.feedUpdatedAt === 'string'
      ? parsedRemote.feedUpdatedAt.trim()
      : (typeof parsedRemote?.updatedAt === 'string' ? parsedRemote.updatedAt.trim() : '');
    const cmpToBuiltin = compareFeedFreshness(
      { version: remoteVer, updatedAt: remoteUpdatedAt },
      { version: PRICING_METADATA.version, updatedAt: PRICING_METADATA.updatedAt }
    );
    const isOlderDatedFeed = cmpToBuiltin !== null && cmpToBuiltin < 0;
    resetAndRegisterRemoteModelMetadata(parsedRemote, {
      onlyNewEntries: isOlderDatedFeed,
      authoritativeSnapshot: !isOlderDatedFeed,
    });
    const remoteMeta = sanitizeRemoteModelMetadata(parsedRemote);
    const remotePriceObj = remotePrices && typeof remotePrices === 'object' && !Array.isArray(remotePrices)
      ? remotePrices as Record<string, unknown>
      : null;
    if (!isOlderDatedFeed && Array.isArray(remoteMeta.feedModels) && remoteMeta.feedModels.length > 0) {
      const remoteFeedSet = new Set(remoteMeta.feedModels);
      for (const builtinPublicKey of FEED_MODEL_KEYS) {
        if (!remoteFeedSet.has(builtinPublicKey) && (!remotePriceObj || !Object.hasOwn(remotePriceObj, builtinPublicKey))) {
          delete merged[builtinPublicKey];
        }
      }
      publicKeys.clear();
      for (const k of remoteMeta.feedModels) {
        if (!isInternalNonChatModelId(k)) publicKeys.add(k);
      }
    }
    if (remotePriceObj) {
      const filteredRemote = isOlderDatedFeed
        ? Object.fromEntries(Object.entries(remotePriceObj).filter(([k]) => !Object.hasOwn(merged, k)))
        : remotePriceObj;
      const remoteAccepted = new Set<string>();
      mergePricingEntries(merged, filteredRemote, bt('pricing.warn.remote_entry_prefix'), warnings, remoteAccepted);
      for (const k of remoteAccepted) {
        if (!isInternalNonChatModelId(k)) publicKeys.add(k);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(bt('pricing.warn.remote_cache_unreadable'));
    }
  }

  // 2. 尝试合并用户自定义价格缓存（最高优先级）
  try {
    const rawCustom = await readBoundedText(pricingCachePath, 2 * 1024 * 1024);
    const cached = JSON.parse(rawCustom);
    if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
      const customAccepted = new Set<string>();
      mergePricingEntries(merged, cached, bt('pricing.warn.custom_entry_prefix'), warnings, customAccepted);
      for (const k of customAccepted) {
        if (!isInternalNonChatModelId(k)) publicKeys.add(k);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(bt('pricing.warn.custom_unreadable'));
    }
  }

  const billingPrices: Record<string, ApiPricingEntry> = Object.assign(
    Object.create(null),
    DEFAULT_API_PRICES,
    merged
  );

  return { merged, billingPrices, warnings, publicKeys };
}

export function resolvePricingTableFromRaw(
  raw: Record<string, ApiPricingEntry>,
  timestampSeconds = Math.floor(Date.now() / 1000),
  allowedKeys?: Set<string>
): Record<string, ApiPricing> {
  const resolved: Record<string, ApiPricing> = Object.create(null);
  for (const key of Object.keys(raw)) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    const p = resolvePricingFromTable(raw, key, timestampSeconds);
    if (p) resolved[key] = p;
  }
  return resolved;
}

export async function loadPricingSyncState(
  remotePricingCachePath: string,
  pricingSyncStatePath: string,
  state: PricingSyncMutableState
): Promise<void> {
  if (!state.lastRemoteSyncAt) {
    const data = await readOptionalJson<{
      syncedAt?: string;
      sourceUrl?: string;
      feedVersion?: string;
      feedUpdatedAt?: string;
      updatedAt?: string;
      sha256?: string;
    }>(
      remotePricingCachePath,
      'remote-pricing-cache.json'
    );
    if (data?.syncedAt) {
      state.lastRemoteSyncAt = Date.parse(data.syncedAt) || 0;
      state.lastSyncSuccess = true;
      state.lastSyncedSourceUrl = data.sourceUrl ?? '';
      state.lastSyncedVersion = data.feedVersion ?? '';
      state.lastSyncedUpdatedAt = data.feedUpdatedAt ?? data.updatedAt ?? '';
      state.lastSyncedSha256 = typeof data.sha256 === 'string' ? data.sha256 : '';
    }
  }
  const checkData = await readOptionalJson<{
    lastCheckAt?: number;
    lastCheckSuccess?: boolean;
    lastSyncError?: string | null;
    lastSyncedVersion?: string;
    lastSyncedUpdatedAt?: string;
    lastSyncedSourceUrl?: string;
    lastSyncedEtag?: string;
    lastSyncedSha256?: string;
  }>(
    pricingSyncStatePath,
    'pricing-sync-state.json'
  );
  if (checkData && typeof checkData === 'object') {
    if (typeof checkData.lastCheckAt === 'number' && Number.isFinite(checkData.lastCheckAt)) {
      state.lastCheckAt = checkData.lastCheckAt;
    }
    if (typeof checkData.lastCheckSuccess === 'boolean') {
      state.lastCheckSuccess = checkData.lastCheckSuccess;
    }
    if (typeof checkData.lastSyncError === 'string' || checkData.lastSyncError === null) {
      state.lastSyncError = checkData.lastSyncError;
    }
    if (!state.lastSyncedVersion && typeof checkData.lastSyncedVersion === 'string') {
      state.lastSyncedVersion = checkData.lastSyncedVersion;
    }
    if (!state.lastSyncedUpdatedAt && typeof checkData.lastSyncedUpdatedAt === 'string') {
      state.lastSyncedUpdatedAt = checkData.lastSyncedUpdatedAt;
    }
    if (!state.lastSyncedSourceUrl && typeof checkData.lastSyncedSourceUrl === 'string') {
      state.lastSyncedSourceUrl = checkData.lastSyncedSourceUrl;
    }
    if (typeof checkData.lastSyncedEtag === 'string') {
      state.lastSyncedEtag = checkData.lastSyncedEtag;
    }
    if (!state.lastSyncedSha256 && typeof checkData.lastSyncedSha256 === 'string') {
      state.lastSyncedSha256 = checkData.lastSyncedSha256;
    }
  }
  if (!state.nextAutoSyncAt) {
    const lastAttemptAt = Math.max(state.lastCheckAt, state.lastRemoteSyncAt);
    if (lastAttemptAt > 0) {
      const cooldown = state.lastCheckAt > state.lastRemoteSyncAt && !state.lastCheckSuccess ? 300_000 : 86_400_000;
      state.nextAutoSyncAt = lastAttemptAt + cooldown;
    }
  }
}

export function buildPricingSyncStatus(options: {
  autoSyncEnabled: boolean;
  state: PricingSyncMutableState;
  remotePricingUrl: string;
  modelCount: number;
}) {
  const { autoSyncEnabled, state, remotePricingUrl, modelCount } = options;
  const rawVersion = state.lastSyncedVersion || PRICING_METADATA.version;
  const cmpRawToBuiltin = compareDatedFeedVersion(rawVersion, PRICING_METADATA.version);
  const effectiveVersion = cmpRawToBuiltin !== null && cmpRawToBuiltin < 0
    ? PRICING_METADATA.version
    : rawVersion;
  const effectiveCheckAt = Math.max(state.lastCheckAt, state.lastRemoteSyncAt);
  return {
    autoSyncEnabled,
    lastSyncAt: state.lastRemoteSyncAt,
    lastCheckAt: effectiveCheckAt,
    lastSyncSuccess: state.lastSyncSuccess,
    lastCheckSuccess: state.lastCheckAt ? state.lastCheckSuccess : state.lastSyncSuccess,
    lastSyncError: state.lastSyncError,
    feedVersion: effectiveVersion,
    sourceUrl: state.lastSyncedSourceUrl || remotePricingUrl,
    modelCount,
  };
}

export async function saveCustomPricingCache(
  pricingCachePath: string,
  table: Record<string, ApiPricing | ApiPricingInterval[]>
): Promise<void> {
  await atomicJson(pricingCachePath, validateRawPrices(table));
}

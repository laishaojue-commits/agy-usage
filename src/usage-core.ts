import { ALLOWED_DATA_DIRECTORY_NAMES, type DataDirectoryName } from './data-directory.js';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { readBoundedText } from './files.js';
import { bt, getActiveLocale } from './i18n.js';
import { defaultStateDir, pathsEqual } from './platform/paths.js';
import { createModelQueryMatcher, formatLocalDate, isUnpricedZeroSentinel, type LedgerSnapshot } from './usage-aggregate.js';
import { UsageLedger, type LedgerEvent } from './usage-ledger-core.js';
import {
  PRICING_METADATA,
  calculateEstimatedUsd,
  canonicalActivePricingKeys,
  resolveContextTierPricing,
  resolvePricingFromTable,
  type ApiPricing,
  type ApiPricingEntry,
} from './pricing.js';
import {
  isFileCacheEntryReusable,
  ledgerEventsEqual,
  resolveDatabaseModelFullName,
  type AvailableAccountUsageOption,
  type DailyTokenUsage,
  type FileCacheEntry,
  type GenerationEvent,
  type HourlyTokenUsage,
  type ModelTokenUsage,
  type TokenUsagePeriod,
  type TokenUsageSummary,
  type TokenUsageTotals,
  type TrendModelBreakdown,
} from './usage-types.js';
import {
  buildPricingSyncStatus,
  loadPricingSyncState,
  loadRawPricingTable,
  resolvePricingTableFromRaw,
  type PricingSyncMutableState,
} from './usage-pricing.js';
import {
  discoverDatabaseFiles as discoverDatabaseFilesInDir,
  scanDatabaseEvents as scanDatabaseEventsWithContext,
  type DiscoveredDbStat,
  type UsageScanContext,
} from './usage-scanner.js';
import { buildPricingWarningCodes, buildUsageSummaryReport } from './usage-report.js';

export {
  resolveDatabaseModelFullName,
  type AvailableAccountUsageOption,
  type DailyTokenUsage,
  type GenerationEvent,
  type HourlyTokenUsage,
  type ModelTokenUsage,
  type TokenUsagePeriod,
  type TokenUsageSummary,
  type TokenUsageTotals,
  type TrendModelBreakdown,
};

export interface UsageManagerOptions {
  geminiDir?: string; stateDir?: string; remotePricingUrl?: string;
  fallbackPricingUrls?: string[]; dataDirectoryName?: DataDirectoryName;
}

export class LocalUsageStatsManager {
  private rateLocksPath: string;
  private rateLocks: Record<string, { usd: number; price: ApiPricing }> = Object.create(null);
  private rateLocksLoaded = false;
  private rateLocksLoading?: Promise<void>;
  private rateLocksUnavailable = false;
  private rateLocksFileFatal = false;
  private priceRefMap = new Map<string, ApiPricing>();
  private geminiDir: string;
  private dataDirectoryNames: readonly DataDirectoryName[];
  private pricingCachePath: string;
  public lastDiscoveredDatabaseCount = 0;
  private inFlight?: Promise<TokenUsageSummary>;
  private inFlightForced = false;
  private inFlightAccountKey = 'all';
  private pendingForced?: Promise<TokenUsageSummary>;
  private discoveryErrors: NonNullable<TokenUsageSummary['database_diagnostics']> = [];
  private periodKey = '';
  private pricingWarnings: string[] = [];
  private snapshots = new Map<string, { events: GenerationEvent[]; prices: Record<string, ApiPricing>; rawPricing: Record<string, ApiPricingEntry>; summary: TokenUsageSummary; expires: number; pins: number; ledger?: LedgerSnapshot }>();
  private scanAbort?: AbortController;
  private fileCache = new Map<string, FileCacheEntry>();
  private totalCachedEvents = 0;

  private ledger: UsageLedger;
  private usageLedgerLoaded = false;
  private usageLedgerLoading?: Promise<void>;
  private usageLedgerEvents = new Map<string, LedgerEvent>();
  private legacyKeyIndex = new Map<string, Set<string>>();
  private ledgerUnavailable = false;
  private ledgerCorrupt = false;
  private archivedUnavailable = false;
  private storageWarnings = new Set<string>();
  private cachedSummariesByAccount = new Map<string, { data: TokenUsageSummary; expiresAt: number }>();
  private lastAggregationKeysByAccount = new Map<string, string>();
  private knownAccounts: Array<{ id: string; email: string; name?: string | null }> = [];
  private archivedEventsPath: string;
  private archivedEventsLoaded = false;
  private archivedEventsLoading?: Promise<void>;
  private archivedByDb = new Map<
    string,
    {
      archivedAt: string;
      generationsScanned: number;
      skippedLargeRecords: number;
      events: GenerationEvent[];
    }
  >();
  private remotePricingCachePath: string;
  private pricingSyncStatePath: string;
  private remotePricingUrl: string;
  private lastRemoteSyncAt = 0;
  private lastSyncSuccess = false;
  private lastCheckAt = 0;
  private lastCheckSuccess = false;
  private nextAutoSyncAt = 0;
  private syncStateLoaded = false;
  private syncStatePromise?: Promise<void>;
  private lastSyncError: string | null = null;
  private lastSyncedSourceUrl = '';
  private lastSyncedVersion = '';
  private lastSyncedUpdatedAt = '';
  private lastSyncedEtag = '';
  private lastSyncedSha256 = '';
  private pricingRevisionSeq = 0;
  private activeOfficialModels: string[] | null = null;
  private activeUnpricedOfficialModels: string[] | null = null;

  constructor(options?: UsageManagerOptions) {
    const defaultGeminiDir = join(homedir(), '.gemini');
    const resolvedDefaultStateDir = defaultStateDir();
    this.geminiDir = options?.geminiDir ?? defaultGeminiDir;
    if (options?.dataDirectoryName && !ALLOWED_DATA_DIRECTORY_NAMES.includes(options.dataDirectoryName)) throw new Error(bt('usage.err.official_only'));
    this.dataDirectoryNames = options?.dataDirectoryName ? [options.dataDirectoryName] : ALLOWED_DATA_DIRECTORY_NAMES;
    const stateDir = options?.stateDir ?? (options?.geminiDir && !pathsEqual(options.geminiDir, defaultGeminiDir) ? join(options.geminiDir, '.gravitybox_state') : resolvedDefaultStateDir);
    this.ledger = new UsageLedger(stateDir);
    this.rateLocksPath = join(stateDir, 'usage-rate-locks.json');
    this.archivedEventsPath = join(stateDir, 'usage-archived-events.json');
    this.pricingCachePath = join(stateDir, 'api_pricing.json');
    this.remotePricingCachePath = join(stateDir, 'remote_pricing.json');
    this.pricingSyncStatePath = join(stateDir, 'pricing-sync-status.json');
    this.remotePricingUrl = options?.remotePricingUrl ?? '';
  }

  async ledgerReview(): Promise<Record<string, unknown>> {
    try { return await this.ledger.review(); }
    catch { return { readOnly: true, unavailable: true, message: bt('usage.review.unavailable') }; }
  }

  setAutoRemotePricingSync(_enabled: boolean) {}
  isAutoRemotePricingSyncEnabled(): boolean { return false; }
  async isAutoPricingSyncDue(): Promise<boolean> { return false; }
  getLastPricingCheckAt(): number { return Math.max(this.lastCheckAt, this.lastRemoteSyncAt); }
  getPricingRevision(): string {
    return `${this.lastSyncedVersion || PRICING_METADATA.version}|${this.lastSyncedUpdatedAt || PRICING_METADATA.updatedAt}|${this.lastSyncedSha256}|${this.pricingRevisionSeq}`;
  }
  async hydratePricingCatalog(): Promise<void> {
    await this.ensureSyncStateLoaded();
    await this.getRawPricingCatalog();
  }

  /** 动态更新当前官方 Antigravity 包含模型列表（含可选未计价实时模型列表），用于价格基准展示过滤与状态计数。 */
  setActiveOfficialModels(
    modelIds: Iterable<string> | null,
    unpricedModelIds?: Iterable<string> | null
  ): void {
    if (!modelIds) {
      this.activeOfficialModels = null;
      this.activeUnpricedOfficialModels = unpricedModelIds
        ? Array.from(new Set(Array.from(unpricedModelIds).map(id => String(id).trim()).filter(Boolean)))
        : null;
      return;
    }
    const list = Array.from(modelIds).map(id => String(id).trim()).filter(Boolean);
    const unpricedList = unpricedModelIds
      ? Array.from(new Set(Array.from(unpricedModelIds).map(id => String(id).trim()).filter(Boolean)))
      : null;
    if (list.length === 0 && (!unpricedList || unpricedList.length === 0)) {
      this.activeOfficialModels = null;
      this.activeUnpricedOfficialModels = null;
      return;
    }
    this.activeOfficialModels = list;
    this.activeUnpricedOfficialModels = unpricedList;
  }

  private cachedPriceRef(price: ApiPricing): ApiPricing {
    const key = JSON.stringify(price);
    let ref = this.priceRefMap.get(key);
    if (!ref) {
      ref = Object.freeze(structuredClone(price));
      this.priceRefMap.set(key, ref);
    }
    return ref;
  }

  private isUnpricedRateLock(value: { usd: number; price?: ApiPricing } | undefined): boolean {
    if (!value || !value.price) return true;
    return value.usd === 0 && isUnpricedZeroSentinel(value.price);
  }

  private loadRateLocks(): Promise<void> {
    if (this.rateLocksLoading) return this.rateLocksLoading;
    if (this.rateLocksLoaded) return Promise.resolve();
    const work = this.loadRateLocksOnce().finally(() => { if (this.rateLocksLoading === work) this.rateLocksLoading = undefined; });
    this.rateLocksLoading = work;
    return work;
  }

  private async loadRateLocksOnce(): Promise<void> {
    if (this.rateLocksLoaded) return;
    if (this.ledgerUnavailable || this.archivedUnavailable) {
      this.rateLocksLoaded = true;
      this.rateLocksUnavailable = true;
      return;
    }
    let localFileFatal = false;
    try {
      const data = JSON.parse(await readBoundedText(this.rateLocksPath, 16 * 1024 * 1024));
      if (data.version !== 1 || !data.entries || typeof data.entries !== 'object') throw Error(bt('usage.err.rate_ledger_invalid_format'));
      const profiles: ApiPricing[] = Array.isArray(data.profiles) ? data.profiles : [];
      const cachedProfiles = profiles.map(p => (p ? this.cachedPriceRef(p) : undefined));
      for (const [key, value] of Object.entries<any>(data.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(value?.usd) || value.usd < 0) throw Error(bt('usage.err.rate_ledger_invalid_entry'));
        let price: ApiPricing | undefined = value.price ? this.cachedPriceRef(value.price) : undefined;
        if (!price && typeof value.p === 'number') {
          price = cachedProfiles[value.p];
        }
        if (!price) throw Error(bt('usage.err.rate_ledger_invalid_entry'));
        this.rateLocks[key] = { usd: value.usd, price };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        localFileFatal = true;
        this.rateLocksLoaded = true;
        this.rateLocksUnavailable = true;
        this.rateLocksFileFatal = true;
        this.pricingWarnings.push(bt('usage.warn.rate_ledger_unreadable_stop'));
      }
    }

    if (!localFileFatal) {
      try {
        const indexed = await this.ledger.locks();
        for (const [key, value] of Object.entries(indexed)) this.rateLocks[key] = { usd: value.usd, price: this.cachedPriceRef(value.price) };
        this.rateLocksUnavailable = false;
        this.rateLocksLoaded = true;
      } catch {
        this.rateLocksUnavailable = true;
      }
    }
  }

  private lockedCost(event: GenerationEvent, price: ApiPricing | null): number | null {
    if (this.rateLocksUnavailable || this.ledgerUnavailable || this.archivedUnavailable || event.timestamp_seconds <= 0) return null;
    const cw = event.cache_write_tokens ?? 0;
    const existing = event.event_key ? this.rateLocks[event.event_key] ?? (event.legacy_event_key && this.usageLedgerEvents.get(event.legacy_event_key)?.timestamp_seconds === event.timestamp_seconds ? this.rateLocks[event.legacy_event_key] : undefined) : undefined;
    if (existing && !this.isUnpricedRateLock(existing)) {
      const effectiveExisting = resolveContextTierPricing(existing.price, event.input_tokens + event.cached_tokens + cw);
      const lockedMissingCw = cw > 0 && (!Number.isFinite(effectiveExisting.cacheWrite) || effectiveExisting.cacheWrite! < 0);
      if (!lockedMissingCw) {
        if (!event.source_id) return existing.usd;
        const usd = calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, existing.price, cw);
        if (!this.rateLocks[event.event_key!] || this.rateLocks[event.event_key!]!.usd !== usd) {
          this.rateLocks[event.event_key!] = { usd, price: existing.price };
        }
        return usd;
      }
    }
    const effectivePrice = price ? resolveContextTierPricing(price, event.input_tokens + event.cached_tokens + cw) : null;
    if (!price || !effectivePrice || (cw > 0 && (!Number.isFinite(effectivePrice.cacheWrite) || effectivePrice.cacheWrite! < 0))) return null;
    const usd = calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, price, cw);
    if (event.event_key) {
      this.rateLocks[event.event_key] = { usd, price: this.cachedPriceRef(price) };
    }
    return usd;
  }

  setDataDirectoryName(name?: DataDirectoryName): void {
    if (name && !ALLOWED_DATA_DIRECTORY_NAMES.includes(name)) throw new Error(bt('usage.err.official_only'));
    const nextNames = name ? [name] : ALLOWED_DATA_DIRECTORY_NAMES;
    if (this.dataDirectoryNames.join(',') === nextNames.join(',')) return;
    this.cancelRead();
    this.dataDirectoryNames = nextNames;
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.discoveredStats.clear();
  }

  private setFileCacheEntry(dbPath: string, entry: FileCacheEntry): void {
    const existing = this.fileCache.get(dbPath);
    if (existing) {
      this.totalCachedEvents -= existing.events.length;
    } else if (this.fileCache.size >= 2000) {
      const oldestKey = this.fileCache.keys().next().value;
      if (oldestKey) {
        const evicted = this.fileCache.get(oldestKey);
        if (evicted) this.totalCachedEvents -= evicted.events.length;
        this.fileCache.delete(oldestKey);
      }
    }
    if (this.totalCachedEvents > 50_000) {
      for (const [key, value] of this.fileCache) {
        if (this.totalCachedEvents <= 50_000) break;
        if (key !== dbPath) {
          this.fileCache.delete(key);
          this.totalCachedEvents -= value.events.length;
        }
      }
    }
    this.fileCache.set(dbPath, entry);
    this.totalCachedEvents += entry.events.length;
  }

  private normalizeArchivedDbKey(dbPath: string): { key: string; dirName: string } {
    const normalized = dbPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const base = basename(normalized);
    for (const allowed of ALLOWED_DATA_DIRECTORY_NAMES) {
      const idx = parts.lastIndexOf(allowed);
      if (idx >= 0) {
        return { key: `${allowed}/${base}`, dirName: allowed };
      }
    }
    return { key: `antigravity/${base}`, dirName: 'antigravity' };
  }

  private loadArchivedEvents(): Promise<void> {
    if (this.archivedEventsLoading) return this.archivedEventsLoading;
    if (this.archivedEventsLoaded) return Promise.resolve();
    const work = this.loadArchivedEventsOnce().finally(() => { if (this.archivedEventsLoading === work) this.archivedEventsLoading = undefined; });
    this.archivedEventsLoading = work;
    return work;
  }

  private async loadArchivedEventsOnce(): Promise<void> {
    if (this.archivedEventsLoaded) return;
    this.archivedEventsLoaded = true;
    try {
      const raw = JSON.parse(await readBoundedText(this.archivedEventsPath, 32 * 1024 * 1024));
      if (!raw || raw.version !== 1 || typeof raw.databases !== 'object' || raw.databases === null) throw Error(bt('usage.err.archive_invalid_format'));
      for (const [key, entry] of Object.entries<any>(raw.databases)) {
        if (!entry || !Array.isArray(entry.events)) throw Error(bt('usage.err.archive_invalid_events'));
        const validEvents = entry.events.filter((e: any): e is GenerationEvent =>
          Boolean(
            e &&
            typeof e.model === 'string' &&
            Number.isFinite(e.input_tokens) &&
            Number.isFinite(e.output_tokens) &&
            Number.isFinite(e.cached_tokens) &&
            Number.isFinite(e.total_tokens) &&
            Number.isFinite(e.timestamp_seconds)
          )
        );
        if (validEvents.length !== entry.events.length) throw Error(bt('usage.err.archive_corrupt_event'));
        for (const e of validEvents) {
          e.model = resolveDatabaseModelFullName(e.model, null);
        }
        this.archivedByDb.set(key, {
          archivedAt: typeof entry.archivedAt === 'string' ? entry.archivedAt : new Date(0).toISOString(),
          generationsScanned: Number.isFinite(entry.generationsScanned) ? Number(entry.generationsScanned) : validEvents.length,
          skippedLargeRecords: Number.isFinite(entry.skippedLargeRecords) ? Number(entry.skippedLargeRecords) : 0,
          events: validEvents,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.archivedUnavailable = true;
        this.storageWarnings.add(bt('usage.warn.archive_unreadable'));
      }
    }
  }

  private loadUsageLedger(): Promise<void> {
    if (this.usageLedgerLoading) return this.usageLedgerLoading;
    if (this.usageLedgerLoaded) return Promise.resolve();
    const work = this.loadUsageLedgerOnce().finally(() => { if (this.usageLedgerLoading === work) this.usageLedgerLoading = undefined; });
    this.usageLedgerLoading = work;
    return work;
  }

  private async loadUsageLedgerOnce(): Promise<void> {
    if (this.usageLedgerLoaded) return;
    if (!this.ledgerCorrupt) this.ledgerUnavailable = false;
    try {
      const totalCount = await this.ledger.count();
      if (totalCount > 50_000) throw new Error('Read-only ledger exceeds 50000 events');
      for (const event of await this.ledger.load()) {
        if (event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db') {
          this.storageWarnings.add(bt('usage.warn.legacy_synthetic'));
          continue;
        }
        if (event.account_confidence === 'legacy') this.storageWarnings.add(bt('usage.warn.legacy_account_confidence'));
        event.model = resolveDatabaseModelFullName(event.model, null);
        this.setLedgerEventInMap(event.event_key!, event);
      }
      this.usageLedgerLoaded = true;
    } catch (error) {
      const msg = (error as Error)?.message ?? String(error);
      const isTransient = /SQLITE_BUSY|timeout|timed out|超时|exited|退出/i.test(msg);
      this.ledgerUnavailable = true;
      if (isTransient) {
        this.usageLedgerLoaded = false;
      } else {
        this.usageLedgerLoaded = true;
        this.ledgerCorrupt = true;
        this.storageWarnings.add(bt('usage.warn.ledger_unreadable'));
      }
    }
    await this.loadArchivedEvents();
    for (const [key, archive] of this.archivedByDb) {
      for (const event of archive.events) this.upsertLedger({ ...event, db_file: basename(key) });
    }
  }

  private setLedgerEventInMap(key: string, event: LedgerEvent): void {
    const prev = this.usageLedgerEvents.get(key);
    if (prev?.legacy_event_key && prev.legacy_event_key !== event.legacy_event_key) {
      const oldSet = this.legacyKeyIndex.get(prev.legacy_event_key);
      if (oldSet) {
        oldSet.delete(key);
        if (oldSet.size === 0) this.legacyKeyIndex.delete(prev.legacy_event_key);
      }
    }
    this.usageLedgerEvents.set(key, event);
    if (event.legacy_event_key) {
      let nextSet = this.legacyKeyIndex.get(event.legacy_event_key);
      if (!nextSet) {
        nextSet = new Set<string>();
        this.legacyKeyIndex.set(event.legacy_event_key, nextSet);
      }
      nextSet.add(key);
    }
  }

  private deleteLedgerEventFromMap(key: string): void {
    const prev = this.usageLedgerEvents.get(key);
    if (prev?.legacy_event_key) {
      const oldSet = this.legacyKeyIndex.get(prev.legacy_event_key);
      if (oldSet) {
        oldSet.delete(key);
        if (oldSet.size === 0) this.legacyKeyIndex.delete(prev.legacy_event_key);
      }
    }
    this.usageLedgerEvents.delete(key);
  }

  private confidenceRank(confidence?: GenerationEvent['account_confidence']): number {
    switch (confidence) {
      case 'observed':
        return 3;
      case 'unknown':
        return 1;
      case 'legacy':
        return 0;
      default:
        return -1;
    }
  }

  private mergeLedgerEventRecord(previous: LedgerEvent | undefined, incoming: LedgerEvent): LedgerEvent {
    const next: LedgerEvent = {
      ...previous,
      ...incoming,
      source_observed_at: Math.max(incoming.source_observed_at ?? 0, previous?.source_observed_at ?? 0) || incoming.source_observed_at,
      timestamp_seconds: incoming.timestamp_seconds || previous?.timestamp_seconds || 0,
      ingested_at: previous?.ingested_at ?? incoming.ingested_at ?? new Date().toISOString(),
    };
    if (previous) {
      const prevRank = this.confidenceRank(previous.account_confidence);
      const nextRank = this.confidenceRank(incoming.account_confidence);
      const prevHasIdentity = Boolean(previous.account_id || previous.account_email || previous.account_confidence);
      const nextHasIdentity = Boolean(incoming.account_id || incoming.account_email);
      if (
        (prevRank > nextRank && prevHasIdentity) ||
        (prevRank === nextRank && !nextHasIdentity && prevHasIdentity)
      ) {
        next.account_id = previous.account_id;
        next.account_email = previous.account_email;
        next.account_confidence = previous.account_confidence;
      }
      if (previous.account_type && previous.account_type !== 'unknown' && (!incoming.account_type || incoming.account_type === 'unknown')) {
        next.account_type = previous.account_type;
      }
    }
    return next;
  }

  private upsertLedger(event: LedgerEvent): void {
    const key = event.event_key;
    if (!key || event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db') return;
    const sameKeyPrev = this.usageLedgerEvents.get(key);
    let previous = sameKeyPrev;
    const migratedFromKeys: string[] = [];
    if (event.legacy_event_key) {
      const indexedKeys = this.legacyKeyIndex.get(event.legacy_event_key);
      const legacyCandidates: Array<[string, LedgerEvent]> = [];
      if (indexedKeys) {
        for (const oldKey of indexedKeys) {
          if (oldKey === key) continue;
          const candidate = this.usageLedgerEvents.get(oldKey);
          if (
            candidate &&
            candidate.legacy_event_key === event.legacy_event_key &&
            (!event.db_file || !candidate.db_file || candidate.db_file === event.db_file)
          ) {
            legacyCandidates.push([oldKey, candidate]);
          }
        }
      }
      legacyCandidates.sort((a, b) => (a[1].source_observed_at ?? 0) - (b[1].source_observed_at ?? 0));
      for (const [oldKey, candidate] of legacyCandidates) {
        migratedFromKeys.push(oldKey);
        this.deleteLedgerEventFromMap(oldKey);
        if (this.rateLocks[oldKey] && !this.rateLocks[key]) {
          this.rateLocks[key] = this.rateLocks[oldKey]!;
        }
        if (!previous) {
          previous = candidate;
        } else {
          if (this.confidenceRank(candidate.account_confidence) > this.confidenceRank(previous.account_confidence)) {
            previous = {
              ...previous,
              account_id: candidate.account_id,
              account_email: candidate.account_email,
              account_confidence: candidate.account_confidence,
              account_type: candidate.account_type ?? previous.account_type,
            };
          }
          if (!previous.timestamp_seconds && candidate.timestamp_seconds) {
            previous = { ...previous, timestamp_seconds: candidate.timestamp_seconds };
          }
          if (candidate.ingested_at && (!previous.ingested_at || candidate.ingested_at < previous.ingested_at)) {
            previous = { ...previous, ingested_at: candidate.ingested_at };
          }
          if ((candidate.source_observed_at ?? 0) > (previous.source_observed_at ?? 0)) {
            previous = { ...previous, source_observed_at: candidate.source_observed_at };
          }
        }
      }
    }
    if (sameKeyPrev && (sameKeyPrev.source_observed_at ?? 0) > (event.source_observed_at ?? 0) && migratedFromKeys.length === 0) return;
    const next = this.mergeLedgerEventRecord(previous, event);
    if (sameKeyPrev && migratedFromKeys.length === 0 && ledgerEventsEqual(sameKeyPrev, next)) return;
    this.setLedgerEventInMap(key, next);
  }

  public invalidateCache(): void {
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.discoveredStats.clear();
  }

  public resolvePricing(
    pricingTable: Record<string, ApiPricingEntry>,
    modelName: string,
    timestampSeconds: number
  ): ApiPricing | null {
    return resolvePricingFromTable(pricingTable, modelName, timestampSeconds);
  }

  private calendarKey() { const d=new Date();return formatLocalDate(d)+':'+d.getTimezoneOffset()+':'+Intl.DateTimeFormat().resolvedOptions().timeZone+':'+getActiveLocale(); }

  private withStickyPricingWarnings(warnings: string[]): string[] {
    if (!this.rateLocksFileFatal) return warnings;
    const fatalWarn = bt('usage.warn.rate_ledger_unreadable_stop');
    return warnings.includes(fatalWarn) ? warnings : [...warnings, fatalWarn];
  }

  async getRawPricingCatalog(): Promise<{ raw: Record<string, ApiPricingEntry>; publicKeys: Set<string> }> {
    const { merged, warnings, publicKeys } = await loadRawPricingTable(this.remotePricingCachePath, this.pricingCachePath);
    this.pricingWarnings = this.withStickyPricingWarnings(warnings);
    return { raw: merged, publicKeys };
  }

  async getRawPricingTable(): Promise<Record<string, ApiPricingEntry>> {
    const { raw } = await this.getRawPricingCatalog();
    return raw;
  }

  async getBillingPricingTable(): Promise<Record<string, ApiPricingEntry>> {
    const { billingPrices, warnings } = await loadRawPricingTable(this.remotePricingCachePath, this.pricingCachePath);
    this.pricingWarnings = this.withStickyPricingWarnings(warnings);
    return billingPrices;
  }

  private resolvePricingTableFromRaw(
    raw: Record<string, ApiPricingEntry>,
    timestampSeconds = Math.floor(Date.now() / 1000),
    allowedKeys?: Set<string>
  ): Record<string, ApiPricing> {
    return resolvePricingTableFromRaw(raw, timestampSeconds, allowedKeys);
  }

  async getPricingTable(timestampSeconds = Math.floor(Date.now() / 1000)): Promise<Record<string, ApiPricing>> {
    const raw = await this.getRawPricingTable();
    return this.resolvePricingTableFromRaw(raw, timestampSeconds);
  }

  private canonicalActivePricingKeys(modelIds?: Iterable<string> | null, extraKeys?: Iterable<string>): Set<string> {
    return canonicalActivePricingKeys(modelIds !== undefined && modelIds !== null ? modelIds : this.activeOfficialModels, extraKeys);
  }

  /**
   * 仅返回当前 Antigravity 官方包含模型对应的生效价格基准，不包含已下线历史模型；
   * 历史事件计价仍通过 getRawPricingTable() / rateLocks 独立保留，互不影响。
   */
  async getActivePricingTable(
    timestampSeconds = Math.floor(Date.now() / 1000),
    activeModelIds?: Iterable<string> | null
  ): Promise<Record<string, ApiPricing>> {
    const raw = await this.getRawPricingTable();
    if (
      activeModelIds === undefined &&
      this.activeOfficialModels !== null &&
      this.activeOfficialModels.length === 0 &&
      (this.activeUnpricedOfficialModels?.length ?? 0) > 0
    ) {
      return Object.create(null);
    }
    return this.resolvePricingTableFromRaw(raw, timestampSeconds, this.canonicalActivePricingKeys(activeModelIds, Object.keys(raw)));
  }

  private pricingSyncStateSnapshot(): PricingSyncMutableState {
    return {
      lastRemoteSyncAt: this.lastRemoteSyncAt,
      lastSyncSuccess: this.lastSyncSuccess,
      lastCheckAt: this.lastCheckAt,
      lastCheckSuccess: this.lastCheckSuccess,
      nextAutoSyncAt: this.nextAutoSyncAt,
      lastSyncError: this.lastSyncError,
      lastSyncedSourceUrl: this.lastSyncedSourceUrl,
      lastSyncedVersion: this.lastSyncedVersion,
      lastSyncedUpdatedAt: this.lastSyncedUpdatedAt,
      lastSyncedEtag: this.lastSyncedEtag,
      lastSyncedSha256: this.lastSyncedSha256,
    };
  }

  private applyPricingSyncState(next: PricingSyncMutableState): void {
    this.lastRemoteSyncAt = next.lastRemoteSyncAt;
    this.lastSyncSuccess = next.lastSyncSuccess;
    this.lastCheckAt = next.lastCheckAt;
    this.lastCheckSuccess = next.lastCheckSuccess;
    this.nextAutoSyncAt = next.nextAutoSyncAt;
    this.lastSyncError = next.lastSyncError;
    this.lastSyncedSourceUrl = next.lastSyncedSourceUrl;
    this.lastSyncedVersion = next.lastSyncedVersion;
    this.lastSyncedUpdatedAt = next.lastSyncedUpdatedAt ?? '';
    this.lastSyncedEtag = next.lastSyncedEtag ?? '';
    this.lastSyncedSha256 = next.lastSyncedSha256 ?? '';
  }

  private async ensureSyncStateLoaded(): Promise<void> {
    if (this.syncStateLoaded) return;
    if (!this.syncStatePromise) {
      this.syncStatePromise = (async () => {
        const snapshot = this.pricingSyncStateSnapshot();
        await loadPricingSyncState(this.remotePricingCachePath, this.pricingSyncStatePath, snapshot);
        this.applyPricingSyncState(snapshot);
        this.syncStateLoaded = true;
      })().finally(() => {
        this.syncStatePromise = undefined;
      });
    }
    await this.syncStatePromise;
  }

  async syncRemotePricing(): Promise<{ synced: boolean; unchanged?: boolean; error?: string; count?: number; sourceUrl?: string; version?: string; updatedAt?: string; healedCount?: number }> {
    return { synced: false };
  }

  async getPricingSyncStatus(): Promise<{
    autoSyncEnabled: boolean;
    lastSyncAt: number;
    lastCheckAt: number;
    lastSyncSuccess: boolean;
    lastCheckSuccess: boolean;
    lastSyncError: string | null;
    feedVersion: string;
    sourceUrl: string;
    modelCount: number;
  }> {
    await this.ensureSyncStateLoaded();
    const raw = await this.getRawPricingTable();
    const hasOnlyUnpriced =
      this.activeOfficialModels !== null &&
      this.activeOfficialModels.length === 0 &&
      (this.activeUnpricedOfficialModels?.length ?? 0) > 0;
    const activeKeys = hasOnlyUnpriced
      ? new Set<string>()
      : this.canonicalActivePricingKeys(this.activeOfficialModels, Object.keys(raw));
    const activeTable = hasOnlyUnpriced
      ? Object.create(null)
      : this.resolvePricingTableFromRaw(raw, Math.floor(Date.now() / 1000), activeKeys);
    const unpricedCount = this.activeUnpricedOfficialModels !== null
      ? this.activeUnpricedOfficialModels.filter((k) => !Object.hasOwn(activeTable, k)).length
      : (this.activeOfficialModels !== null
          ? [...activeKeys].filter((k) => !Object.hasOwn(raw, k)).length
          : 0);
    return buildPricingSyncStatus({
      autoSyncEnabled: false,
      state: this.pricingSyncStateSnapshot(),
      remotePricingUrl: this.remotePricingUrl,
      modelCount: Object.keys(activeTable).length + unpricedCount,
    });
  }

  private discoveredStats = new Map<string, DiscoveredDbStat>();

  /**
   * 发现全部会话数据库；修改时间仅决定读取顺序，默认不截断统计范围。
   */
  async discoverDatabaseFiles(maxFiles = Number.POSITIVE_INFINITY): Promise<string[]> {
    const res = await discoverDatabaseFilesInDir(this.geminiDir, this.dataDirectoryNames, this.discoveredStats, maxFiles);
    this.discoveryErrors = res.errors;
    this.lastDiscoveredDatabaseCount = res.discoveredCount;
    return res.paths;
  }

  private scanContext(): UsageScanContext {
    return {
      discoveredStats: this.discoveredStats,
      fileCache: this.fileCache,
      setFileCacheEntry: (dbPath, entry) => this.setFileCacheEntry(dbPath, entry),
      markFileCacheDirty: () => {},
      lookupObservedContext: () => null,
      loadUsageLedger: () => this.loadUsageLedger(),
      upsertLedger: (event) => this.upsertLedger(event),
      getLedgerEvent: (eventKey) => this.usageLedgerEvents.get(eventKey),
    };
  }

  /**
   * 解析单数据库中的 Token 生成事件（按文件 mtimeMs、size 与 WAL 变动增量缓存；遇并发读写或新建初始化库自动退避重试）
   */
  async scanDatabaseEvents(dbPath: string, bypassCache = false, signal?: AbortSignal): Promise<{
    events: GenerationEvent[];
    generationsScanned: number;
    skippedLargeRecords: number;
    hasError?: boolean;
    error?: string;
    usedCached?: boolean;
    cacheHit?: boolean;
  }> {
    return scanDatabaseEventsWithContext(this.scanContext(), dbPath, bypassCache, signal);
  }

  /** Privacy-preserving request rows: metrics only, no database paths or conversation content. */
  async getUsageEvents(period: string, query = '', offset = 0, limit = 200, snapshotId?: string, pin = false, force = false, accountId?: string) {
    const accKey = accountId || 'all';
    if (!snapshotId || force) await this.getUsageSummary(force, accountId);
    const snapshot=(!force && snapshotId)?this.snapshots.get(snapshotId):this.snapshots.get(this.cachedSummariesByAccount.get(accKey)?.data.snapshot_id??'');
    if (!snapshot || snapshot.expires<Date.now()) throw Error(bt('usage.err.snapshot_expired'));
    if (pin) snapshot.pins++;
    if (snapshot.pins > 0) snapshot.expires = Date.now()+600000;
    const {summary,prices,rawPricing}=snapshot as any;
    const snapshotAccountId: string = summary.selected_account_id ?? 'all';
    if (accountId && snapshotAccountId !== 'all' && accountId !== snapshotAccountId) {
      throw Error(bt('usage.err.snapshot_account_mismatch'));
    }
    const effectiveAccountId = accountId ?? snapshotAccountId;
    const start = new Date(summary.generated_at*1000); start.setHours(0, 0, 0, 0);
    if (period === '7d') start.setDate(start.getDate() - 6);
    if (period === '30d') start.setDate(start.getDate() - 29);
    const cutoff = period === 'all' ? 0 : start.getTime() / 1000;
    const end = new Date(summary.generated_at*1000); end.setHours(24,0,0,0);
    const upper = end.getTime()/1000;
    const matcher = createModelQueryMatcher(query.slice(0, 200));
    let events = snapshot.events.filter(e => (period === 'all' || (e.timestamp_seconds >= cutoff && e.timestamp_seconds < upper)) && matcher(e.model));
    if (effectiveAccountId && effectiveAccountId !== 'all') {
      const targetOpt = this.knownAccounts.find(a => a.id === effectiveAccountId || (a.email && a.email.toLowerCase() === effectiveAccountId.toLowerCase()));
      const targetEmail = targetOpt?.email?.toLowerCase() || (effectiveAccountId.includes('@') ? effectiveAccountId.toLowerCase() : null);
      events = events.filter(e => {
        if (e.account_id && e.account_id === effectiveAccountId) return true;
        if (targetEmail && e.account_email && e.account_email.toLowerCase() === targetEmail) return true;
        return false;
      });
    }
    const safeOffset = Math.max(0, Math.floor(offset) || 0);
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit) || 200));
    const pricingSource = rawPricing ?? prices;
    const rows = events.slice().reverse().slice(safeOffset, safeOffset + safeLimit).map(e => {
      const price = this.resolvePricing(pricingSource, e.model, e.timestamp_seconds);
      const cost = this.lockedCost(e, price);
      const { event_key: _key, ...publicEvent } = e;
      return { ...publicEvent, estimated_usd: cost, priced: cost !== null };
    });
    return { rows, total: events.length, offset: safeOffset, limit: safeLimit, generated_at: summary.generated_at, snapshot_id: summary.snapshot_id, availability: summary.availability, scope: summary.scan_scope_description };
  }

  releaseSnapshot(id: string) {
    const snapshot = this.snapshots.get(id);
    if (snapshot) { snapshot.pins = Math.max(0, snapshot.pins - 1); snapshot.expires = Date.now()+600000; }
    this.pruneSnapshots();
  }
  private pruneSnapshots() {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expires < Date.now() || snapshot.pins === 0 && this.snapshots.size > 4) this.snapshots.delete(id);
    }
  }

  /**
   * 收集并聚合全量 Token 统计与 API 账单报告（带 30 秒内存 TTL 缓存）
   */
  cancelRead() { this.scanAbort?.abort(new Error(bt('usage.err.read_cancelled'))); return !!this.scanAbort; }
  async getUsageSummary(forceRefresh = false, accountId?: string): Promise<TokenUsageSummary> {
    const accKey = accountId || 'all';
    if(this.inFlight) {
      if(this.inFlightAccountKey===accKey && (!forceRefresh||this.inFlightForced)) return this.inFlight;
      if(this.inFlightAccountKey!==accKey) {
        return this.inFlight.catch(()=>{}).then(()=>this.getUsageSummary(forceRefresh, accountId));
      }
      if(!this.pendingForced)this.pendingForced=this.inFlight.catch(()=>{}).then(()=>this.getUsageSummary(true, accountId)).finally(()=>{this.pendingForced=undefined;});
      return this.pendingForced;
    }
    const abort=this.scanAbort=new AbortController(), timer=setTimeout(()=>abort.abort(new Error(bt('usage.err.read_timeout_budget'))),30000);timer.unref();
    this.inFlightForced=forceRefresh;
    this.inFlightAccountKey=accKey;
    const work=this.collectUsage(forceRefresh,abort.signal,accountId);this.inFlight=work;
    try{return await work;}finally{clearTimeout(timer);if(this.inFlight===work){this.inFlight=undefined;this.scanAbort=undefined;this.inFlightForced=false;this.inFlightAccountKey='all';}}
  }
  private async collectUsage(forceRefresh: boolean, signal: AbortSignal, accountId?: string): Promise<TokenUsageSummary> {
    const accKey = accountId || 'all';
    const nowMs = Date.now();
    const cachedByAcc = this.cachedSummariesByAccount.get(accKey);
    if (!forceRefresh && cachedByAcc && nowMs < cachedByAcc.expiresAt && this.periodKey === this.calendarKey() && cachedByAcc.data.failed_databases_count === 0) {
      return cachedByAcc.data;
    }

    if (forceRefresh && this.ledgerUnavailable && !this.ledgerCorrupt) {
      this.ledgerUnavailable = false;
      for (const warning of this.storageWarnings) {
        if (/用量总账未能保存|Failed to save usage ledger/i.test(warning)) {
          this.storageWarnings.delete(warning);
        }
      }
    }
    const dbPaths = await this.discoverDatabaseFiles();
    const allEvents: GenerationEvent[] = [];
    let generationsScanned = 0;
    let skippedLargeRecords = 0;
    let failedDatabasesCount = this.discoveryErrors.length, cachedDatabasesCount = 0;
    const diagnostics: NonNullable<TokenUsageSummary['database_diagnostics']> = [...this.discoveryErrors];
    const category = (message = '') => /取消|超过预算|整体预算|总账操作超时|bounded read budget|30-second total budget|cancel|timeout|aborted/i.test(message) ? bt('usage.diag.cancelled_or_budget') : /时间|timestamp/i.test(message) ? bt('usage.diag.incomplete_time') : /unable to open|permission|denied|not permitted/i.test(message) ? bt('usage.diag.cannot_open') : /no such table|no such column/i.test(message) ? bt('usage.diag.unsupported_schema') : /locked|busy/i.test(message) ? bt('usage.diag.db_busy') : /maxBuffer|stdout.*length|单批|batch budget|超出/i.test(message) ? bt('usage.diag.batch_budget') : /malformed|not a database/i.test(message) ? bt('usage.diag.corrupt_format') : bt('usage.diag.incomplete');

    let nextDatabase=0;
    let allCacheHits = dbPaths.length > 0;
    await Promise.all(Array.from({length:Math.min(8,dbPaths.length)},async()=>{
    while(nextDatabase<dbPaths.length) {
      if(signal.aborted){allCacheHits=false;break;}
      const p=dbPaths[nextDatabase++]!;
      const cachedEntry = this.fileCache.get(p);
      const bypassFileCache = Boolean(cachedEntry && !isFileCacheEntryReusable(cachedEntry));
      const res = await this.scanDatabaseEvents(p, bypassFileCache, signal);
      if (!res.cacheHit) allCacheHits = false;
      for (const ev of res.events) allEvents.push(ev);
      generationsScanned += res.generationsScanned;
      skippedLargeRecords += res.skippedLargeRecords;
      if (res.hasError) failedDatabasesCount++;
      if (res.usedCached) cachedDatabasesCount++;
      const cached = this.fileCache.get(p);
      diagnostics.push({ id: createHash('sha256').update(p).digest('hex').slice(0,10),
        state: res.hasError ? (res.events.length ? 'cached_or_partial' : 'failed') : 'read',
        category: res.hasError ? category(res.error) : bt('usage.diag.read'), lastSuccessAt: cached?.lastSuccessAt });
    }
    }));

    for(const path of dbPaths.slice(nextDatabase)) {
      allCacheHits = false;
      const cached=this.fileCache.get(path);failedDatabasesCount++;
      if(cached){for (const ev of cached.events) allEvents.push(ev);cachedDatabasesCount++;generationsScanned+=cached.generationsScanned;skippedLargeRecords+=cached.skippedLargeRecords;}
      diagnostics.push({id:createHash('sha256').update(path).digest('hex').slice(0,10),state:cached?'cached_or_partial':'failed',category:bt('usage.diag.cancelled_or_budget'),lastSuccessAt:cached?.lastSuccessAt});
    }

    await this.loadArchivedEvents();
    let archivedDbCount = 0;
    const archivedStampParts: string[] = [];
    if (this.archivedByDb.size > 0) {
      const allowedDirs = new Set<string>(this.dataDirectoryNames);
      const liveDbKeys = new Set(dbPaths.map(p => this.normalizeArchivedDbKey(p).key));
      const seenEventKeys = new Set<string>();
      for (const ev of allEvents) {
        if (ev.event_key) seenEventKeys.add(ev.event_key);
      }
      for (const [archKey, archEntry] of this.archivedByDb.entries()) {
        const slashIdx = archKey.indexOf('/');
        const dirName = slashIdx > 0 ? archKey.slice(0, slashIdx) : 'antigravity';
        if (!allowedDirs.has(dirName) || liveDbKeys.has(archKey)) continue;
        archivedDbCount++;
        generationsScanned += archEntry.generationsScanned;
        skippedLargeRecords += archEntry.skippedLargeRecords;
        archivedStampParts.push(`${archKey}:${archEntry.events.length}:${archEntry.archivedAt}`);
        for (const ev of archEntry.events) {
          if (ev.event_key) {
            if (seenEventKeys.has(ev.event_key)) continue;
            seenEventKeys.add(ev.event_key);
          }
          allEvents.push(ev);
        }
      }
      if (dbPaths.length === 0 && archivedDbCount > 0 && failedDatabasesCount === 0) {
        allCacheHits = true;
      }
    }

    await this.loadUsageLedger();

    const liveEventsCount = allEvents.length;

    for (const event of allEvents) this.upsertLedger(event);

    // 从追加型永久总账（UsageLedger）合并已离线/已归档或被官方清理的会话事件
    const seenEventKeys = new Set<string>();
    const seenDbLegacyKeys = new Set<string>();
    const uniqueLiveEvents: GenerationEvent[] = [];
    for (const ev of allEvents) {
      if (ev.event_key) {
        if (seenEventKeys.has(ev.event_key)) continue;
        seenEventKeys.add(ev.event_key);
      }
      if (ev.legacy_event_key) {
        const dbFile = 'db_file' in ev && typeof ev.db_file === 'string' ? ev.db_file : '';
        const legacySig = `${dbFile}:${ev.legacy_event_key}`;
        if (seenDbLegacyKeys.has(legacySig)) continue;
        seenDbLegacyKeys.add(legacySig);
      }
      uniqueLiveEvents.push(ev);
    }
    if (uniqueLiveEvents.length !== allEvents.length) {
      allEvents.splice(0, allEvents.length, ...uniqueLiveEvents);
    }
    const currentLegacyKeys = new Set(allEvents.map(event => event.legacy_event_key).filter(Boolean));
    for (const ledgerEv of this.usageLedgerEvents.values()) {
      if (ledgerEv.legacy_event_key) currentLegacyKeys.add(ledgerEv.legacy_event_key);
    }
    const liveSourceFiles = new Set(dbPaths.map(path => basename(path)));
    const representedFiles = new Set([...dbPaths.map(path => basename(path)), ...[...this.archivedByDb.keys()].map(path => basename(path))]);
    const mergedLedgerDbs = new Set<string>();
    for (const [evKey, ledgerEv] of this.usageLedgerEvents.entries()) {
      if (currentLegacyKeys.has(evKey)) continue;
      if (ledgerEv.legacy_event_key && seenDbLegacyKeys.has(`${ledgerEv.db_file ?? ''}:${ledgerEv.legacy_event_key}`)) continue;
      if (!ledgerEv.source_id && ledgerEv.db_file && liveSourceFiles.has(ledgerEv.db_file)) {
        this.storageWarnings.add(bt('usage.warn.ledger_missing_source_id'));
        continue;
      }
      if (!seenEventKeys.has(evKey)) {
        seenEventKeys.add(evKey);
        if (ledgerEv.legacy_event_key) seenDbLegacyKeys.add(`${ledgerEv.db_file ?? ''}:${ledgerEv.legacy_event_key}`);
        allEvents.push(ledgerEv);
        if (ledgerEv.db_file && !representedFiles.has(ledgerEv.db_file)) mergedLedgerDbs.add(ledgerEv.db_file);
      }
    }
    archivedDbCount += mergedLedgerDbs.size;

    const existingAccCache = this.cachedSummariesByAccount.get(accKey);
    const calNowKey = this.calendarKey();
    if ((allEvents.length === 0 || (dbPaths.length > 0 && cachedDatabasesCount === dbPaths.length)) && failedDatabasesCount > 0 && existingAccCache?.data && this.periodKey === calNowKey) {
      if (existingAccCache.data.snapshot_id && this.snapshots.has(existingAccCache.data.snapshot_id)) {
        this.snapshots.get(existingAccCache.data.snapshot_id)!.expires = Date.now() + 600000;
      }
      const fallbackWarnings = existingAccCache.data.pricing_warnings ?? [...this.pricingWarnings, ...this.storageWarnings];
      return {
        ...existingAccCache.data,
        failed_databases_count: failedDatabasesCount,
        has_error: true,
        hasError: true, availability: 'cached', database_diagnostics: diagnostics, last_attempt_at: Math.floor(Date.now()/1000),
        pricing_warnings: fallbackWarnings,
        pricing_warning_codes: existingAccCache.data.pricing_warning_codes ?? buildPricingWarningCodes(fallbackWarnings),
      };
    }

    const rawPricing = await this.getBillingPricingTable();
    await this.loadRateLocks();
    if (this.rateLocksUnavailable && !this.pricingWarnings.some(w => /费率账本|rate ledger/i.test(w))) this.pricingWarnings.push(bt('usage.warn.rate_ledger_unreadable_no_reprice'));
    const now = Math.floor(Date.now() / 1000);
    const pricing = this.resolvePricingTableFromRaw(rawPricing, now);
    const calKey = this.calendarKey();
    const aggKey = allCacheHits && failedDatabasesCount === 0
      ? `${accKey}|${calKey}|${this.lastDiscoveredDatabaseCount}|${dbPaths.map(p => { const c = this.fileCache.get(p); return c ? `${p}:${c.mtimeMs}:${c.size}:${c.walMtimeMs}:${c.walSize}:${c.hasError ? 1 : 0}:${c.skippedLargeRecords}:${c.projectionVersion ?? 0}` : p; }).join(';')}|arch:${archivedStampParts.join(';')}|${JSON.stringify(rawPricing)}|${this.pricingWarnings.join(',')}`
      : '';
    const cachedByAccEntry = this.cachedSummariesByAccount.get(accKey);
    if (aggKey && aggKey === this.lastAggregationKeysByAccount.get(accKey) && cachedByAccEntry?.data && this.periodKey === calKey) {
      const reusedWarnings = [...this.pricingWarnings, ...this.storageWarnings];
      const reused: TokenUsageSummary = {
        ...cachedByAccEntry.data,
        database_diagnostics: diagnostics,
        last_attempt_at: now,
        pricing_warnings: reusedWarnings,
        pricing_warning_codes: buildPricingWarningCodes(reusedWarnings),
      };
      this.cachedSummariesByAccount.set(accKey, { data: reused, expiresAt: Date.now() + 30_000 });
      if (reused.snapshot_id && this.snapshots.has(reused.snapshot_id)) {
        this.snapshots.get(reused.snapshot_id)!.expires = Date.now() + 600000;
      }
      this.pruneSnapshots();
      return reused;
    }

    const accountMap = new Map<string, AvailableAccountUsageOption>();
    accountMap.set('all', { id: 'all', label: bt('usage.all_accounts'), type: 'all', total_tokens: 0, request_count: 0 });
    const knownReceiptKeys = new Set<string>();
    const allOpt = accountMap.get('all')!;
    let unattributedRequests = 0;
    let unattributedTokens = 0;
    for (const ev of allEvents) {
      if (ev.event_key) knownReceiptKeys.add(ev.event_key);
      if (ev.legacy_event_key) knownReceiptKeys.add(ev.legacy_event_key);
      allOpt.total_tokens = (allOpt.total_tokens ?? 0) + ev.total_tokens;
      allOpt.request_count = (allOpt.request_count ?? 0) + 1;
      if (!ev.account_id && !ev.account_email) {
        unattributedRequests++;
        unattributedTokens += ev.total_tokens;
      }
    }

    allEvents.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds || (a.event_key ?? '').localeCompare(b.event_key ?? ''));

    const summary = buildUsageSummaryReport({
      allEvents,
      effectiveEvents: allEvents,
      knownReceiptKeys,
      unattributedRequests,
      unattributedTokens,
      accountMap,
      accountId,
      accKey,
      now,
      rawPricing,
      pricing,
      calKey,
      rateLocks: this.rateLocks,
      resolvePricing: (table, modelName, ts) => this.resolvePricing(table, modelName, ts),
      lockedCost: (ev, price) => this.lockedCost(ev, price),
      dbPathsCount: dbPaths.length,
      archivedDbCount,
      lastDiscoveredDatabaseCount: this.lastDiscoveredDatabaseCount,
      cachedDatabasesCount,
      liveEventsCount,
      generationsScanned,
      skippedLargeRecords,
      failedDatabasesCount,
      diagnostics,
      ledgerCorrupt: this.ledgerCorrupt,
      archivedUnavailable: this.archivedUnavailable,
      storageWarnings: this.storageWarnings,
      pricingWarnings: this.pricingWarnings,
    });

    this.periodKey=calKey;
    if (aggKey) {
      this.lastAggregationKeysByAccount.set(accKey, aggKey);
    }
    this.cachedSummariesByAccount.set(accKey, { data: summary, expiresAt: Date.now() + (failedDatabasesCount > 0 ? 2000 : 30000) });
    if (!this.snapshots.has(summary.snapshot_id!)) {
      this.snapshots.set(summary.snapshot_id!, { events: allEvents, prices: pricing, rawPricing, summary, expires: Date.now()+600000, pins: 0 });
    } else {
      const existing = this.snapshots.get(summary.snapshot_id!)!;
      summary.generated_at = existing.summary.generated_at;
      existing.summary = summary;
      existing.events = allEvents;
      existing.prices = pricing;
      existing.rawPricing = rawPricing;
      existing.expires = Date.now()+600000;
    }
    this.pruneSnapshots();
    return summary;
  }
}

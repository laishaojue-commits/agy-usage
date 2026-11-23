import { createHash } from 'node:crypto';
import { formatLocalDate } from './usage-aggregate.js';
import { matchPricingKeys, priceStatus, type ApiPricing, type ApiPricingEntry } from './pricing.js';
import { bt } from './i18n.js';
import {
  finalizeTrendBreakdowns,
  recordTrendModelBreakdown,
  resolveDatabaseModelFullName,
  type AvailableAccountUsageOption,
  type DailyTokenUsage,
  type GenerationEvent,
  type HourlyTokenUsage,
  type ModelTokenUsage,
  type TokenUsagePeriod,
  type TokenUsageSummary,
  type TrendModelBreakdown,
} from './usage-types.js';

export interface BuildUsageReportInput {
  allEvents: GenerationEvent[];
  effectiveEvents: GenerationEvent[];
  knownReceiptKeys: Set<string>;
  unattributedRequests: number;
  unattributedTokens: number;
  accountMap: Map<string, AvailableAccountUsageOption>;
  accountId: string | undefined;
  accKey: string;
  now: number;
  rawPricing: Record<string, ApiPricingEntry>;
  pricing: Record<string, ApiPricing>;
  calKey: string;
  rateLocks: Record<string, { usd: number; price: ApiPricing }>;
  resolvePricing: (table: Record<string, ApiPricingEntry>, modelName: string, ts: number) => ApiPricing | null;
  lockedCost: (ev: GenerationEvent, price: ApiPricing | null) => number | null;
  dbPathsCount: number;
  archivedDbCount: number;
  lastDiscoveredDatabaseCount: number;
  cachedDatabasesCount: number;
  liveEventsCount: number;
  generationsScanned: number;
  skippedLargeRecords: number;
  failedDatabasesCount: number;
  diagnostics: NonNullable<TokenUsageSummary['database_diagnostics']>;
  ledgerCorrupt: boolean;
  archivedUnavailable: boolean;
  storageWarnings: Set<string>;
  pricingWarnings: string[];
}

export function classifyUsageWarningCode(message: string): string {
  const text = String(message || '').trim();
  if (!text) return 'warning';
  if (/^(?:旧JSON|Legacy JSON)/i.test(text)) return 'legacy_json_migrated';
  if (/^(?:旧账本|Legacy ledger)/i.test(text)) return 'legacy_ledger_migrated';
  if (/^(?:历史金额凭据|Historical cost receipts)/i.test(text)) return 'historical_receipts_locked';
  if (/^(?:历史费率账本不可读|Historical rate ledger is unreadable)/i.test(text)) return 'rate_ledger_unreadable';
  if (/^(?:归档用量账本|Archive usage ledger)/i.test(text)) return 'archive_unreadable';
  if (/^(?:持久化用量总账|Persistent usage ledger)/i.test(text)) return 'ledger_unreadable';
  if (/^(?:用量总账未能保存|Failed to save usage ledger)/i.test(text)) return 'ledger_save_failed';
  return 'warning';
}

export function buildPricingWarningCodes(warnings: readonly string[]): string[] {
  return warnings.map(classifyUsageWarningCode);
}

export function buildUsageSummaryReport(input: BuildUsageReportInput): TokenUsageSummary {
  const {
    allEvents,
    effectiveEvents,
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
    rateLocks,
    resolvePricing,
    lockedCost,
    dbPathsCount,
    archivedDbCount,
    lastDiscoveredDatabaseCount,
    cachedDatabasesCount,
    liveEventsCount,
    generationsScanned,
    skippedLargeRecords,
    failedDatabasesCount,
    diagnostics,
    ledgerCorrupt,
    archivedUnavailable,
    storageWarnings,
    pricingWarnings,
  } = input;

  // 局部浅拷贝防止本次计算的临时告警（如 receipts_unmatched）永久污染调用方的持久 storageWarnings 集合
  const reportStorageWarnings = new Set(storageWarnings);

  let alreadyOrdered = true;
  for (let i = 1; i < effectiveEvents.length; i += 1) {
    const prev = effectiveEvents[i - 1]!;
    const curr = effectiveEvents[i]!;
    const cmp = prev.timestamp_seconds - curr.timestamp_seconds;
    if (cmp > 0 || (cmp === 0 && (prev.event_key ?? '').localeCompare(curr.event_key ?? '') > 0)) {
      alreadyOrdered = false;
      break;
    }
  }
  const orderedEvents = alreadyOrdered
    ? effectiveEvents
    : [...effectiveEvents].sort(
        (a, b) => a.timestamp_seconds - b.timestamp_seconds || (a.event_key ?? '').localeCompare(b.event_key ?? '')
      );
  const anchorMs = Number.isFinite(now) && now > 0 ? now * 1000 : Date.now();
  const todayDate = new Date(anchorMs);
  todayDate.setHours(0, 0, 0, 0);
  const todayStart = Math.floor(todayDate.getTime() / 1000);
  const tomorrowDate = new Date(todayDate); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStart = Math.floor(tomorrowDate.getTime() / 1000);

  // 7天与30天采用本地自然日零点边界，确保总量与每日趋势 100% 对账
  const sevenDaysDate = new Date(todayDate);
  sevenDaysDate.setDate(sevenDaysDate.getDate() - 6);
  const sevenDaysStart = Math.floor(sevenDaysDate.getTime() / 1000);

  const thirtyDaysDate = new Date(todayDate);
  thirtyDaysDate.setDate(thirtyDaysDate.getDate() - 29);
  const thirtyDaysStart = Math.floor(thirtyDaysDate.getTime() / 1000);

  type ModelStatsBucket = {
    in: number;
    out: number;
    cached: number;
    write: number;
    total: number;
    count: number;
    cost: number;
    unpricedTokens: number;
  };
  type PeriodBucket = {
    modelMap: Map<string, ModelStatsBucket>;
    totalIn: number;
    totalOut: number;
    totalCached: number;
    totalWrite: number;
    totalAll: number;
    totalCount: number;
    periodUsd: number;
  };
  const makePeriodBucket = (): PeriodBucket => ({
    modelMap: new Map(),
    totalIn: 0,
    totalOut: 0,
    totalCached: 0,
    totalWrite: 0,
    totalAll: 0,
    totalCount: 0,
    periodUsd: 0,
  });
  const recordToBucket = (bucket: PeriodBucket, ev: GenerationEvent, evCost: number | null, modelName: string) => {
    bucket.totalIn += ev.input_tokens;
    bucket.totalOut += ev.output_tokens;
    bucket.totalCached += ev.cached_tokens;
    bucket.totalWrite += ev.cache_write_tokens ?? 0;
    bucket.totalAll += ev.total_tokens;
    bucket.totalCount++;
    let entry = bucket.modelMap.get(modelName);
    if (!entry) {
      entry = { in: 0, out: 0, cached: 0, write: 0, total: 0, count: 0, cost: 0, unpricedTokens: 0 };
      bucket.modelMap.set(modelName, entry);
    }
    entry.in += ev.input_tokens;
    entry.out += ev.output_tokens;
    entry.cached += ev.cached_tokens;
    entry.write += ev.cache_write_tokens ?? 0;
    entry.total += ev.total_tokens;
    entry.count++;
    if (evCost !== null) {
      entry.cost += evCost;
      bucket.periodUsd += evCost;
    } else {
      entry.unpricedTokens += ev.total_tokens;
    }
  };

  const allTimeBucket = makePeriodBucket();
  const todayBucket = makePeriodBucket();
  const sevenDaysBucket = makePeriodBucket();
  const thirtyDaysBucket = makePeriodBucket();

  const hourlyMap = new Map<string, HourlyTokenUsage>();
  const dailyMap = new Map<string, DailyTokenUsage>();
  const hourlyModels = new Map<string, Map<string, TrendModelBreakdown>>();
  const dailyModels = new Map<string, Map<string, TrendModelBreakdown>>();
  let earliestStartDate = new Date(thirtyDaysDate);
  const maxBackfillDate = new Date(todayDate);
  maxBackfillDate.setDate(maxBackfillDate.getDate() - 365);
  let capturedEarliestPositive = false;
  let unknownTimeRecords = 0;
  let unknownTimeTokens = 0;

  // 单遍分桶聚合：同时产出全部周期、每日趋势、今日分时与未知时间统计，且每条事件只查一次价/锁费率
  for (const ev of orderedEvents) {
    const modelName = resolveDatabaseModelFullName(ev.model, null);
    const ts = ev.timestamp_seconds;
    const evCost = ts > 0
      ? lockedCost(ev, resolvePricing(rawPricing, modelName, ts))
      : null;
    recordToBucket(allTimeBucket, ev, evCost, modelName);

    if (ts <= 0) {
      unknownTimeRecords++;
      unknownTimeTokens += ev.total_tokens;
      continue;
    }

    const d = new Date(ts * 1000);
    if (ts < tomorrowStart) {
      if (!capturedEarliestPositive) {
        capturedEarliestPositive = true;
        const evDay = new Date(d);
        evDay.setHours(0, 0, 0, 0);
        const clamped = evDay < maxBackfillDate ? maxBackfillDate : evDay;
        if (clamped < earliestStartDate) earliestStartDate = clamped;
      }

      const dateStr = formatLocalDate(d);
      let dEntry = dailyMap.get(dateStr);
      if (!dEntry) {
        dEntry = {
          date: dateStr,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 0,
          request_count: 0,
        };
        dailyMap.set(dateStr, dEntry);
      }
      dEntry.input_tokens += ev.input_tokens;
      dEntry.output_tokens += ev.output_tokens;
      dEntry.cached_tokens += ev.cached_tokens;
      if (ev.cache_write_tokens) dEntry.cache_write_tokens = (dEntry.cache_write_tokens ?? 0) + ev.cache_write_tokens;
      dEntry.total_tokens += ev.total_tokens;
      dEntry.request_count++;
      recordTrendModelBreakdown(dailyModels, dateStr, modelName, ev.total_tokens);
    }

    if (ts >= thirtyDaysStart && ts < tomorrowStart) {
      recordToBucket(thirtyDaysBucket, ev, evCost, modelName);
      if (ts >= sevenDaysStart) {
        recordToBucket(sevenDaysBucket, ev, evCost, modelName);
        if (ts >= todayStart) {
          recordToBucket(todayBucket, ev, evCost, modelName);
          const dateStr = formatLocalDate(d);
          const hourStr = `${dateStr} ${String(d.getHours()).padStart(2, '0')}:00`;
          let hEntry = hourlyMap.get(hourStr);
          if (!hEntry) {
            hEntry = {
              hour: hourStr,
              input_tokens: 0,
              output_tokens: 0,
              cached_tokens: 0,
              total_tokens: 0,
              request_count: 0,
            };
            hourlyMap.set(hourStr, hEntry);
          }
          hEntry.input_tokens += ev.input_tokens;
          hEntry.output_tokens += ev.output_tokens;
          hEntry.cached_tokens += ev.cached_tokens;
          if (ev.cache_write_tokens) hEntry.cache_write_tokens = (hEntry.cache_write_tokens ?? 0) + ev.cache_write_tokens;
          hEntry.total_tokens += ev.total_tokens;
          hEntry.request_count++;
          recordTrendModelBreakdown(hourlyModels, hourStr, modelName, ev.total_tokens);
        }
      }
    }
  }

  // 连续自然日零值补齐（至少覆盖近 30 天，至多回溯 365 天）
  for (let cur = new Date(earliestStartDate); cur <= todayDate; cur.setDate(cur.getDate() + 1)) {
    const curStr = formatLocalDate(cur);
    if (!dailyMap.has(curStr)) {
      dailyMap.set(curStr, {
        date: curStr,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 0,
        request_count: 0,
      });
    }
  }

  const rawPricingKeys = Object.keys(rawPricing);
  const currentModelMetaCache = new Map<string, { currentPrice: ApiPricing | null; canonicalKey: string | null }>();
  const getCurrentModelMeta = (mName: string) => {
    let cachedMeta = currentModelMetaCache.get(mName);
    if (!cachedMeta) {
      cachedMeta = {
        currentPrice: resolvePricing(rawPricing, mName, now),
        canonicalKey: matchPricingKeys(mName, rawPricingKeys),
      };
      currentModelMetaCache.set(mName, cachedMeta);
    }
    return cachedMeta;
  };

  const finalizePeriod = (bucket: PeriodBucket): TokenUsagePeriod => {
    const byModel: ModelTokenUsage[] = [];
    let pricedCount = 0;
    let unpricedCount = 0;

    for (const [mName, stats] of bucket.modelMap.entries()) {
      const { currentPrice, canonicalKey } = getCurrentModelMeta(mName);
      const isPriced = stats.unpricedTokens === 0;
      if (isPriced || stats.cost > 0) {
        if (isPriced) pricedCount++; else unpricedCount++;
        const mUsd = Math.round(stats.cost * 1e8) / 1e8;
        byModel.push({
          model: mName,
          input_tokens: stats.in,
          output_tokens: stats.out,
          cached_tokens: stats.cached,
          ...(stats.write > 0 ? { cache_write_tokens: stats.write } : {}),
          total_tokens: stats.total,
          request_count: stats.count,
          estimated_usd: mUsd,
          priced: isPriced,
          partiallyPriced: !isPriced,
          unpriced_tokens: stats.unpricedTokens,
          pricingKey: canonicalKey || mName,
          pricingStatus: currentPrice ? priceStatus(currentPrice, now * 1000) : 'historical',
          pricingProvenance: currentPrice?.provenance ?? null,
        });
      } else {
        unpricedCount++;
        byModel.push({
          model: mName,
          input_tokens: stats.in,
          output_tokens: stats.out,
          cached_tokens: stats.cached,
          ...(stats.write > 0 ? { cache_write_tokens: stats.write } : {}),
          total_tokens: stats.total,
          request_count: stats.count,
          estimated_usd: 0,
          priced: false,
          unpriced_tokens: stats.unpricedTokens,
        });
      }
    }

    byModel.sort((a, b) => b.total_tokens - a.total_tokens);

    return {
      totals: {
        input_tokens: bucket.totalIn,
        output_tokens: bucket.totalOut,
        cached_tokens: bucket.totalCached,
        ...(bucket.totalWrite > 0 ? { cache_write_tokens: bucket.totalWrite } : {}),
        total_tokens: bucket.totalAll,
        request_count: bucket.totalCount,
      },
      estimated_usd: Math.round(bucket.periodUsd * 1e8) / 1e8,
      by_model: byModel,
      priced_models: pricedCount,
      unpriced_models: unpricedCount,
    };
  };

  const totalDiscovered = (lastDiscoveredDatabaseCount || dbPathsCount) + archivedDbCount;
  const totalScanned = dbPathsCount + archivedDbCount;
  const allTimePeriod = finalizePeriod(allTimeBucket);
  const todayPeriod = finalizePeriod(todayBucket);
  const sevenDaysPeriod = finalizePeriod(sevenDaysBucket);
  const thirtyDaysPeriod = finalizePeriod(thirtyDaysBucket);
  const unmatchedReceipts = Object.entries(rateLocks).filter(([key]) => !knownReceiptKeys.has(key));
  if (unmatchedReceipts.length) reportStorageWarnings.add(bt('usage.warn.receipts_unmatched'));
  const hasUnknownTime = unknownTimeRecords > 0;
  const combinedWarnings = [...pricingWarnings, ...reportStorageWarnings];
  const summary: TokenUsageSummary = {
    today: todayPeriod,
    last_7_days: sevenDaysPeriod,
    last_30_days: thirtyDaysPeriod,
    all_time: allTimePeriod,
    unattributed_requests: unattributedRequests,
    unattributed_tokens: unattributedTokens,
    historical_amount_receipts: { unmatchedCount: unmatchedReceipts.length, unmatchedUsd: unmatchedReceipts.reduce((sum, [, receipt]) => sum + receipt.usd, 0) },
    daily_trends: finalizeTrendBreakdowns(dailyMap, dailyModels).sort((a, b) => a.date.localeCompare(b.date)),
    today_hourly: finalizeTrendBreakdowns(hourlyMap, hourlyModels).sort((a, b) => a.hour.localeCompare(b.hour)),
    available_accounts: [...accountMap.values()],
    selected_account_id: accountId || 'all',
    databases_scanned: totalScanned,
    databases_discovered: totalDiscovered,
    scan_scope_description: totalDiscovered > totalScanned
      ? bt('usage.scope.partial_dbs', { scanned: totalScanned, discovered: totalDiscovered })
      : archivedDbCount > 0
        ? bt('usage.scope.all_dbs_with_archived', { scanned: totalScanned, archived: archivedDbCount })
        : bt('usage.scope.all_dbs', { count: dbPathsCount }),
    generations_scanned: generationsScanned,
    skipped_large_records: skippedLargeRecords,
    generated_at: now,
    priced_models: allTimePeriod.priced_models,
    unpriced_models: allTimePeriod.unpriced_models,
    failed_databases_count: failedDatabasesCount,
    has_error: ledgerCorrupt || archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || hasUnknownTime,
    hasError: ledgerCorrupt || archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || hasUnknownTime,
    availability: (failedDatabasesCount > 0 && allEvents.length === 0) || (failedDatabasesCount >= dbPathsCount && dbPathsCount > 0 && liveEventsCount === 0) ? 'unavailable'
      : cachedDatabasesCount === dbPathsCount && dbPathsCount > 0 ? 'cached' : reportStorageWarnings.size > 0 || failedDatabasesCount > 0 || skippedLargeRecords > 0 || hasUnknownTime ? 'partial' : 'complete',
    unknown_time_records: unknownTimeRecords,
    unknown_time_tokens: unknownTimeTokens,
    database_diagnostics: diagnostics,
    snapshot_id: (() => {
      const hash = createHash('sha256');
      hash.update(`account:${accKey}\n`);
      for (const ev of allEvents) {
        hash.update(`${ev.model}|${ev.timestamp_seconds}|${ev.input_tokens}|${ev.output_tokens}|${ev.cached_tokens}|${ev.cache_write_tokens ?? 0}|${ev.total_tokens}\n`);
        hash.update(`locked-cost:${ev.event_key ? rateLocks[ev.event_key]?.usd ?? 'unpriced' : 'unpriced'}\n`);
      }
      hash.update(JSON.stringify([pricing, calKey]));
      return hash.digest('hex').slice(0, 20);
    })(),
    last_attempt_at: now,
    pricing_warnings: combinedWarnings,
    pricing_warning_codes: buildPricingWarningCodes(combinedWarnings),
  };

  return summary;
}

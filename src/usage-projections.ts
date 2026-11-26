import { localizePricingProvenance } from './pricing.js';
import type { HourlyTokenUsage, ModelTokenUsage, TokenUsagePeriod, TokenUsageSummary } from './usage-types.js';

export interface ProjectUsagePeriodOptions {
  includeAllPeriods?: boolean;
  sessionHourly?: HourlyTokenUsage[];
  isSingleDay?: boolean;
  sessionDateLabel?: string;
}

function projectSingleUsagePeriod(usage: TokenUsageSummary, periodInput: unknown, options?: ProjectUsagePeriodOptions) {
  const periodKey: 'today' | 'last_7_days' | 'last_30_days' | 'all_time' =
    periodInput === 'today' ? 'today' : periodInput === '7d' ? 'last_7_days' : periodInput === '30d' ? 'last_30_days' : 'all_time';
  const p: TokenUsagePeriod = usage[periodKey] ?? usage.all_time;
  const byModel = p.by_model.map((m: ModelTokenUsage) => ({
    model: m.model,
    promptTokens: m.input_tokens,
    candidatesTokens: m.output_tokens,
    cachedTokens: m.cached_tokens,
    cacheWriteTokens: m.cache_write_tokens ?? 0,
    totalTokens: m.total_tokens,
    requestCount: m.request_count,
    estimatedUsd: m.estimated_usd,
    priced: m.priced === true,
    partiallyPriced: m.partiallyPriced === true,
    unpricedTokens: m.unpriced_tokens ?? 0,
    pricingKey: m.pricingKey,
    pricingStatus: m.pricingStatus,
    pricingProvenance: localizePricingProvenance(m.pricingProvenance) ?? null,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
    cached_tokens: m.cached_tokens,
    cache_write_tokens: m.cache_write_tokens ?? 0,
    total_tokens: m.total_tokens,
    request_count: m.request_count,
    estimated_usd: m.estimated_usd,
  }));
  const cacheDenom = p.totals.input_tokens + p.totals.cached_tokens + (p.totals.cache_write_tokens ?? 0);
  const cacheHitRate = cacheDenom > 0 ? Math.round((p.totals.cached_tokens / cacheDenom) * 1000) / 10 : 0;
  const lastScannedAt = (usage.availability === 'cached'
    ? usage.generated_at
    : (usage.last_attempt_at ?? usage.generated_at)) ?? 0;
  const periodSummary = {
    ...usage,
    totalTokens: p.totals.total_tokens,
    promptTokens: p.totals.input_tokens,
    candidatesTokens: p.totals.output_tokens,
    cachedTokens: p.totals.cached_tokens,
    cacheWriteTokens: p.totals.cache_write_tokens ?? 0,
    requestCount: p.totals.request_count,
    estimatedUsd: p.estimated_usd,
    cacheHitRate,
    total_tokens: p.totals.total_tokens,
    input_tokens: p.totals.input_tokens,
    output_tokens: p.totals.output_tokens,
    cached_tokens: p.totals.cached_tokens,
    cache_write_tokens: p.totals.cache_write_tokens ?? 0,
    request_count: p.totals.request_count,
    estimated_usd: p.estimated_usd,
    databasesScanned: usage.databases_scanned,
    databasesDiscovered: usage.databases_discovered,
    scanScopeDescription: usage.scan_scope_description,
    pricedModels: p.priced_models ?? usage.priced_models ?? 0,
    unpricedModels: p.unpriced_models ?? usage.unpriced_models ?? 0,
    failedDatabasesCount: usage.failed_databases_count ?? 0,
    skippedLargeRecords: usage.skipped_large_records ?? 0,
    lastScannedAt,
    hasError: usage.has_error === true,
    availability: usage.availability ?? 'complete',
    unknownTimeRecords: usage.unknown_time_records ?? 0,
    unknownTimeTokens: usage.unknown_time_tokens ?? 0,
    databaseDiagnostics: usage.database_diagnostics ?? [],
    selectedAccountId: usage.selected_account_id ?? 'all',
    selected_account_id: usage.selected_account_id ?? 'all',
    availableAccounts: usage.available_accounts ?? [],
    available_accounts: usage.available_accounts ?? [],
  };
  const { today: _t, last_7_days: _w, last_30_days: _m, all_time: _a, daily_trends, today_hourly, ...selectedSummary } = periodSummary;
  const safeDailyTrends = Array.isArray(daily_trends) ? daily_trends : [];
  const safeTodayHourly = Array.isArray(today_hourly) ? today_hourly : [];
  const days = periodInput === 'today' ? 1 : periodInput === '7d' ? 7 : periodInput === '30d' ? 30 : null;
  const selectedTrends = days ? safeDailyTrends.slice(-days) : safeDailyTrends;
  return {
    ok: true,
    period: typeof periodInput === 'string' ? periodInput : 'all',
    snapshotId: usage.snapshot_id,
    selectedAccountId: usage.selected_account_id ?? 'all',
    availableAccounts: usage.available_accounts ?? [],
    summary: selectedSummary,
    byModel,
    models: byModel,
    dailyTrends: selectedTrends,
    todayHourly:
      periodInput === 'today'
        ? safeTodayHourly
        : periodInput === 'session'
          ? (options?.sessionHourly ?? [])
          : [],
    ...(periodInput === 'session'
      ? {
          sessionSingleDay: options?.isSingleDay ?? true,
          sessionDateLabel: options?.sessionDateLabel ?? '',
        }
      : {}),
  };
}

export function projectAllUsagePeriodSummaries(usage: TokenUsageSummary) {
  return {
    today: projectSingleUsagePeriod(usage, 'today'),
    '7d': projectSingleUsagePeriod(usage, '7d'),
    '30d': projectSingleUsagePeriod(usage, '30d'),
    all: projectSingleUsagePeriod(usage, 'all'),
  };
}

export function projectUsagePeriodSummary(usage: TokenUsageSummary, periodInput: unknown, options?: ProjectUsagePeriodOptions) {
  const projected = projectSingleUsagePeriod(usage, periodInput, options);
  if (options?.includeAllPeriods) {
    return {
      ...projected,
      periods: projectAllUsagePeriodSummaries(usage),
    };
  }
  return projected;
}

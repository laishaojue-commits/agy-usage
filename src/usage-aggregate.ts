import type { LedgerEvent } from './usage-ledger-core.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { TokenUsageSummary, TokenUsagePeriod, AvailableAccountUsageOption } from './usage-types.js';
import {
    finalizeTrendBreakdowns,
    recordTrendModelBreakdown,
    resolveDatabaseModelFullName,
    type DailyTokenUsage,
    type HourlyTokenUsage,
    type TrendModelBreakdown,
} from './usage-types.js';
import { getEffectiveModelAliasKeys } from './model-catalog.js';
import { normalizeModelId, THINKING_EFFORT_OR_LATEST_SUFFIX_RE } from './model-identity.js';
import { DEFAULT_API_PRICES, resolveContextTierPricing, resolvePricingForTimestamp, matchPricingKeys, calculateEstimatedUsd, priceStatus, type ApiPricing, type ApiPricingEntry } from './pricing.js';
import { bt } from './i18n.js';

export function isUnpricedZeroSentinel(price: ApiPricing | null | undefined): boolean {
    return Boolean(
        price &&
        !['user', 'confirmed'].includes(price.provenance?.verification ?? '') &&
        [price.input, price.output, price.cached, price.cacheWrite ?? 0].every(value => value === 0)
    );
}

export function calculateLockedEventUsd(
    event: Pick<LedgerEvent, 'input_tokens' | 'output_tokens' | 'cached_tokens' | 'cache_write_tokens'>,
    price: ApiPricing | null | undefined
): number | null {
    if (!price || isUnpricedZeroSentinel(price)) return null;
    const cw = event.cache_write_tokens ?? 0;
    const effective = resolveContextTierPricing(price, event.input_tokens + event.cached_tokens + cw);
    if (cw > 0 && (!Number.isFinite(effective.cacheWrite) || effective.cacheWrite! < 0)) return null;
    return calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, price, cw);
}

export function formatLocalDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
export interface AggregateOptions {
    prices: Record<string, ApiPricingEntry>;
    accountId?: string;
    accounts: Array<{
        id: string;
        email: string;
        name?: string | null;
    }>;
    now: number;
    liveFiles?: string[];
    ignoreLegacyRates?: boolean;
    dryRunRateLocks?: Map<string, { unit_price: string; usd: number }>;
}
export interface LedgerSnapshot {
    revision: number;
    generatedAt: number;
    accountId: string;
    rateRevision: number;
    snapshotId?: string;
}
function period(): TokenUsagePeriod {
    return { totals: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, total_tokens: 0, request_count: 0 }, estimated_usd: 0, by_model: [] };
}
/** Streams indexed ledger rows on the worker. No full-history array reaches the UI process. */
export function aggregateLedger(db: DatabaseSync, options: AggregateOptions): TokenUsageSummary & {
    ledger_snapshot: LedgerSnapshot;
    healed_unpriced_count?: number;
} {
    const now = options.now, today = new Date(now * 1000);
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const seven = new Date(today);
    seven.setDate(seven.getDate() - 6);
    const thirty = new Date(today);
    thirty.setDate(thirty.getDate() - 29);
    const periods = [period(), period(), period(), period()];
    const models = periods.map(() => new Map<string, any>());
    const daily = new Map<string, DailyTokenUsage>(), hourly = new Map<string, HourlyTokenUsage>();
    const dailyModels = new Map<string, Map<string, TrendModelBreakdown>>();
    const hourlyModels = new Map<string, Map<string, TrendModelBreakdown>>();
    const accounts = new Map<string, AvailableAccountUsageOption>();
    accounts.set('all', { id: 'all', label: bt('usage.all_accounts'), type: 'all', total_tokens: 0, request_count: 0 });
    for (const account of options.accounts)
        accounts.set(account.id, { ...account, label: account.email, type: 'account', total_tokens: 0, request_count: 0 });
    const targetEmail = options.accounts.find(account => account.id === options.accountId)?.email.toLowerCase()
        ?? (options.accountId?.includes('@') ? options.accountId.toLowerCase() : '');
    let unknownCount = 0, unknownTokens = 0, unattributedRequests = 0, unattributedTokens = 0;
    const dryRunLocks = options.dryRunRateLocks;
    const extraPriceKeys = Object.keys(options.prices);
    const priceEntries = new Map<string, ApiPricingEntry | undefined>();
    const selectLock = dryRunLocks ? null : db.prepare('SELECT unit_price,usd FROM rate_locks WHERE event_key=?');
    const saveLock = dryRunLocks ? null : db.prepare('INSERT INTO rate_locks(event_key,unit_price,usd) VALUES(?,?,?) ON CONFLICT(event_key) DO UPDATE SET usd=excluded.usd,unit_price=excluded.unit_price');
    const liveFileSet = options.liveFiles ? new Set(options.liveFiles) : null;
    const knownById = new Map(options.accounts.map(acc => [acc.id, acc]));
    const knownByEmail = new Map(options.accounts.map(acc => [acc.email.toLowerCase(), acc]));
    let minPositiveTs = Infinity;
    let changedRateMinSeq = Number.POSITIVE_INFINITY;
    let healedUnpricedCount = 0;
    const firstSequence = dryRunLocks ? null : db.prepare('SELECT MIN(seq) AS seq FROM event_revisions WHERE event_key=?');
    let writeTxOpened = false;
    const ensureWriteTx = () => {
        if (!dryRunLocks && !writeTxOpened) {
            db.exec('BEGIN IMMEDIATE');
            writeTxOpened = true;
        }
    };
    try {
        for (const row of db.prepare('SELECT e.payload,l.unit_price,l.usd FROM events e LEFT JOIN rate_locks l ON l.event_key=e.event_key LEFT JOIN event_aliases a ON a.legacy_key=e.event_key WHERE a.legacy_key IS NULL').iterate()) {
            const event = JSON.parse(String(row.payload)) as LedgerEvent;
            event.model = resolveDatabaseModelFullName(event.model, null);
            if (event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db' || (!event.source_id && event.db_file && liveFileSet?.has(event.db_file)))
                continue;
            if (!event.account_id && !event.account_email) { unattributedRequests++; unattributedTokens += event.total_tokens; }
            const all = accounts.get('all')!;
            all.total_tokens! += event.total_tokens;
            all.request_count!++;
            if (event.account_id || event.account_email) {
                const owner = (event.account_id ? knownById.get(event.account_id) : undefined)
                    ?? (event.account_email ? knownByEmail.get(event.account_email.toLowerCase()) : undefined);
                const id = owner?.id ?? event.account_id ?? event.account_email!;
                const account = accounts.get(id) ?? { id, label: event.account_email ?? id, email: event.account_email, type: 'account' as const, total_tokens: 0, request_count: 0 };
                account.total_tokens! += event.total_tokens;
                account.request_count!++;
                accounts.set(id, account);
            }
            if (options.accountId && options.accountId !== 'all' && event.account_id !== options.accountId && (!targetEmail || event.account_email?.toLowerCase() !== targetEmail))
                continue;
            let cost: number | null = null;
            if (event.timestamp_seconds > 0 && event.event_key) {
                const rawLock = dryRunLocks
                    ? dryRunLocks.get(event.event_key)
                    : (row.unit_price ? { unit_price: String(row.unit_price), usd: Number(row.usd) } : undefined);
                const legacyRow = !options.ignoreLegacyRates && !rawLock && event.legacy_event_key
                    ? (dryRunLocks
                        ? dryRunLocks.get(event.legacy_event_key)
                        : (() => {
                            const r = selectLock!.get(event.legacy_event_key);
                            return r && r.unit_price !== null && r.unit_price !== undefined
                                ? { unit_price: String(r.unit_price), usd: Number(r.usd) }
                                : undefined;
                        })())
                    : undefined;
                const lockPrice = rawLock?.unit_price ?? legacyRow?.unit_price;
                const key = event.model;
                if (!priceEntries.has(key))
                    priceEntries.set(key, options.prices[key] ?? options.prices[matchPricingKeys(key, extraPriceKeys)]);
                const locked = lockPrice ? JSON.parse(String(lockPrice)) as ApiPricing : null;
                const zeroSentinel = isUnpricedZeroSentinel(locked);
                const cw = event.cache_write_tokens ?? 0;
                const lockedMissingCw = Boolean(
                    locked &&
                    cw > 0 &&
                    (() => {
                        const eff = resolveContextTierPricing(locked, event.input_tokens + event.cached_tokens + cw);
                        return !Number.isFinite(eff.cacheWrite) || eff.cacheWrite! < 0;
                    })()
                );
                const canReuseLocked = Boolean(locked && !zeroSentinel && !lockedMissingCw);
                const price = canReuseLocked ? locked : resolvePricingForTimestamp(priceEntries.get(key), event.timestamp_seconds, key);
                const effectivePrice = price ? resolveContextTierPricing(price, event.input_tokens + event.cached_tokens + cw) : null;
                if (price && effectivePrice && (cw === 0 || (Number.isFinite(effectivePrice.cacheWrite) && effectivePrice.cacheWrite! >= 0))) {
                    const existingUsd = rawLock?.usd;
                    cost = canReuseLocked && !event.source_id && existingUsd !== null && existingUsd !== undefined
                        ? Number(existingUsd)
                        : calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, price, cw);
                    if (!rawLock || zeroSentinel || lockedMissingCw || Number(existingUsd) !== cost) {
                        const { intervals: _intervals, ...compactPrice } = price as any;
                        const compactJson = JSON.stringify(compactPrice);
                        if (dryRunLocks) {
                            dryRunLocks.set(event.event_key, { unit_price: compactJson, usd: cost });
                        } else {
                            ensureWriteTx();
                            saveLock!.run(event.event_key, compactJson, cost);
                            if (!rawLock || zeroSentinel || lockedMissingCw)
                                changedRateMinSeq = Math.min(changedRateMinSeq, Number(firstSequence!.get(event.event_key)?.seq ?? 0));
                        }
                        if (!rawLock || zeroSentinel || lockedMissingCw) healedUnpricedCount++;
                    }
                }
            }
            const tomorrowStartSeconds = tomorrow.getTime() / 1000;
            const flags = [event.timestamp_seconds >= today.getTime() / 1000 && event.timestamp_seconds < tomorrowStartSeconds,
                event.timestamp_seconds >= seven.getTime() / 1000 && event.timestamp_seconds < tomorrowStartSeconds,
                event.timestamp_seconds >= thirty.getTime() / 1000 && event.timestamp_seconds < tomorrowStartSeconds, true];
            for (let index = 0; index < 4; index++)
                if (flags[index]) {
                    const result = periods[index]!;
                    for (const key of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'total_tokens'] as const)
                        result.totals[key] = (result.totals[key] ?? 0) + (event[key] ?? 0);
                    result.totals.request_count++;
                    result.estimated_usd += cost ?? 0;
                    const model = models[index]!.get(event.model) ?? { model: event.model, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, total_tokens: 0, request_count: 0, estimated_usd: 0, unpriced_tokens: 0 };
                    for (const key of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'total_tokens'] as const)
                        model[key] += event[key] ?? 0;
                    model.request_count++;
                    model.estimated_usd += cost ?? 0;
                    if (cost === null)
                        model.unpriced_tokens += event.total_tokens;
                    models[index]!.set(event.model, model);
                }
            if (event.timestamp_seconds <= 0) {
                unknownCount++;
                unknownTokens += event.total_tokens;
                continue;
            }
            // 次日零点之后的轻微未来时钟偏移事件仍保留在 all_time 中，但不写入 daily_trends，防止 7/30 天趋势切片右移一天
            if (event.timestamp_seconds < tomorrowStartSeconds) {
                if (event.timestamp_seconds < minPositiveTs) minPositiveTs = event.timestamp_seconds;
                const date = new Date(event.timestamp_seconds * 1000), day = formatLocalDate(date);
                const addTrend = (
                    map: Map<string, any>,
                    modelBuckets: Map<string, Map<string, TrendModelBreakdown>>,
                    key: string,
                    attribute: string
                ) => {
                    const value = map.get(key) ?? { [attribute]: key, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, total_tokens: 0, request_count: 0 };
                    for (const column of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'total_tokens'] as const)
                        value[column] += event[column] ?? 0;
                    value.request_count++;
                    map.set(key, value);
                    recordTrendModelBreakdown(modelBuckets, key, event.model, event.total_tokens);
                };
                addTrend(daily, dailyModels, day, 'date');
                if (flags[0])
                    addTrend(hourly, hourlyModels, `${day} ${String(date.getHours()).padStart(2, '0')}:00`, 'hour');
            }
        }
        if (writeTxOpened) {
            if (Number.isFinite(changedRateMinSeq))
                db.prepare('INSERT INTO rate_changes VALUES((SELECT COALESCE(MAX(version),0)+1 FROM rate_changes),?)').run(changedRateMinSeq);
            db.exec('COMMIT');
        }
    }
    catch (error) {
        if (writeTxOpened) db.exec('ROLLBACK');
        throw error;
    }
    for (let index = 0; index < 4; index++) {
        const result = periods[index]!;
        result.by_model = [...models[index]!.values()].map(model => {
            const isPriced = model.unpriced_tokens === 0;
            const isPartial = model.unpriced_tokens > 0 && model.unpriced_tokens < model.total_tokens;
            const matchedPricingKey = matchPricingKeys(model.model, extraPriceKeys);
            const entry = options.prices[model.model] ?? options.prices[matchedPricingKey];
            const price = resolvePricingForTimestamp(entry, now, model.model);
            return {
                ...model,
                estimated_usd: Math.round(model.estimated_usd * 1e8) / 1e8,
                priced: isPriced,
                ...(isPartial ? { partiallyPriced: true } : {}),
                ...(isPriced || isPartial ? {
                    pricingKey: matchedPricingKey,
                    pricingStatus: price ? priceStatus(price, now * 1000) : 'historical',
                    pricingProvenance: price?.provenance ?? null,
                } : {}),
            };
        }).sort((a, b) => b.total_tokens - a.total_tokens);
        result.priced_models = result.by_model.filter(model => model.priced).length;
        result.unpriced_models = result.by_model.length - result.priced_models;
        result.estimated_usd = Math.round(result.estimated_usd * 1e8) / 1e8;
    }
    let earliestStartDate = new Date(thirty);
    if (Number.isFinite(minPositiveTs)) {
        const minDate = new Date(minPositiveTs * 1000);
        minDate.setHours(0, 0, 0, 0);
        const maxHistoryCap = new Date(today);
        maxHistoryCap.setDate(maxHistoryCap.getDate() - 365);
        const boundedMin = minDate < maxHistoryCap ? maxHistoryCap : minDate;
        if (boundedMin < earliestStartDate) earliestStartDate = boundedMin;
    }
    for (const date = new Date(earliestStartDate); date <= today; date.setDate(date.getDate() + 1)) {
        const key = formatLocalDate(date);
        if (!daily.has(key))
            daily.set(key, { date: key, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, total_tokens: 0, request_count: 0 });
    }
    const revision = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS revision FROM event_revisions').get()?.revision);
    const accountId = options.accountId ?? 'all';
    const rateRevision = Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM rate_changes').get()?.version);
    const snapshot: LedgerSnapshot = { revision, generatedAt: now, accountId, rateRevision };
    const hash = createHash('sha256').update(JSON.stringify([revision, accountId, formatLocalDate(today), options.prices])).digest('hex').slice(0, 20);
    snapshot.snapshotId = hash;
    if (!dryRunLocks) {
        db.prepare('INSERT INTO snapshot_pins VALUES(?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET expires=excluded.expires').run(hash, revision, Date.now() + 600000);
    }
    const receipts = db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(l.usd),0) AS usd FROM rate_locks l LEFT JOIN events e ON e.event_key=l.event_key LEFT JOIN event_aliases a ON a.legacy_key=l.event_key WHERE e.event_key IS NULL AND a.legacy_key IS NULL').get();
    return { unattributed_requests: unattributedRequests, unattributed_tokens: unattributedTokens, historical_amount_receipts: { unmatchedCount: Number(receipts?.count ?? 0), unmatchedUsd: Number(receipts?.usd ?? 0) }, today: periods[0]!, last_7_days: periods[1]!, last_30_days: periods[2]!, all_time: periods[3]!, daily_trends: finalizeTrendBreakdowns(daily, dailyModels).sort((a, b) => a.date.localeCompare(b.date)), today_hourly: finalizeTrendBreakdowns(hourly, hourlyModels).sort((a, b) => a.hour.localeCompare(b.hour)),
        available_accounts: [...accounts.values()], selected_account_id: accountId,
        unknown_time_records: unknownCount, unknown_time_tokens: unknownTokens,
        databases_scanned: 0, generations_scanned: 0, skipped_large_records: 0, generated_at: now, snapshot_id: hash,
        availability: unknownCount ? 'partial' : 'complete', ledger_snapshot: snapshot, healed_unpriced_count: healedUnpricedCount };
}
export function createModelQueryMatcher(rawQuery: string): (candidate: string) => boolean {
    const qLower = rawQuery.trim().toLowerCase();
    const qNorm = qLower ? normalizeModelId(rawQuery) : '';
    const qCleanNorm = qNorm.replace(THINKING_EFFORT_OR_LATEST_SUFFIX_RE, '');
    return (candidate: string): boolean => {
        if (!qLower) return true;
        const candLower = candidate.toLowerCase();
        const resolvedLower = resolveDatabaseModelFullName(candidate, null).toLowerCase();
        const candNorm = normalizeModelId(candidate);
        const resolvedNorm = normalizeModelId(resolvedLower);
        if (candLower.includes(qLower) || resolvedLower.includes(qLower)) return true;
        if (qNorm && (candNorm.includes(qNorm) || resolvedNorm.includes(qNorm))) return true;
        if (qCleanNorm && (candNorm.includes(qCleanNorm) || resolvedNorm.includes(qCleanNorm))) return true;
        return false;
    };
}

export function ledgerEventPage(db: DatabaseSync, options: {
    snapshot: LedgerSnapshot;
    period: string;
    query: string;
    offset: number;
    limit: number;
    targetEmail?: string;
}) {
    const { snapshot } = options;
    if (!snapshot.snapshotId || !db.prepare('SELECT 1 AS pinned FROM snapshot_pins WHERE snapshot_id=? AND expires>=?').get(snapshot.snapshotId, Date.now()))
        throw Error(bt('usage.err.snapshot_expired'));
    db.prepare('UPDATE snapshot_pins SET expires=? WHERE snapshot_id=?').run(Date.now() + 600000, snapshot.snapshotId);
    if (db.prepare('SELECT 1 AS changed FROM rate_changes WHERE version>? AND min_event_seq<=? LIMIT 1').get(snapshot.rateRevision, snapshot.revision))
        throw Error(bt('usage.err.rates_changed_reexport'));
    const start = new Date(snapshot.generatedAt * 1000);
    start.setHours(0, 0, 0, 0);
    if (options.period === '7d')
        start.setDate(start.getDate() - 6);
    if (options.period === '30d')
        start.setDate(start.getDate() - 29);
    const end = new Date(snapshot.generatedAt * 1000);
    end.setHours(24, 0, 0, 0);
    const rawQuery = options.query ?? '';
    const qLower = rawQuery.trim().toLowerCase();
    const qNorm = qLower ? normalizeModelId(rawQuery) : '';
    const qCleanNorm = qNorm.replace(THINKING_EFFORT_OR_LATEST_SUFFIX_RE, '');
    const modelMatchesQuery = createModelQueryMatcher(rawQuery);
    const aliasMatchSet = new Set<string>();
    if (qLower) {
        for (const candidate of [...getEffectiveModelAliasKeys(), ...Object.keys(DEFAULT_API_PRICES)]) {
            if (modelMatchesQuery(candidate)) {
                aliasMatchSet.add(candidate.toLowerCase());
                aliasMatchSet.add(resolveDatabaseModelFullName(candidate, null).toLowerCase());
                const norm = normalizeModelId(candidate);
                if (norm) aliasMatchSet.add(norm);
            }
        }
        if (modelMatchesQuery('未知模型') || modelMatchesQuery('Unknown Model')) {
            aliasMatchSet.add('未知模型');
            aliasMatchSet.add('unknown model');
        }
        for (const row of db.prepare("SELECT DISTINCT json_extract(payload,'$.model') AS m FROM event_revisions WHERE seq<=?").all(snapshot.revision)) {
            if (typeof row.m === 'string' && row.m && modelMatchesQuery(row.m)) {
                aliasMatchSet.add(row.m.toLowerCase());
                if (aliasMatchSet.size >= 500) break;
            }
        }
    }
    const aliasMatches = [...aliasMatchSet];
    const likePatterns = ['%' + rawQuery.replace(/[\\%_]/g, '\\$&') + '%'];
    if (qCleanNorm && qCleanNorm !== qLower) {
        likePatterns.push('%' + qCleanNorm.replace(/[\\%_]/g, '\\$&') + '%');
    }
    const likeClauses = likePatterns.map(() => "json_extract(r.payload,'$.model') LIKE ? ESCAPE '\\'").join(' OR ');
    const modelClause = aliasMatches.length > 0
        ? `(${likeClauses} OR lower(json_extract(r.payload,'$.model')) IN (${aliasMatches.map(() => '?').join(',')}))`
        : `(${likeClauses})`;
    const conditions = [
        'r.seq<=?',
        'NOT EXISTS(SELECT 1 FROM event_revisions n WHERE n.event_key=r.event_key AND n.seq>r.seq AND n.seq<=?)',
        'NOT EXISTS(SELECT 1 FROM event_aliases a WHERE a.legacy_key=r.event_key)',
        "COALESCE(json_extract(r.payload,'$.db_file'),'') NOT IN ('recovered_session.db','recovered_enterprise_session.db')",
        modelClause,
    ];
    const params: Array<string | number> = [
        snapshot.revision,
        snapshot.revision,
        ...likePatterns,
        ...aliasMatches,
    ];
    if (options.period !== 'all') {
        conditions.push('r.timestamp>=? AND r.timestamp<?');
        params.push(start.getTime() / 1000, end.getTime() / 1000);
    }
    if (snapshot.accountId !== 'all') {
        conditions.push("(json_extract(r.payload,'$.account_id')=? OR lower(json_extract(r.payload,'$.account_email'))=?)");
        params.push(snapshot.accountId, options.targetEmail?.toLowerCase() || snapshot.accountId.toLowerCase());
    }
    const where = conditions.join(' AND ');
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM event_revisions r WHERE ${where}`).get(...params)?.count);
    const rows = db.prepare(`SELECT r.payload,l.unit_price FROM event_revisions r LEFT JOIN rate_locks l ON l.event_key=r.event_key WHERE ${where} ORDER BY r.timestamp DESC,r.seq DESC LIMIT ? OFFSET ?`).all(...params, options.limit, options.offset).map(row => {
        const event = JSON.parse(String(row.payload)) as LedgerEvent;
        event.model = resolveDatabaseModelFullName(event.model, null);
        const price = row.unit_price ? JSON.parse(String(row.unit_price)) as ApiPricing : null;
        const cost = event.timestamp_seconds > 0 ? calculateLockedEventUsd(event, price) : null;
        const { event_key: _key, source_id: _source, legacy_event_key: _legacy, ...publicEvent } = event;
        return { ...publicEvent, estimated_usd: cost, priced: cost !== null };
    });
    return { rows, total, offset: options.offset, limit: options.limit };
}

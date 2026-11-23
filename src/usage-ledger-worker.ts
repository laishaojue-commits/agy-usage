import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { LedgerEvent } from './usage-ledger-core.js';
import { aggregateLedger, ledgerEventPage } from './usage-aggregate.js';
import { revalueLedger } from './usage-revalue.js';
import {
    registerObservedIdeModels,
    resetAndRegisterRemoteModelMetadata,
    type ObservedIdeModelEntry,
} from './model-catalog.js';
import { PRICING_METADATA } from './pricing.js';
import { compareFeedFreshness } from './usage-pricing.js';
import { bt, setActiveLocale } from './i18n.js';
import { isOwnedByCurrentUser, safeChmodSync } from './platform/fs-guard.js';
export function validLedgerEvent(event: unknown): event is LedgerEvent {
    if (!event || typeof event !== 'object')
        return false;
    const row = event as LedgerEvent;
    return typeof row.event_key === 'string' && row.event_key.length > 0 && typeof row.model === 'string'
        && ['input_tokens', 'output_tokens', 'cached_tokens', 'total_tokens', 'timestamp_seconds'].every(key => {
            const value = row[key as keyof LedgerEvent];
            return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
        }) && (row.cache_write_tokens === undefined || Number.isSafeInteger(row.cache_write_tokens) && row.cache_write_tokens >= 0)
        && row.total_tokens === row.input_tokens + row.output_tokens + row.cached_tokens + (row.cache_write_tokens ?? 0);
}
const isSyntheticRecoveredDb = (dbFile?: string) =>
    dbFile === 'recovered_session.db' || dbFile === 'recovered_enterprise_session.db';

function compactUnitPrice(price: any) {
    if (!price || typeof price !== 'object') return price;
    const { intervals: _intervals, ...rest } = price;
    return rest;
}

function regular(path: string) {
    const stat = lstatSync(path);
    if (!isOwnedByCurrentUser(stat))
        throw Error(bt('ledger.err.file_identity_mismatch'));
}
interface LegacyBaselineCache {
    path: string;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    events: LedgerEvent[];
}
let cachedLegacyBaseline: LegacyBaselineCache | null = null;
const importedRatesStamps = new Map<string, string>();
const importedLegacyStamps = new Map<string, string>();

let cachedWorkerRemoteMeta: {
    path: string;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
} | null = null;

let cachedWorkerObservedIdeModels: {
    path: string;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
} | null = null;

function syncWorkerObservedIdeModels(ledgerPath: string): void {
    const ideModelsPath = join(dirname(ledgerPath), 'live-ide-models.json');
    if (!existsSync(ideModelsPath)) {
        return;
    }
    try {
        regular(ideModelsPath);
        const stat = lstatSync(ideModelsPath);
        if (stat.size > 2 * 1024 * 1024) return;
        if (
            cachedWorkerObservedIdeModels &&
            cachedWorkerObservedIdeModels.path === ideModelsPath &&
            cachedWorkerObservedIdeModels.dev === stat.dev &&
            cachedWorkerObservedIdeModels.ino === stat.ino &&
            cachedWorkerObservedIdeModels.size === stat.size &&
            cachedWorkerObservedIdeModels.mtimeMs === stat.mtimeMs
        ) {
            return;
        }
        const parsed = JSON.parse(readFileSync(ideModelsPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || (parsed.schema !== 1 && parsed.schema !== 2) || !Array.isArray(parsed.models)) {
            return;
        }
        const entries: ObservedIdeModelEntry[] = [];
        for (const raw of parsed.models.slice(0, 256)) {
            if (!raw || typeof raw !== 'object') continue;
            const m = raw as Record<string, unknown>;
            const modelId = typeof m.id === 'string'
                ? m.id.trim()
                : (typeof m.model_id === 'string' ? m.model_id.trim() : '');
            const modelOrAlias = typeof m.modelOrAlias === 'string' && m.modelOrAlias.trim()
                ? m.modelOrAlias.trim()
                : (typeof m.model_or_alias === 'string' && m.model_or_alias.trim() ? m.model_or_alias.trim() : null);
            if (!modelId && !modelOrAlias) continue;
            const displayName = typeof m.displayName === 'string' && m.displayName.trim()
                ? m.displayName.trim()
                : (typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : null);
            const rawMaxTokens = m.maxTokens ?? m.max_tokens;
            const rawMaxOut = m.maxOutputTokens ?? m.max_output_tokens;
            const rawProvider = m.modelProvider ?? m.model_provider;
            const rawIsInternal = m.isInternal ?? m.is_internal;
            const rawDeprecated = m.deprecated;
            const rawNonChat = m.nonChatSpecialized ?? m.non_chat_specialized;
            const rawInSelector = m.inModelSelector ?? m.in_model_selector;
            entries.push({
                modelId: modelId || modelOrAlias!,
                displayName,
                modelOrAlias,
                ...(typeof rawMaxTokens === 'number' && Number.isFinite(rawMaxTokens) ? { maxTokens: Math.trunc(rawMaxTokens) } : {}),
                ...(typeof rawMaxOut === 'number' && Number.isFinite(rawMaxOut) ? { maxOutputTokens: Math.trunc(rawMaxOut) } : {}),
                ...(typeof rawProvider === 'string' && rawProvider.trim() ? { modelProvider: rawProvider.trim() } : {}),
                ...(typeof rawIsInternal === 'boolean' ? { isInternal: rawIsInternal } : {}),
                ...(typeof rawDeprecated === 'boolean' ? { deprecated: rawDeprecated } : {}),
                ...(typeof rawNonChat === 'boolean' ? { nonChatSpecialized: rawNonChat } : {}),
                ...(typeof rawInSelector === 'boolean' || rawInSelector === null ? { inModelSelector: rawInSelector } : {}),
            });
        }
        if (entries.length > 0) {
            registerObservedIdeModels(entries);
        }
        cachedWorkerObservedIdeModels = {
            path: ideModelsPath,
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        };
    } catch {
        // live-ide-models.json 可读性异常时降级保留已有元数据
    }
}

function syncWorkerRemoteMetadata(ledgerPath: string): void {
    const remotePath = join(dirname(ledgerPath), 'remote_pricing.json');
    if (!existsSync(remotePath)) {
        if (cachedWorkerRemoteMeta) {
            cachedWorkerRemoteMeta = null;
            resetAndRegisterRemoteModelMetadata({});
        }
        return;
    }
    try {
        regular(remotePath);
        const stat = lstatSync(remotePath);
        if (stat.size > 2 * 1024 * 1024) return;
        if (
            cachedWorkerRemoteMeta &&
            cachedWorkerRemoteMeta.path === remotePath &&
            cachedWorkerRemoteMeta.dev === stat.dev &&
            cachedWorkerRemoteMeta.ino === stat.ino &&
            cachedWorkerRemoteMeta.size === stat.size &&
            cachedWorkerRemoteMeta.mtimeMs === stat.mtimeMs
        ) {
            return;
        }
        const parsed = JSON.parse(readFileSync(remotePath, 'utf8'));
        const remoteVer = typeof parsed?.feedVersion === 'string' ? parsed.feedVersion.trim() : '';
        const remoteUpdatedAt = typeof parsed?.feedUpdatedAt === 'string'
          ? parsed.feedUpdatedAt.trim()
          : (typeof parsed?.updatedAt === 'string' ? parsed.updatedAt.trim() : '');
        const verCmp = compareFeedFreshness(
          { version: remoteVer, updatedAt: remoteUpdatedAt },
          { version: PRICING_METADATA.version, updatedAt: PRICING_METADATA.updatedAt }
        );
        const isOlderDatedFeed = verCmp !== null && verCmp < 0;
        resetAndRegisterRemoteModelMetadata(parsed, {
          onlyNewEntries: isOlderDatedFeed,
          authoritativeSnapshot: !isOlderDatedFeed,
        });
        cachedWorkerRemoteMeta = {
            path: remotePath,
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        };
    } catch {
        // 远端缓存可读性异常时降级保留已有静态元数据
    }
}

function ensureImportedLegacyBaseline(db: DatabaseSync, dbPath: string, legacyPath: string, legacyEvents: LedgerEvent[]): void {
    const dbStat = existsSync(dbPath) ? lstatSync(dbPath) : null;
    const dbIdentity = dbStat ? `${dbPath}|${dbStat.dev}:${dbStat.ino}` : dbPath;
    const ratesPath = join(dirname(dbPath), 'usage-rate-locks.json');
    if (existsSync(ratesPath)) {
        regular(ratesPath);
        const ratesStat = lstatSync(ratesPath);
        if (ratesStat.size > 16 * 1024 * 1024)
            throw Error(bt('ledger.err.legacy_rates_budget'));
        const ratesStamp = `${ratesStat.dev}:${ratesStat.ino}:${ratesStat.size}:${ratesStat.mtimeMs}`;
        if (importedRatesStamps.get(dbIdentity) !== ratesStamp) {
            const rates = JSON.parse(readFileSync(ratesPath, 'utf8'));
            if (rates.version !== 1 || !rates.entries || typeof rates.entries !== 'object')
                throw Error(bt('ledger.err.legacy_rates_invalid'));
            const entries = Object.entries<any>(rates.entries);
            if (entries.length > 0) {
                const insertRate = db.prepare('INSERT OR IGNORE INTO rate_locks VALUES(?,?,?)');
                db.exec('BEGIN IMMEDIATE');
                try {
                    for (const [key, item] of entries) {
                        const price = compactUnitPrice(item.price ?? rates.profiles?.[item.p]);
                        if (!price || !Number.isFinite(item.usd) || item.usd < 0)
                            throw Error(bt('ledger.err.legacy_rate_entry_invalid'));
                        insertRate.run(key, JSON.stringify(price), item.usd);
                    }
                    db.exec('COMMIT');
                }
                catch (error) {
                    db.exec('ROLLBACK');
                    throw error;
                }
            }
            importedRatesStamps.set(dbIdentity, ratesStamp);
        }
    }
    const legacyStamp = cachedLegacyBaseline?.path === legacyPath
        ? `${cachedLegacyBaseline.dev}:${cachedLegacyBaseline.ino}:${cachedLegacyBaseline.size}:${cachedLegacyBaseline.mtimeMs}`
        : `len:${legacyEvents.length}`;
    if (legacyEvents.length > 0 && importedLegacyStamps.get(dbIdentity) !== legacyStamp) {
        const importable = legacyEvents.filter(event => !isSyntheticRecoveredDb(event.db_file));
        if (importable.length > 0) {
            const insert = db.prepare('INSERT OR IGNORE INTO events(event_key,timestamp,account_id,model,payload) VALUES(?,?,?,?,?)');
            const revision = db.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)');
            db.exec('BEGIN IMMEDIATE');
            try {
                for (const event of importable) {
                    const payload = JSON.stringify({ ...event, account_id: undefined, account_email: undefined, account_confidence: 'legacy' });
                    if (insert.run(event.event_key!, event.timestamp_seconds, null, event.model, payload).changes)
                        revision.run(event.event_key!, event.timestamp_seconds, payload);
                }
                db.exec('COMMIT');
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        }
        importedLegacyStamps.set(dbIdentity, legacyStamp);
    }
}

function readValidatedLegacyEvents(legacyPath: string): LedgerEvent[] {
    if (!existsSync(legacyPath)) {
        if (cachedLegacyBaseline?.path === legacyPath) cachedLegacyBaseline = null;
        return [];
    }
    const stat = lstatSync(legacyPath);
    if (!isOwnedByCurrentUser(stat))
        throw Error(bt('ledger.err.file_identity_mismatch'));
    if (stat.size > 64 * 1024 * 1024)
        throw Error(bt('ledger.err.legacy_json_budget'));
    if (
        cachedLegacyBaseline &&
        cachedLegacyBaseline.path === legacyPath &&
        cachedLegacyBaseline.dev === stat.dev &&
        cachedLegacyBaseline.ino === stat.ino &&
        cachedLegacyBaseline.size === stat.size &&
        cachedLegacyBaseline.mtimeMs === stat.mtimeMs
    ) {
        return cachedLegacyBaseline.events;
    }
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
    if (![1, 2].includes(legacy?.version) || !Array.isArray(legacy.events) || !legacy.events.every(validLedgerEvent)) {
        throw Error(bt('ledger.err.legacy_corrupt'));
    }
    cachedLegacyBaseline = {
        path: legacyPath,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        events: legacy.events,
    };
    return legacy.events;
}

function mergeLegacyMetadataIntoEvent(target: LedgerEvent, old: LedgerEvent): void {
    if (old.ingested_at && (!target.ingested_at || old.ingested_at < target.ingested_at)) {
        target.ingested_at = old.ingested_at;
    }
    if (old.account_confidence === 'observed') {
        if (!target.account_id) {
            target.account_id = old.account_id;
            target.account_email = old.account_email;
            target.account_confidence = 'observed';
        }
        if (old.account_type && old.account_type !== 'unknown' && (!target.account_type || target.account_type === 'unknown')) {
            target.account_type = old.account_type;
        }
    }
    if (!target.timestamp_seconds && old.timestamp_seconds > 0) {
        target.timestamp_seconds = old.timestamp_seconds;
    }
}

interface LegacyCandidateRow {
    event_key: string;
    payload: string;
    observed_at: number;
    parsed: LedgerEvent;
}

function findMatchingLegacyRows(
    stmt: ReturnType<DatabaseSync['prepare']>,
    legacyKey: string,
    excludeKey: string,
    dbFile?: string
): LegacyCandidateRow[] {
    const rows = stmt.all(legacyKey, excludeKey) as Array<{ event_key: string; payload: string; observed_at: number }>;
    const matched: LegacyCandidateRow[] = [];
    for (const row of rows) {
        try {
            const parsed = JSON.parse(String(row.payload)) as LedgerEvent;
            if (
                parsed.legacy_event_key === legacyKey &&
                (!dbFile || !parsed.db_file || parsed.db_file === dbFile)
            ) {
                matched.push({
                    event_key: String(row.event_key),
                    payload: String(row.payload),
                    observed_at: Number(row.observed_at ?? 0),
                    parsed,
                });
            }
        } catch {
            // ignore unparseable historical row
        }
    }
    matched.sort((a, b) => a.observed_at - b.observed_at);
    return matched;
}

const DEDUP_MAINTENANCE_KEY = 'dedup_legacy_aliases_v1';

function reconcileDuplicateLegacyAliases(db: DatabaseSync): void {
    const done = db.prepare('SELECT last_run FROM ledger_maintenance WHERE key=?').get(DEDUP_MAINTENANCE_KEY);
    if (done) return;

    const dupRows = db.prepare(`
        SELECT e.event_key, e.timestamp, e.observed_at, e.payload,
               json_extract(e.payload, '$.legacy_event_key') AS leg
        FROM events e
        JOIN (
            SELECT json_extract(e2.payload, '$.legacy_event_key') AS leg
            FROM events e2
            LEFT JOIN event_aliases a2 ON a2.legacy_key = e2.event_key
            WHERE a2.legacy_key IS NULL
              AND COALESCE(json_extract(e2.payload, '$.db_file'), '') NOT IN ('recovered_session.db', 'recovered_enterprise_session.db')
              AND json_extract(e2.payload, '$.legacy_event_key') IS NOT NULL
            GROUP BY leg
            HAVING COUNT(*) > 1
        ) d ON json_extract(e.payload, '$.legacy_event_key') = d.leg
        LEFT JOIN event_aliases a ON a.legacy_key = e.event_key
        WHERE a.legacy_key IS NULL
          AND COALESCE(json_extract(e.payload, '$.db_file'), '') NOT IN ('recovered_session.db', 'recovered_enterprise_session.db')
    `).all() as Array<{ event_key: string; timestamp: number; observed_at: number; payload: string; leg: string }>;

    if (dupRows.length === 0) {
        db.prepare('INSERT OR REPLACE INTO ledger_maintenance VALUES(?,?)').run(DEDUP_MAINTENANCE_KEY, Date.now());
        return;
    }

    const byLegacy = new Map<string, Array<{ event_key: string; timestamp: number; observed_at: number; payload: string; parsed: LedgerEvent }>>();
    for (const row of dupRows) {
        try {
            const parsed = JSON.parse(String(row.payload)) as LedgerEvent;
            const arr = byLegacy.get(row.leg) ?? [];
            arr.push({
                event_key: String(row.event_key),
                timestamp: Number(row.timestamp ?? 0),
                observed_at: Number(row.observed_at ?? 0),
                payload: String(row.payload),
                parsed,
            });
            byLegacy.set(row.leg, arr);
        } catch {
            // ignore
        }
    }

    const alias = db.prepare('INSERT OR REPLACE INTO event_aliases VALUES(?,?)');
    const redirectAlias = db.prepare('UPDATE event_aliases SET event_key=? WHERE event_key=?');
    const deleteSelfAlias = db.prepare('DELETE FROM event_aliases WHERE legacy_key=?');
    const copyLock = db.prepare('INSERT OR IGNORE INTO rate_locks(event_key,unit_price,usd) SELECT ?,unit_price,usd FROM rate_locks WHERE event_key=?');
    const updateWinner = db.prepare('UPDATE events SET timestamp=?,account_id=?,payload=?,observed_at=? WHERE event_key=?');
    const insertRevision = db.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)');

    const scoreCandidate = (item: { event_key: string; timestamp: number; observed_at: number; parsed: LedgerEvent }): [number, number, number, number] => [
        item.parsed.source_id ? 1 : 0,
        item.observed_at,
        item.timestamp > 0 ? 1 : 0,
        item.parsed.account_confidence === 'observed' ? 1 : 0,
    ];
    const compareCandidate = (
        a: { event_key: string; timestamp: number; observed_at: number; parsed: LedgerEvent },
        b: { event_key: string; timestamp: number; observed_at: number; parsed: LedgerEvent }
    ): number => {
        const sa = scoreCandidate(a);
        const sb = scoreCandidate(b);
        for (let i = 0; i < sa.length; i++) {
            if (sb[i]! !== sa[i]!) return sb[i]! - sa[i]!;
        }
        return b.event_key < a.event_key ? -1 : b.event_key > a.event_key ? 1 : 0;
    };

    let reconciledGroups = 0;
    let revisionsInserted = 0;
    let lastWinner: { event_key: string; timestamp: number; payload: string } | null = null;

    db.exec('BEGIN IMMEDIATE');
    try {
        for (const [leg, items] of byLegacy.entries()) {
            const buckets = new Map<string, typeof items>();
            for (const item of items) {
                const dbName = typeof item.parsed.db_file === 'string' ? item.parsed.db_file : '';
                const list = buckets.get(dbName) ?? [];
                list.push(item);
                buckets.set(dbName, list);
            }
            const emptyBucket = buckets.get('');
            if (emptyBucket && buckets.size === 2) {
                for (const [dbName, list] of buckets.entries()) {
                    if (dbName !== '') {
                        list.push(...emptyBucket);
                        buckets.delete('');
                        break;
                    }
                }
            }
            for (const bucket of buckets.values()) {
                if (bucket.length <= 1) continue;
                bucket.sort(compareCandidate);
                const winner = bucket[0]!;
                const merged: LedgerEvent = { ...winner.parsed };
                let maxObserved = winner.observed_at;
                for (let i = bucket.length - 1; i >= 1; i--) {
                    const loser = bucket[i]!;
                    mergeLegacyMetadataIntoEvent(merged, loser.parsed);
                    if (loser.observed_at > maxObserved) maxObserved = loser.observed_at;
                }
                if (maxObserved > (merged.source_observed_at ?? 0)) {
                    merged.source_observed_at = maxObserved;
                }
                const nextPayload = JSON.stringify(merged);
                const nextTs = merged.timestamp_seconds || winner.timestamp;
                if (nextPayload !== winner.payload || nextTs !== winner.timestamp || maxObserved !== winner.observed_at) {
                    updateWinner.run(nextTs, merged.account_id ?? null, nextPayload, maxObserved, winner.event_key);
                    insertRevision.run(winner.event_key, nextTs, nextPayload);
                    revisionsInserted++;
                }
                lastWinner = { event_key: winner.event_key, timestamp: nextTs, payload: nextPayload };
                for (let i = 1; i < bucket.length; i++) {
                    const loser = bucket[i]!;
                    copyLock.run(winner.event_key, loser.event_key);
                    alias.run(loser.event_key, winner.event_key);
                    redirectAlias.run(winner.event_key, loser.event_key);
                }
                if (leg && leg !== winner.event_key) alias.run(leg, winner.event_key);
                deleteSelfAlias.run(winner.event_key);
                reconciledGroups++;
            }
        }
        if (reconciledGroups > 0 && revisionsInserted === 0 && lastWinner) {
            insertRevision.run(lastWinner.event_key, lastWinner.timestamp, lastWinner.payload);
        }
        db.prepare('INSERT OR REPLACE INTO ledger_maintenance VALUES(?,?)').run(DEDUP_MAINTENANCE_KEY, Date.now());
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

function runRequest(payload: {
    locale?: string;
    path: string;
    legacyPath: string;
    operation: string;
    readOnly?: boolean;
    events?: LedgerEvent[];
    options?: any;
}): unknown {
    if (typeof payload.locale === 'string' && payload.locale) {
        setActiveLocale(payload.locale);
    }
    const { path, legacyPath, operation, events, options, readOnly } = payload;
    if (readOnly && !['load', 'review', 'locks', 'version', 'count'].includes(operation)) throw Error('Read-only ledger');
    if (!readOnly) {
        syncWorkerRemoteMetadata(path);
        syncWorkerObservedIdeModels(path);
    }
    const result = new Map<string, LedgerEvent>();
    // Validate before opening a writable database. Never overwrite or "repair" a damaged baseline.
    const legacyEvents = readValidatedLegacyEvents(legacyPath);
    if (operation === 'load') {
        for (const event of legacyEvents)
            result.set(event.event_key!, {
                ...event, account_id: undefined, account_email: undefined, account_confidence: 'legacy',
            });
    }
    if (operation === 'review') {
        const suspicious = legacyEvents.filter(event => isSyntheticRecoveredDb(event.db_file) || !event.source_id);
        const synthetic = suspicious.filter(event => isSyntheticRecoveredDb(event.db_file));
        return { readOnly: true, baselinePath: existsSync(legacyPath) ? legacyPath : null,
            baselineSha256: existsSync(legacyPath) ? createHash('sha256').update(readFileSync(legacyPath)).digest('hex') : null,
            originalEventCount: legacyEvents.length, syntheticCount: synthetic.length, identityReviewCount: suspicious.length - synthetic.length,
            proposedExcludedTokens: synthetic.reduce((sum, event) => sum + event.total_tokens, 0),
            proposedExcludedRequests: synthetic.length,
            samples: suspicious.slice(0, 50).map(event => ({ eventKey: event.event_key, reason: isSyntheticRecoveredDb(event.db_file) ? bt('ledger.review.reason_synthetic') : bt('ledger.review.reason_missing_attribution'),
                before: { model: event.model, tokens: event.total_tokens, timestamp: event.timestamp_seconds, account: event.account_email ?? event.account_id ?? null }, after: isSyntheticRecoveredDb(event.db_file) ? bt('ledger.review.after_synthetic') : bt('ledger.review.after_unverified') })),
            message: bt('ledger.review.message') };
    }
    if (!existsSync(path) && operation === 'count')
        return legacyEvents.length;
    if (!existsSync(path) && operation === 'locks')
        return {};
    if (!existsSync(path) && operation === 'events')
        throw Error(bt('ledger.err.snapshot_unavailable'));
    if (!existsSync(path) && operation === 'load')
        return [...result.values()];
    if (existsSync(path))
        regular(path);
    if (readOnly) {
        for (const sidecar of [path + '-wal', path + '-shm']) {
            try {
                if (!lstatSync(sidecar).isFile()) throw Error('Invalid SQLite sidecar');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
    } else {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (!existsSync(path))
            writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    }
    const db = new DatabaseSync(path, { readOnly: readOnly || ['load', 'locks', 'version'].includes(operation) });
    try {
        if (readOnly) {
            db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
            if (operation === 'count') return Number(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0) + legacyEvents.length;
        }
        if (operation === 'load') {
            if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 2)
                throw Error(bt('ledger.err.unsupported_version'));
            const hasAliases = Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='event_aliases'").get()?.ok);
            const loadSql = hasAliases
                ? 'SELECT e.payload,e.observed_at FROM events e LEFT JOIN event_aliases a ON a.legacy_key=e.event_key WHERE a.legacy_key IS NULL ORDER BY e.timestamp, e.event_key'
                : 'SELECT payload,observed_at FROM events ORDER BY timestamp, event_key';
            for (const row of db.prepare(loadSql).iterate()) {
                const event = JSON.parse(String(row.payload));
                if (!validLedgerEvent(event))
                    throw Error(bt('ledger.err.corrupt_event_stop'));
                if (Number(row.observed_at) > 0) event.source_observed_at = Number(row.observed_at);
                result.set(event.event_key!, event);
            }
            return [...result.values()];
        }
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        if (version !== 0 && version !== 2 || version === 0 && Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n) > 0)
            throw Error(bt('ledger.err.unsupported_structure'));
        if (operation === 'version')
            return JSON.stringify([db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM event_revisions').get()?.n, db.prepare('SELECT COALESCE(MAX(version),0) AS n FROM rate_changes').get()?.n]);
        if (operation === 'locks') {
            if (version !== 2)
                throw Error(bt('ledger.err.rate_index_unsupported'));
            return Object.fromEntries(db.prepare('SELECT event_key,usd,unit_price FROM rate_locks LIMIT 50001').all().map(row => {
                const price = JSON.parse(String(row.unit_price));
                if (!Number.isFinite(row.usd) || Number(row.usd) < 0 || !['input', 'output', 'cached'].every(key => Number.isFinite(price[key]) && price[key] >= 0))
                    throw Error(bt('ledger.err.rate_index_corrupt'));
                return [String(row.event_key), { usd: Number(row.usd), price }];
            }));
        }
        db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        db.exec([
            "CREATE TABLE IF NOT EXISTS events(event_key TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, account_id TEXT, model TEXT NOT NULL, payload TEXT NOT NULL);",
            "CREATE INDEX IF NOT EXISTS events_time ON events(timestamp);",
            "CREATE INDEX IF NOT EXISTS events_account_time ON events(account_id,timestamp);",
            "CREATE INDEX IF NOT EXISTS events_legacy_key ON events(json_extract(payload,'$.legacy_event_key'));",
            "PRAGMA user_version=2;",
        ].join('\n'));
        db.exec([
            "CREATE TABLE IF NOT EXISTS event_revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);",
            "CREATE INDEX IF NOT EXISTS revisions_key ON event_revisions(event_key,seq);",
            "CREATE INDEX IF NOT EXISTS revisions_time ON event_revisions(timestamp,seq);",
            "CREATE TABLE IF NOT EXISTS rate_locks(event_key TEXT PRIMARY KEY,unit_price TEXT NOT NULL,usd REAL NOT NULL);",
            "CREATE TABLE IF NOT EXISTS event_aliases(legacy_key TEXT PRIMARY KEY,event_key TEXT NOT NULL);",
            "CREATE INDEX IF NOT EXISTS aliases_event_key ON event_aliases(event_key);",
            "CREATE TABLE IF NOT EXISTS rate_changes(version INTEGER PRIMARY KEY,min_event_seq INTEGER NOT NULL);",
            "CREATE TABLE IF NOT EXISTS snapshot_pins(snapshot_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,expires INTEGER NOT NULL);",
            "CREATE TABLE IF NOT EXISTS ledger_maintenance(key TEXT PRIMARY KEY,last_run INTEGER NOT NULL);",
        ].join('\n'));
        db.exec('DELETE FROM event_aliases WHERE legacy_key = event_key;');
        if (!(db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).some(column => column.name === 'observed_at')) db.exec('ALTER TABLE events ADD COLUMN observed_at REAL NOT NULL DEFAULT 0');
        db.exec('INSERT INTO event_revisions(event_key,timestamp,payload) SELECT event_key,timestamp,payload FROM events WHERE NOT EXISTS(SELECT 1 FROM event_revisions LIMIT 1);');
        if (operation === 'events')
            return ledgerEventPage(db, options);
        if (operation === 'renew') {
            const revision = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM event_revisions').get()?.n);
            if (options.revision !== revision || !options.snapshotId)
                return false;
            db.prepare('INSERT INTO snapshot_pins VALUES(?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET expires=excluded.expires').run(options.snapshotId, revision, Date.now() + 600000);
            return true;
        }
        const lastPrune = Number(db.prepare("SELECT last_run FROM ledger_maintenance WHERE key='revisions'").get()?.last_run ?? 0);
        if (operation === 'prune' || operation === 'save' && Date.now() - lastPrune > 60000) {
            db.prepare('DELETE FROM snapshot_pins WHERE expires<?').run(Date.now());
            const cutoff = Number(db.prepare('SELECT COALESCE(MIN(revision),(SELECT COALESCE(MAX(seq),0) FROM event_revisions)) AS revision FROM snapshot_pins').get()?.revision);
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('DELETE FROM event_revisions WHERE seq<? AND seq<>(SELECT MAX(n.seq) FROM event_revisions n WHERE n.event_key=event_revisions.event_key AND n.seq<=?)').run(cutoff, cutoff);
                db.prepare("INSERT OR REPLACE INTO ledger_maintenance VALUES('revisions',?)").run(Date.now());
                db.exec('COMMIT');
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
            try {
                db.exec('PRAGMA wal_checkpoint(PASSIVE);');
                const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size ?? 4096);
                const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0);
                const freePages = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
                const freeBytes = freePages * pageSize;
                const lastVacuum = Number(db.prepare("SELECT last_run FROM ledger_maintenance WHERE key='vacuum'").get()?.last_run ?? 0);
                const shouldVacuum =
                    (operation === 'prune' && freeBytes >= 4 * 1024 * 1024) ||
                    (Date.now() - lastVacuum > 6 * 3600 * 1000 &&
                        freeBytes >= 32 * 1024 * 1024 &&
                        pageCount > 0 &&
                        freePages / pageCount >= 0.25);
                if (shouldVacuum) {
                    db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
                    db.prepare("INSERT OR REPLACE INTO ledger_maintenance VALUES('vacuum',?)").run(Date.now());
                }
            } catch {
                // 只读并发持有快照时延后至下个维护周期执行物理紧缩，不阻断写入
            }
            if (operation === 'prune')
                return { pruned: true };
        }
        if (operation === 'count')
            return Number(db.prepare('SELECT COUNT(*) AS count FROM events').get()?.count) + legacyEvents.length;
        if (operation === 'revalue') {
            ensureImportedLegacyBaseline(db, path, legacyPath, legacyEvents);
            reconcileDuplicateLegacyAliases(db);
            return revalueLedger(db, path, options);
        }
        if (operation === 'save-locks') {
            const sequence = db.prepare('SELECT MIN(seq) AS seq FROM event_revisions WHERE event_key=?');
            const put = db.prepare('INSERT INTO rate_locks VALUES(?,?,?) ON CONFLICT(event_key) DO UPDATE SET unit_price=excluded.unit_price,usd=excluded.usd');
            const remove = db.prepare('DELETE FROM rate_locks WHERE event_key=?');
            let minSeq = Number.POSITIVE_INFINITY;
            db.exec('BEGIN IMMEDIATE');
            try {
                const existing = new Map<string, string>();
                for (const row of db.prepare('SELECT event_key,unit_price FROM rate_locks').iterate() as Iterable<any>) {
                    existing.set(String(row.event_key), String(row.unit_price));
                }
                for (const [key, entry] of Object.entries<any>(options.entries)) {
                    if (!Number.isFinite(entry.usd) || entry.usd < 0 || !entry.price)
                        throw Error(bt('ledger.err.invalid_rate_lock'));
                    const price = JSON.stringify(compactUnitPrice(entry.price));
                    if (existing.get(key) !== price) {
                        const seq = sequence.get(key)?.seq;
                        if (typeof seq === 'number')
                            minSeq = Math.min(minSeq, seq);
                    }
                    put.run(key, price, entry.usd);
                }
                for (const key of existing.keys()) {
                    if (!Object.hasOwn(options.entries, key)) {
                        remove.run(key);
                        const seq = sequence.get(key)?.seq;
                        if (typeof seq === 'number')
                            minSeq = Math.min(minSeq, seq);
                    }
                }
                if (Number.isFinite(minSeq))
                    db.prepare('INSERT INTO rate_changes VALUES((SELECT COALESCE(MAX(version),0)+1 FROM rate_changes),?)').run(minSeq);
                db.exec('COMMIT');
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
            return { saved: Object.keys(options.entries).length };
        }
        if (operation === 'aggregate') {
            ensureImportedLegacyBaseline(db, path, legacyPath, legacyEvents);
            reconcileDuplicateLegacyAliases(db);
            return { ...aggregateLedger(db, options), ledger_review_records: legacyEvents.filter(event => !event.source_id || isSyntheticRecoveredDb(event.db_file)).length };
        }
        reconcileDuplicateLegacyAliases(db);
        if (!Array.isArray(events) || !events.every(validLedgerEvent))
            throw Error(bt('ledger.err.invalid_usage_event'));
        const upsert = db.prepare('INSERT INTO events(event_key,timestamp,account_id,model,payload,observed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET timestamp=excluded.timestamp,account_id=excluded.account_id,model=excluded.model,payload=excluded.payload,observed_at=excluded.observed_at WHERE payload<>excluded.payload');
        const updateObserved = db.prepare('UPDATE events SET observed_at=MAX(observed_at,?) WHERE event_key=?');
        const revision = db.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)');
        const previous = db.prepare('SELECT payload,observed_at FROM events WHERE event_key=?');
        const byLegacyKey = db.prepare("SELECT event_key,payload,observed_at FROM events WHERE json_extract(payload,'$.legacy_event_key')=? AND event_key<>?");
        const copyLock = db.prepare('INSERT OR IGNORE INTO rate_locks(event_key,unit_price,usd) SELECT ?,unit_price,usd FROM rate_locks WHERE event_key=?');
        const alias = db.prepare('INSERT OR REPLACE INTO event_aliases VALUES(?,?)');
        const redirectAlias = db.prepare('UPDATE event_aliases SET event_key=? WHERE event_key=?');
        const deleteSelfAlias = db.prepare('DELETE FROM event_aliases WHERE legacy_key=?');
        const selectCanonicalByAlias = db.prepare('SELECT a.event_key, e.payload, e.observed_at FROM event_aliases a JOIN events e ON e.event_key=a.event_key WHERE a.legacy_key=? AND a.event_key<>?');
        const bindAliases = (targetKey: string, legacyKey: string | undefined, matches: LegacyCandidateRow[]) => {
            for (let i = matches.length - 1; i >= 0; i--) {
                const match = matches[i]!;
                if (match.event_key === targetKey) continue;
                copyLock.run(targetKey, match.event_key);
                alias.run(match.event_key, targetKey);
                redirectAlias.run(targetKey, match.event_key);
            }
            if (legacyKey && legacyKey !== targetKey) alias.run(legacyKey, targetKey);
            deleteSelfAlias.run(targetKey);
        };
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const event of events) {
                const existingCanonical = selectCanonicalByAlias.get(event.event_key!, event.event_key!) as { event_key: string; payload: string; observed_at: number } | undefined;
                if (existingCanonical) {
                    try {
                        const canonicalParsed = JSON.parse(String(existingCanonical.payload)) as LedgerEvent;
                        if (canonicalParsed.source_id || !event.source_id) {
                            copyLock.run(existingCanonical.event_key, event.event_key!);
                            const mergedCanonical: LedgerEvent = { ...canonicalParsed };
                            mergeLegacyMetadataIntoEvent(mergedCanonical, event);
                            const nextObserved = Math.max(Number(existingCanonical.observed_at ?? 0), event.source_observed_at ?? 0);
                            if (nextObserved > (mergedCanonical.source_observed_at ?? 0)) {
                                mergedCanonical.source_observed_at = nextObserved;
                            }
                            const nextTs = mergedCanonical.timestamp_seconds || canonicalParsed.timestamp_seconds || 0;
                            mergedCanonical.timestamp_seconds = nextTs;
                            const nextCanonicalPayload = JSON.stringify(mergedCanonical);
                            if (nextCanonicalPayload !== String(existingCanonical.payload) || nextObserved > Number(existingCanonical.observed_at ?? 0)) {
                                if (upsert.run(existingCanonical.event_key, nextTs, mergedCanonical.account_id ?? null, mergedCanonical.model, nextCanonicalPayload, nextObserved).changes) {
                                    revision.run(existingCanonical.event_key, nextTs, nextCanonicalPayload);
                                } else if (nextObserved > Number(existingCanonical.observed_at ?? 0)) {
                                    updateObserved.run(nextObserved, existingCanonical.event_key);
                                }
                            }
                            if (event.legacy_event_key && event.legacy_event_key !== existingCanonical.event_key) {
                                alias.run(event.legacy_event_key, existingCanonical.event_key);
                            }
                            deleteSelfAlias.run(existingCanonical.event_key);
                            continue;
                        }
                    } catch {
                        // fall through to standard upsert
                    }
                }
                const sameKeyStored = previous.get(event.event_key!) as { payload: string; observed_at: number } | undefined;
                const legacyMatches = event.legacy_event_key
                    ? findMatchingLegacyRows(byLegacyKey, event.legacy_event_key, event.event_key!, event.db_file)
                    : [];
                if (sameKeyStored) {
                    if (Number(sameKeyStored.observed_at) > (event.source_observed_at ?? 0) && legacyMatches.length === 0) {
                        continue;
                    }
                    const old = JSON.parse(String(sameKeyStored.payload)) as LedgerEvent;
                    for (const legacyMatch of legacyMatches) {
                        mergeLegacyMetadataIntoEvent(event, legacyMatch.parsed);
                    }
                    mergeLegacyMetadataIntoEvent(event, old);
                    const maxObserved = Math.max(
                        event.source_observed_at ?? 0,
                        Number(sameKeyStored.observed_at ?? 0),
                        ...legacyMatches.map(m => m.observed_at)
                    );
                    if (Number(sameKeyStored.observed_at) > (event.source_observed_at ?? 0)) {
                        // 当前事件观测更旧时，不覆写新观测的 payload，仅完成孤立旧别名归并
                        bindAliases(event.event_key!, event.legacy_event_key, legacyMatches);
                        continue;
                    }
                    const comparable = { ...event, source_observed_at: old.source_observed_at };
                    if (JSON.stringify(comparable) === String(sameKeyStored.payload)) {
                        if (maxObserved > Number(sameKeyStored.observed_at)) {
                            updateObserved.run(maxObserved, event.event_key!);
                        }
                        bindAliases(event.event_key!, event.legacy_event_key, legacyMatches);
                        continue;
                    }
                } else if (legacyMatches.length > 0) {
                    // 换机、备份恢复或底层文件索引变更导致 source_id 变化时，归并全部同 legacy_event_key + db_file 旧版本
                    let maxObserved = event.source_observed_at ?? 0;
                    for (const legacyMatch of legacyMatches) {
                        mergeLegacyMetadataIntoEvent(event, legacyMatch.parsed);
                        if (legacyMatch.observed_at > maxObserved) maxObserved = legacyMatch.observed_at;
                    }
                    if (maxObserved > (event.source_observed_at ?? 0)) {
                        event.source_observed_at = maxObserved;
                    }
                }
                const payload = JSON.stringify(event);
                if (upsert.run(event.event_key!, event.timestamp_seconds, event.account_id ?? null, event.model, payload, event.source_observed_at ?? 0).changes) {
                    revision.run(event.event_key!, event.timestamp_seconds, payload);
                }
                bindAliases(event.event_key!, event.legacy_event_key, legacyMatches);
            }
            db.exec('COMMIT');
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        safeChmodSync(path, 0o600);
        return { saved: events.length };
    }
    finally {
        db.close();
    }
}
if (workerData && typeof workerData === 'object' && typeof workerData.operation === 'string') {
    try {
        parentPort?.postMessage({ ok: true, value: runRequest(workerData) });
    }
    catch (error) {
        parentPort?.postMessage({ ok: false, error: (error as Error).message });
    }
}
else {
    parentPort?.on('message', (req: any) => {
        const id = req?.id;
        try {
            parentPort?.postMessage({ id, ok: true, value: runRequest(req) });
        }
        catch (error) {
            parentPort?.postMessage({ id, ok: false, error: (error as Error).message });
        }
    });
}

import { SAFE_CONVERSATION_ID_RE } from './safe-input.js';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { compactNumber, compactPercent, compactUsd } from './metric-format.js';
import { ConversationMetricsEngine } from './hud/metrics-engine.js';
import type {
  ConversationHudMetrics,
  HudCapacitySource,
  HudModelContextStage,
} from './hud/metrics-engine.js';
import { runSummariesContextQueryInWorker } from './sqlite-read.js';
import type { SummariesContextSummaryRow } from './sqlite-worker.js';

const ACTIVE_RECENCY_MS = 60 * 60 * 1000;
const MAX_EVALUATED_SWARM_MEMBERS = 20;
const SWARM_MEMBER_READ_CONCURRENCY = 4;

const TERMINAL_STATUS_RE =
  /^(?:CASCADE_RUN_STATUS_)?(?:DONE|COMPLETED|CLEARED|ERROR|CANCELL?ED|KILLED)$/i;
const IDLE_STATUS_RE = /^(?:CASCADE_RUN_STATUS_)?(?:IDLE|UNSPECIFIED)$/i;
const WAITING_STATUS_RE =
  /^(?:CASCADE_RUN_STATUS_)?(?:WAITING|PAUSED|BLOCKED|STANDING[_ -]?BY)$/i;
const RUNNING_STATUS_RE = /^(?:CASCADE_RUN_STATUS_)?(?:RUNNING|IN_PROGRESS|ACTIVE)$/i;
const WAITING_TOOL_RE = /^(?:default_api:)?swarm_wait$/i;


export type ConversationRunStatus = 'running' | 'waiting' | 'completed';

export interface ConversationContextSummaryItem {
  conversationId: string;
  title: string;
  status: ConversationRunStatus;
  isRunning: boolean;
  isWaiting: boolean;
  lastActiveAt: number;
  stepCount: number;
  childCount: number;
  runningChildCount: number;
  waitingChildCount: number;
  activeChildCount: number;
  workspaceUris?: string;
}

export interface ConversationListResponse {
  conversations: ConversationContextSummaryItem[];
  recommendedId: string | null;
}

export interface ContextBreakdownSnapshot {
  cachedContextTokens: number;
  cachedContextCompact: string;
  cachedContextRatio: number;
  uncachedContextTokens: number;
  uncachedContextCompact: string;
  uncachedContextRatio: number;
  latestOutputTokens: number;
  latestOutputCompact: string;
}

export interface ConversationTokensSummary {
  totalTokens: number;
  totalTokensCompact: string;
  uncachedInputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  cacheHitRateFormatted: string;
  estimatedCostUsd?: number;
  estimatedCostFormatted?: string;
  cacheSavedUsd?: number;
  cacheSavedFormatted?: string;
  hasUnpricedSteps?: boolean;
}

export interface ConversationContextWindowDetail {
  hasUsageData: boolean;
  modelId: string;
  modelDisplayName: string;
  modelShortLabel?: string;
  modelCompactLabel?: string;
  usedTokens: number;
  usedTokensCompact: string;
  capacityTokens: number;
  capacityTokensCompact: string;
  capacitySource: HudCapacitySource;
  usedRatio: number;
  usedRatioFormatted: string;
  peakContextTokens: number;
  peakContextCompact: string;
  sessionPeakContextTokens: number;
  sessionPeakContextCompact: string;
  compactionCount: number;
  activeModelCompactionCount: number;
  averageCacheHitRate: number;
  averageCacheHitRateFormatted: string;
  latestStepCacheHitRate: number;
  latestStepCacheHitRateFormatted: string;
  isMultiModel?: boolean;
  isOrchestrator?: boolean;
  modelStages?: HudModelContextStage[];
  breakdown: ContextBreakdownSnapshot;
}

export interface SwarmMemberContextSnapshot {
  conversationId: string;
  parentConversationId?: string;
  displayName: string;
  agentName?: string;
  title?: string;
  status: ConversationRunStatus;
  killed: boolean;
  lastActiveAt: number;
  steps: number;
  turns: number;
  compactionCount: number;
  context: ConversationContextWindowDetail;
  tokens: ConversationTokensSummary;
}

export interface SwarmTotalsSnapshot {
  memberCount: number;
  evaluatedMemberCount: number;
  runningCount: number;
  waitingCount: number;
  completedCount: number;
  totalTokens: number;
  totalTokensCompact: string;
  uncachedInputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalSteps: number;
  cacheHitRate: number;
  cacheHitRateFormatted: string;
  estimatedCostUsd?: number;
  estimatedCostFormatted?: string;
  hasUnpricedSteps?: boolean;
}

export interface ConversationContextSnapshot {
  available: boolean;
  conversationId: string | null;
  title: string;
  status: ConversationRunStatus;
  lastActiveAt: number;
  updatedAt: number;
  steps: number;
  turns: number;
  main: ConversationContextWindowDetail;
  mainTokens: ConversationTokensSummary;
  members: SwarmMemberContextSnapshot[];
  swarmTotals: SwarmTotalsSnapshot | null;
}

interface ParsedSummariesIndex {
  foundTable: boolean;
  hasAppDataDirColumn: boolean;
  byId: Map<string, SummariesContextSummaryRow>;
  parentOf: Map<string, string>;
  childrenOf: Map<string, Set<string>>;
}

interface TailStepSnapshot {
  stepType: number;
  status: number;
  toolCallName?: string;
}

export function parseTimestampMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
  }
  const direct = Date.parse(trimmed);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const isoNormalized = trimmed
    .replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T')
    .replace(/(\.\d{3})\d+(?=[+-Z]|$)/, '$1');
  const parsed = Date.parse(isoNormalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function deriveTitleFromSummary(
  row: SummariesContextSummaryRow | undefined,
  fallbackId: string
): string {
  if (row) {
    if (row.title) return row.title;
    if (row.agentName) return row.agentName;
    if (row.preview) {
      const firstLine = row.preview.split(/\r?\n/, 1)[0]?.trim() ?? '';
      if (firstLine) {
        return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
      }
    }
  }
  return fallbackId.slice(0, 8);
}

function deriveMemberDisplayName(
  row: SummariesContextSummaryRow | undefined,
  childId: string
): string {
  if (row) {
    if (row.agentName) return row.agentName;
    if (row.title) return row.title;
  }
  return childId.slice(0, 8);
}

function classifyConversationStatus(
  summary: SummariesContextSummaryRow | undefined,
  tailStep: TailStepSnapshot | null,
  lastActiveAt: number,
  nowMs: number
): ConversationRunStatus {
  if (summary?.killed) return 'completed';
  const rawStatus = summary?.status?.trim() ?? '';
  if (rawStatus && TERMINAL_STATUS_RE.test(rawStatus)) {
    return 'completed';
  }
  if (tailStep?.toolCallName && WAITING_TOOL_RE.test(tailStep.toolCallName.trim())) {
    return 'waiting';
  }
  if (rawStatus && WAITING_STATUS_RE.test(rawStatus)) {
    return 'waiting';
  }
  const isRecent = lastActiveAt > 0 && nowMs - lastActiveAt <= ACTIVE_RECENCY_MS;
  if (tailStep && tailStep.status === 9 && isRecent) {
    return 'waiting';
  }
  if (rawStatus && RUNNING_STATUS_RE.test(rawStatus)) {
    return 'running';
  }
  if (summary?.notFullyIdle && isRecent) {
    return 'running';
  }
  if (rawStatus && IDLE_STATUS_RE.test(rawStatus)) {
    return 'completed';
  }
  if (tailStep && [1, 2, 8].includes(tailStep.status) && isRecent) {
    return 'running';
  }
  return 'completed';
}

function extractContextDetail(metrics: ConversationHudMetrics): ConversationContextWindowDetail {
  const c = metrics.context;
  const b = c.breakdown;
  const cachedTokens = b.cachedContextTokens ?? b.systemTokens ?? 0;
  const uncachedTokens = b.uncachedContextTokens ?? b.toolTokens ?? 0;
  const latestOutput = b.latestOutputTokens ?? b.messageTokens ?? 0;
  const peakTokens = c.peakContextTokens ?? 0;
  const sessionPeakTokens = c.sessionPeakContextTokens ?? peakTokens;
  const avgCacheHit = metrics.tokens.cacheHitRate ?? 0;
  const latestStepCacheHit = c.stepCacheRatio ?? 0;

  return {
    hasUsageData: Boolean(c.hasUsageData),
    modelId: c.modelId || 'unknown',
    modelDisplayName: c.modelDisplayName || '—',
    ...(c.modelShortLabel ? { modelShortLabel: c.modelShortLabel } : {}),
    ...(c.modelCompactLabel ? { modelCompactLabel: c.modelCompactLabel } : {}),
    usedTokens: c.usedTokens,
    usedTokensCompact: compactNumber(c.usedTokens),
    capacityTokens: c.capacityTokens,
    capacityTokensCompact: c.capacityTokensCompact,
    capacitySource: c.capacitySource ?? (c.hasExplicitDbCapacity ? 'explicit' : 'reference'),
    usedRatio: c.usedRatio,
    usedRatioFormatted: c.usedRatioFormatted || compactPercent(c.usedRatio),
    peakContextTokens: peakTokens,
    peakContextCompact: compactNumber(peakTokens),
    sessionPeakContextTokens: sessionPeakTokens,
    sessionPeakContextCompact: compactNumber(sessionPeakTokens),
    compactionCount: metrics.session.compactionCount ?? 0,
    activeModelCompactionCount: c.activeModelCompactionCount ?? metrics.session.compactionCount ?? 0,
    averageCacheHitRate: avgCacheHit,
    averageCacheHitRateFormatted: metrics.tokens.cacheHitRateFormatted || compactPercent(avgCacheHit),
    latestStepCacheHitRate: latestStepCacheHit,
    latestStepCacheHitRateFormatted: c.stepCacheRatioFormatted || compactPercent(latestStepCacheHit),
    ...(c.isMultiModel ? { isMultiModel: true } : {}),
    ...(c.isOrchestrator ? { isOrchestrator: true } : {}),
    ...(c.modelStages ? { modelStages: c.modelStages } : {}),
    breakdown: {
      cachedContextTokens: cachedTokens,
      cachedContextCompact: compactNumber(cachedTokens),
      cachedContextRatio: b.cachedContextRatio ?? b.systemRatio ?? 0,
      uncachedContextTokens: uncachedTokens,
      uncachedContextCompact: compactNumber(uncachedTokens),
      uncachedContextRatio: b.uncachedContextRatio ?? b.toolRatio ?? 0,
      latestOutputTokens: latestOutput,
      latestOutputCompact: compactNumber(latestOutput),
    },
  };
}

function extractTokensSummary(metrics: ConversationHudMetrics): ConversationTokensSummary {
  const t = metrics.tokens;
  return {
    totalTokens: t.totalTokens,
    totalTokensCompact: compactNumber(t.totalTokens),
    uncachedInputTokens: t.uncachedInputTokens,
    cachedReadTokens: t.cachedReadTokens,
    cacheWriteTokens: t.cacheWriteTokens ?? 0,
    outputTokens: t.outputTokens,
    cacheHitRate: t.cacheHitRate,
    cacheHitRateFormatted: t.cacheHitRateFormatted || compactPercent(t.cacheHitRate),
    ...(typeof t.estimatedCostUsd === 'number'
      ? {
          estimatedCostUsd: t.estimatedCostUsd,
          estimatedCostFormatted: t.estimatedCostFormatted || compactUsd(t.estimatedCostUsd),
        }
      : {}),
    ...(typeof t.cacheSavedUsd === 'number'
      ? {
          cacheSavedUsd: t.cacheSavedUsd,
          cacheSavedFormatted: t.cacheSavedFormatted || compactUsd(t.cacheSavedUsd),
        }
      : {}),
    ...(t.hasUnpricedSteps ? { hasUnpricedSteps: true } : {}),
  };
}

function emptyContextSnapshot(): ConversationContextSnapshot {
  const zeroBreakdown: ContextBreakdownSnapshot = {
    cachedContextTokens: 0,
    cachedContextCompact: '0',
    cachedContextRatio: 0,
    uncachedContextTokens: 0,
    uncachedContextCompact: '0',
    uncachedContextRatio: 0,
    latestOutputTokens: 0,
    latestOutputCompact: '0',
  };
  return {
    available: false,
    conversationId: null,
    title: '',
    status: 'completed',
    lastActiveAt: 0,
    updatedAt: Date.now(),
    steps: 0,
    turns: 0,
    main: {
      hasUsageData: false,
      modelId: 'unknown',
      modelDisplayName: '—',
      usedTokens: 0,
      usedTokensCompact: '0',
      capacityTokens: 200_000,
      capacityTokensCompact: '~200K',
      capacitySource: 'unknown',
      usedRatio: 0,
      usedRatioFormatted: '0%',
      peakContextTokens: 0,
      peakContextCompact: '0',
      sessionPeakContextTokens: 0,
      sessionPeakContextCompact: '0',
      compactionCount: 0,
      activeModelCompactionCount: 0,
      averageCacheHitRate: 0,
      averageCacheHitRateFormatted: '0%',
      latestStepCacheHitRate: 0,
      latestStepCacheHitRateFormatted: '0%',
      breakdown: zeroBreakdown,
    },
    mainTokens: {
      totalTokens: 0,
      totalTokensCompact: '0',
      uncachedInputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      cacheHitRate: 0,
      cacheHitRateFormatted: '0%',
    },
    members: [],
    swarmTotals: null,
  };
}

function statusSortWeight(status: ConversationRunStatus): number {
  if (status === 'running') return 2;
  if (status === 'waiting') return 1;
  return 0;
}

/**
 * Pure local read-only conversation context & Swarm/subagent watermark service.
 * Reuses ConversationMetricsEngine for all Protobuf/token/context calculations.
 */
export class ConversationContextService {
  private readonly conversationsDir: string;
  private readonly antigravityDir: string;
  private readonly engine: ConversationMetricsEngine;
  private cachedSummaries: { sig: string; index: ParsedSummariesIndex } | null = null;
  private summariesInFlight: Promise<ParsedSummariesIndex> | null = null;
  private readonly inFlightLists = new Map<number, Promise<ConversationListResponse>>();
  private readonly inFlightSnapshots = new Map<string, Promise<ConversationContextSnapshot>>();

  constructor(options?: {
    geminiDir?: string;
    conversationsDir?: string;
    stateDir?: string;
    engine?: ConversationMetricsEngine;
  }) {
    const baseGemini = options?.geminiDir ?? join(homedir(), '.gemini');
    this.conversationsDir =
      options?.conversationsDir ?? join(baseGemini, 'antigravity', 'conversations');
    this.antigravityDir = dirname(this.conversationsDir);
    this.engine =
      options?.engine ??
      new ConversationMetricsEngine({
        geminiDir: options?.geminiDir,
        conversationsDir: options?.conversationsDir,
        stateDir: options?.stateDir,
      });
  }

  public clearCache(): void {
    this.cachedSummaries = null;
    this.engine.clearCache();
  }

  private async resolveSummariesDbFile(): Promise<{
    path: string;
    sig: string;
  } | null> {
    const candidates = [
      join(this.antigravityDir, 'conversation_summaries.db'),
      join(this.conversationsDir, 'conversation_summaries.db'),
    ];
    for (const candidate of candidates) {
      const st = await lstat(candidate).catch(() => null);
      if (!st || !st.isFile() || st.isSymbolicLink()) continue;
      const walSt = await lstat(`${candidate}-wal`).catch(() => null);
      const sig = `${candidate}|${st.mtimeMs}:${st.size}:${walSt?.mtimeMs ?? 0}:${walSt?.size ?? 0}`;
      return { path: candidate, sig };
    }
    return null;
  }

  private async loadSummariesIndex(): Promise<ParsedSummariesIndex> {
    const empty: ParsedSummariesIndex = {
      foundTable: false,
      hasAppDataDirColumn: false,
      byId: new Map(),
      parentOf: new Map(),
      childrenOf: new Map(),
    };
    const resolved = await this.resolveSummariesDbFile();
    if (!resolved) {
      this.cachedSummaries = null;
      return empty;
    }
    if (this.cachedSummaries && this.cachedSummaries.sig === resolved.sig) {
      return this.cachedSummaries.index;
    }
    if (this.summariesInFlight) {
      return this.summariesInFlight;
    }
    this.summariesInFlight = (async () => {
      try {
        const res = await runSummariesContextQueryInWorker({ dbPath: resolved.path });
        if (!res || !res.foundTable) return empty;
        const byId = new Map<string, SummariesContextSummaryRow>();
        const parentOf = new Map<string, string>();
        const childrenOf = new Map<string, Set<string>>();

        const addEdge = (childId: string, parentId: string) => {
          if (!childId || !parentId || childId === parentId) return;
          if (!parentOf.has(childId)) parentOf.set(childId, parentId);
          let kids = childrenOf.get(parentId);
          if (!kids) {
            kids = new Set<string>();
            childrenOf.set(parentId, kids);
          }
          kids.add(childId);
        };

        for (const row of res.summaries) {
          byId.set(row.conversationId, row);
          if (row.parentConversationId) {
            addEdge(row.conversationId, row.parentConversationId);
          }
        }
        for (const edge of res.parentEdges) {
          addEdge(edge.conversationId, edge.parentId);
        }

        const index: ParsedSummariesIndex = {
          foundTable: true,
          hasAppDataDirColumn: res.hasAppDataDirColumn,
          byId,
          parentOf,
          childrenOf,
        };
        this.cachedSummaries = { sig: resolved.sig, index };
        return index;
      } finally {
        this.summariesInFlight = null;
      }
    })();
    return this.summariesInFlight;
  }

  private async statConversationDb(conversationId: string): Promise<{
    exists: boolean;
    dbPath: string | null;
    mtimeMs: number;
  }> {
    const cleanId = conversationId.trim().toLowerCase();
    if (!SAFE_CONVERSATION_ID_RE.test(cleanId)) {
      return { exists: false, dbPath: null, mtimeMs: 0 };
    }
    const dbPath = join(this.conversationsDir, `${cleanId}.db`);
    const [st, walSt] = await Promise.all([
      lstat(dbPath).catch(() => null),
      lstat(`${dbPath}-wal`).catch(() => null),
    ]);
    if (!st || !st.isFile() || st.isSymbolicLink()) {
      return { exists: false, dbPath: null, mtimeMs: 0 };
    }
    return {
      exists: true,
      dbPath,
      mtimeMs: Math.max(st.mtimeMs, walSt?.mtimeMs ?? 0),
    };
  }

  private async scanConversationDbFilesFallback(): Promise<
    Array<{ conversationId: string; dbPath: string; mtimeMs: number }>
  > {
    const files = await readdir(this.conversationsDir).catch(() => [] as string[]);
    const candidates = files
      .filter((f) => f.endsWith('.db') && f !== 'conversation_summaries.db')
      .map((f) => f.slice(0, -3).toLowerCase())
      .filter((id) => SAFE_CONVERSATION_ID_RE.test(id));
    const entries: Array<{ conversationId: string; dbPath: string; mtimeMs: number }> = [];
    for (let i = 0; i < candidates.length; i += 32) {
      const batch = candidates.slice(i, i + 32);
      const stats = await Promise.all(batch.map((id) => this.statConversationDb(id)));
      for (let j = 0; j < batch.length; j++) {
        const s = stats[j]!;
        if (s.exists && s.dbPath) {
          entries.push({ conversationId: batch[j]!, dbPath: s.dbPath, mtimeMs: s.mtimeMs });
        }
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries;
  }

  private collectSummaryDescendants(
    rootId: string,
    index: ParsedSummariesIndex
  ): Array<{ conversationId: string; parentConversationId?: string }> {
    const visited = new Set<string>([rootId]);
    const queue: Array<{ conversationId: string; parentConversationId?: string }> = [];
    const results: Array<{ conversationId: string; parentConversationId?: string }> = [];
    for (const cid of index.childrenOf.get(rootId) ?? []) {
      if (!visited.has(cid)) {
        visited.add(cid);
        queue.push({ conversationId: cid, parentConversationId: rootId });
      }
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      results.push(current);
      for (const nextId of index.childrenOf.get(current.conversationId) ?? []) {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({
            conversationId: nextId,
            parentConversationId: current.conversationId,
          });
        }
      }
    }
    return results;
  }

  public async listRecentConversations(options?: {
    limit?: number;
  }): Promise<ConversationListResponse> {
    const limit = Math.max(
      1,
      Math.min(100, Math.floor(typeof options?.limit === 'number' && Number.isFinite(options.limit) ? options.limit : 30))
    );
    const existing = this.inFlightLists.get(limit);
    if (existing) return existing;

    const op = this.computeRecentConversations(limit).finally(() => {
      if (this.inFlightLists.get(limit) === op) {
        this.inFlightLists.delete(limit);
      }
    });
    this.inFlightLists.set(limit, op);
    return op;
  }

  private async computeRecentConversations(limit: number): Promise<ConversationListResponse> {
    const index = await this.loadSummariesIndex();
    const nowMs = Date.now();

    if (index.foundTable && index.byId.size > 0) {
      const topLevelRows: SummariesContextSummaryRow[] = [];
      for (const row of index.byId.values()) {
        if (row.parentConversationId) continue;
        if (index.parentOf.has(row.conversationId)) continue;
        if (row.nestingDepth > 0) continue;
        if (index.hasAppDataDirColumn && row.appDataDir && row.appDataDir !== 'antigravity') {
          continue;
        }
        topLevelRows.push(row);
      }

      // Pre-sort by summary timestamp so we only stat the top N*2 DBs when there are hundreds of historical conversations.
      topLevelRows.sort((a, b) => {
        const aMod = Math.max(parseTimestampMs(a.lastModifiedRaw), parseTimestampMs(a.lastUserInputRaw));
        const bMod = Math.max(parseTimestampMs(b.lastModifiedRaw), parseTimestampMs(b.lastUserInputRaw));
        return bMod - aMod;
      });
      const candidatePool = topLevelRows.slice(0, Math.max(limit * 3, 60));

      const items: ConversationContextSummaryItem[] = [];
      for (let i = 0; i < candidatePool.length; i += 24) {
        const batch = candidatePool.slice(i, i + 24);
        const dbStats = await Promise.all(batch.map((r) => this.statConversationDb(r.conversationId)));
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j]!;
          const dbStat = dbStats[j]!;
          if (!dbStat.exists) continue;
          const summaryTs = Math.max(
            parseTimestampMs(row.lastModifiedRaw),
            parseTimestampMs(row.lastUserInputRaw)
          );
          const lastActiveAt = Math.max(dbStat.mtimeMs, summaryTs);
          const descendants = this.collectSummaryDescendants(row.conversationId, index);
          let runningChildCount = 0;
          let waitingChildCount = 0;
          let latestDescendantTs = lastActiveAt;
          for (const d of descendants) {
            const dRow = index.byId.get(d.conversationId);
            const dTs = dRow
              ? Math.max(parseTimestampMs(dRow.lastModifiedRaw), parseTimestampMs(dRow.lastUserInputRaw))
              : 0;
            if (dTs > latestDescendantTs) latestDescendantTs = dTs;
            const dStatus = classifyConversationStatus(dRow, null, dTs || lastActiveAt, nowMs);
            if (dStatus === 'running') runningChildCount++;
            else if (dStatus === 'waiting') waitingChildCount++;
          }

          const selfStatus = classifyConversationStatus(row, null, lastActiveAt, nowMs);
          const effectiveStatus: ConversationRunStatus =
            selfStatus === 'running' || runningChildCount > 0
              ? 'running'
              : selfStatus === 'waiting' || waitingChildCount > 0
              ? 'waiting'
              : 'completed';

          items.push({
            conversationId: row.conversationId,
            title: deriveTitleFromSummary(row, row.conversationId),
            status: effectiveStatus,
            isRunning: effectiveStatus === 'running',
            isWaiting: effectiveStatus === 'waiting',
            lastActiveAt: latestDescendantTs,
            stepCount: row.stepCount,
            childCount: descendants.length,
            runningChildCount,
            waitingChildCount,
            activeChildCount: runningChildCount + waitingChildCount,
            ...(row.workspaceUris ? { workspaceUris: row.workspaceUris } : {}),
          });
        }
      }

      if (items.length > 0) {
        items.sort((a, b) => {
          const weightDiff = statusSortWeight(b.status) - statusSortWeight(a.status);
          if (weightDiff !== 0) return weightDiff;
          return b.lastActiveAt - a.lastActiveAt;
        });
        const sliced = items.slice(0, limit);
        return {
          conversations: sliced,
          recommendedId: sliced[0]?.conversationId ?? null,
        };
      }
    }

    // Fallback: scan conversations/*.db directly when conversation_summaries.db is absent or empty.
    const dbFiles = await this.scanConversationDbFilesFallback();
    const fallbackItems: ConversationContextSummaryItem[] = dbFiles.slice(0, limit).map((entry) => ({
      conversationId: entry.conversationId,
      title: entry.conversationId.slice(0, 8),
      status: 'completed',
      isRunning: false,
      isWaiting: false,
      lastActiveAt: entry.mtimeMs,
      stepCount: 0,
      childCount: 0,
      runningChildCount: 0,
      waitingChildCount: 0,
      activeChildCount: 0,
    }));
    return {
      conversations: fallbackItems,
      recommendedId: fallbackItems[0]?.conversationId ?? null,
    };
  }

  public async getConversationContextSnapshot(
    conversationId?: string
  ): Promise<ConversationContextSnapshot> {
    const requestedId =
      typeof conversationId === 'string' && SAFE_CONVERSATION_ID_RE.test(conversationId.trim())
        ? conversationId.trim().toLowerCase()
        : '';
    const flightKey = requestedId || '__recommended__';
    const existing = this.inFlightSnapshots.get(flightKey);
    if (existing) return existing;

    const op = this.computeConversationContextSnapshot(requestedId || undefined).finally(() => {
      if (this.inFlightSnapshots.get(flightKey) === op) {
        this.inFlightSnapshots.delete(flightKey);
      }
    });
    this.inFlightSnapshots.set(flightKey, op);
    return op;
  }

  private async computeConversationContextSnapshot(
    requestedId?: string
  ): Promise<ConversationContextSnapshot> {
    const [index, listRes] = await Promise.all([
      this.loadSummariesIndex(),
      requestedId ? Promise.resolve(null) : this.listRecentConversations({ limit: 30 }),
    ]);

    const targetId = requestedId || listRes?.recommendedId || null;
    if (!targetId) {
      return emptyContextSnapshot();
    }

    const mainDbStat = await this.statConversationDb(targetId);
    if (!mainDbStat.exists || !mainDbStat.dbPath) {
      if (requestedId) {
        const fallbackList = await this.listRecentConversations({ limit: 30 });
        if (fallbackList.recommendedId && fallbackList.recommendedId !== requestedId) {
          return this.computeConversationContextSnapshot(fallbackList.recommendedId);
        }
      }
      return emptyContextSnapshot();
    }

    // Use dbPathOverride so mainMetrics reflects strictly the main conversation's own DB
    // without merging Swarm worker tokens/steps into the main window.
    const mainMetrics = await this.engine.getConversationMetrics({
      conversationId: targetId,
      dbPathOverride: mainDbStat.dbPath,
    });
    const mainSummary = index.byId.get(targetId);
    const mainTail = this.engine.getLastSubstantiveStepSnapshot(targetId, mainDbStat.dbPath);
    const nowMs = Date.now();
    const mainSummaryTs = mainSummary
      ? Math.max(
          parseTimestampMs(mainSummary.lastModifiedRaw),
          parseTimestampMs(mainSummary.lastUserInputRaw)
        )
      : 0;
    const mainLastActiveAt = Math.max(mainDbStat.mtimeMs, mainMetrics.observedAt ?? 0, mainSummaryTs);
    const mainSelfStatus = classifyConversationStatus(mainSummary, mainTail, mainLastActiveAt, nowMs);

    // Collect Swarm / subagent descendants from both conversation_summaries.db and explicit step refs.
    const candidateOrder: Array<{ conversationId: string; parentConversationId?: string }> = [];
    const seenDescendantIds = new Set<string>([targetId]);
    const enqueueDescendant = (cidRaw: string, parentId: string) => {
      const cid = cidRaw.trim().toLowerCase();
      if (!SAFE_CONVERSATION_ID_RE.test(cid) || seenDescendantIds.has(cid)) return;
      seenDescendantIds.add(cid);
      candidateOrder.push({ conversationId: cid, parentConversationId: parentId });
    };

    for (const d of this.collectSummaryDescendants(targetId, index)) {
      enqueueDescendant(d.conversationId, d.parentConversationId ?? targetId);
    }
    for (const explicitCid of this.engine.getCachedDiscoveredChildIds(targetId, mainDbStat.dbPath)) {
      enqueueDescendant(explicitCid, targetId);
    }

    // Prioritize running/waiting/not-killed and most recently active members when > 20 members exist.
    const prioritizedCandidates = [...candidateOrder];
    if (prioritizedCandidates.length > MAX_EVALUATED_SWARM_MEMBERS) {
      prioritizedCandidates.sort((a, b) => {
        const aRow = index.byId.get(a.conversationId);
        const bRow = index.byId.get(b.conversationId);
        const aTs = aRow
          ? Math.max(parseTimestampMs(aRow.lastModifiedRaw), parseTimestampMs(aRow.lastUserInputRaw))
          : 0;
        const bTs = bRow
          ? Math.max(parseTimestampMs(bRow.lastModifiedRaw), parseTimestampMs(bRow.lastUserInputRaw))
          : 0;
        const aWeight = statusSortWeight(classifyConversationStatus(aRow, null, aTs, nowMs));
        const bWeight = statusSortWeight(classifyConversationStatus(bRow, null, bTs, nowMs));
        if (bWeight !== aWeight) return bWeight - aWeight;
        return bTs - aTs;
      });
    }

    const totalDiscoveredCount = prioritizedCandidates.length;
    const queue = prioritizedCandidates.slice(0, MAX_EVALUATED_SWARM_MEMBERS);
    const members: SwarmMemberContextSnapshot[] = [];

    while (queue.length > 0) {
      const wave = queue.splice(0, SWARM_MEMBER_READ_CONCURRENCY);
      const waveResults = await Promise.all(
        wave.map(async (entry) => {
          const childStat = await this.statConversationDb(entry.conversationId);
          const childSummary = index.byId.get(entry.conversationId);
          if (!childStat.exists || !childStat.dbPath) {
            return null;
          }
          const childMetrics = await this.engine.getConversationMetrics({
            conversationId: entry.conversationId,
            dbPathOverride: childStat.dbPath,
          });
          const nestedIds = this.engine.getCachedDiscoveredChildIds(
            entry.conversationId,
            childStat.dbPath
          );
          for (const nestedId of nestedIds) {
            const cleanNested = nestedId.trim().toLowerCase();
            if (
              SAFE_CONVERSATION_ID_RE.test(cleanNested) &&
              !seenDescendantIds.has(cleanNested) &&
              members.length + queue.length + wave.length < MAX_EVALUATED_SWARM_MEMBERS
            ) {
              seenDescendantIds.add(cleanNested);
              queue.push({
                conversationId: cleanNested,
                parentConversationId: entry.conversationId,
              });
            }
          }
          const childTail = this.engine.getLastSubstantiveStepSnapshot(
            entry.conversationId,
            childStat.dbPath
          );
          const childSummaryTs = childSummary
            ? Math.max(
                parseTimestampMs(childSummary.lastModifiedRaw),
                parseTimestampMs(childSummary.lastUserInputRaw)
              )
            : 0;
          const childLastActiveAt = Math.max(
            childStat.mtimeMs,
            childMetrics.observedAt ?? 0,
            childSummaryTs
          );
          const status = classifyConversationStatus(
            childSummary,
            childTail,
            childLastActiveAt,
            nowMs
          );
          return {
            conversationId: entry.conversationId,
            ...(entry.parentConversationId ? { parentConversationId: entry.parentConversationId } : {}),
            displayName: deriveMemberDisplayName(childSummary, entry.conversationId),
            ...(childSummary?.agentName ? { agentName: childSummary.agentName } : {}),
            ...(childSummary?.title ? { title: childSummary.title } : {}),
            status,
            killed: Boolean(childSummary?.killed),
            lastActiveAt: childLastActiveAt,
            steps: childMetrics.session.steps,
            turns: childMetrics.session.turns,
            compactionCount: childMetrics.session.compactionCount ?? 0,
            context: extractContextDetail(childMetrics),
            tokens: extractTokensSummary(childMetrics),
          } satisfies SwarmMemberContextSnapshot;
        })
      );
      for (const m of waveResults) {
        if (m) members.push(m);
      }
    }

    members.sort((a, b) => {
      const wDiff = statusSortWeight(b.status) - statusSortWeight(a.status);
      if (wDiff !== 0) return wDiff;
      return b.lastActiveAt - a.lastActiveAt;
    });

    const mainDetail = extractContextDetail(mainMetrics);
    const mainTokens = extractTokensSummary(mainMetrics);

    let runningCount = 0;
    let waitingCount = 0;
    let completedCount = 0;
    for (const m of members) {
      if (m.status === 'running') runningCount++;
      else if (m.status === 'waiting') waitingCount++;
      else completedCount++;
    }

    let swarmTotals: SwarmTotalsSnapshot | null = null;
    if (members.length > 0) {
      let totalTokens = mainTokens.totalTokens;
      let uncachedInputTokens = mainTokens.uncachedInputTokens;
      let cachedReadTokens = mainTokens.cachedReadTokens;
      let cacheWriteTokens = mainTokens.cacheWriteTokens;
      let outputTokens = mainTokens.outputTokens;
      let totalSteps = mainMetrics.session.steps;
      let costSum = 0;
      let hasAnyPricedCost = typeof mainTokens.estimatedCostUsd === 'number';
      if (typeof mainTokens.estimatedCostUsd === 'number') {
        costSum += mainTokens.estimatedCostUsd;
      }
      let hasUnpricedSteps = Boolean(mainTokens.hasUnpricedSteps);

      for (const m of members) {
        totalTokens += m.tokens.totalTokens;
        uncachedInputTokens += m.tokens.uncachedInputTokens;
        cachedReadTokens += m.tokens.cachedReadTokens;
        cacheWriteTokens += m.tokens.cacheWriteTokens;
        outputTokens += m.tokens.outputTokens;
        totalSteps += m.steps;
        if (typeof m.tokens.estimatedCostUsd === 'number') {
          hasAnyPricedCost = true;
          costSum += m.tokens.estimatedCostUsd;
        } else if (m.tokens.totalTokens > 0) {
          hasUnpricedSteps = true;
        }
        if (m.tokens.hasUnpricedSteps) {
          hasUnpricedSteps = true;
        }
      }

      const denom = uncachedInputTokens + cachedReadTokens + cacheWriteTokens;
      const cacheHitRate = denom > 0 ? cachedReadTokens / denom : 0;
      const roundedCost = Math.round(costSum * 1e8) / 1e8;

      swarmTotals = {
        memberCount: Math.max(totalDiscoveredCount, members.length),
        evaluatedMemberCount: members.length,
        runningCount,
        waitingCount,
        completedCount,
        totalTokens,
        totalTokensCompact: compactNumber(totalTokens),
        uncachedInputTokens,
        cachedReadTokens,
        cacheWriteTokens,
        outputTokens,
        totalSteps,
        cacheHitRate,
        cacheHitRateFormatted: compactPercent(cacheHitRate),
        ...(hasAnyPricedCost
          ? {
              estimatedCostUsd: roundedCost,
              estimatedCostFormatted: compactUsd(roundedCost),
            }
          : {}),
        ...(hasUnpricedSteps ? { hasUnpricedSteps: true } : {}),
      };
    }

    const overallStatus: ConversationRunStatus =
      mainSelfStatus === 'running' || runningCount > 0
        ? 'running'
        : mainSelfStatus === 'waiting' || waitingCount > 0
        ? 'waiting'
        : 'completed';

    return {
      available: true,
      conversationId: targetId,
      title: deriveTitleFromSummary(mainSummary, targetId),
      status: overallStatus,
      lastActiveAt: Math.max(
        mainLastActiveAt,
        ...members.map((m) => m.lastActiveAt)
      ),
      updatedAt: nowMs,
      steps: mainMetrics.session.steps,
      turns: mainMetrics.session.turns,
      main: mainDetail,
      mainTokens,
      members,
      swarmTotals,
    };
  }
}

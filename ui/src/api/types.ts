export type UsagePeriodKey = 'today' | '7d' | '30d' | 'all';

export interface RuntimeInfo {
  mode: 'mcp-app';
  platform: string;
  appVersion: string;
  readOnlyMode: boolean;
  stateDir: string;
  backendRunning: boolean;
  backendPid: number | null;
  nodeVersion?: string;
}

export interface StatusSnapshot {
  schema?: number;
  mode: string;
  message: string;
  appVersion?: string;
  windows: number;
  errors?: string[];
  rssMB?: number;
  updatedAt?: string;
  pid?: number;
  locale?: string;
  readOnlyMode?: boolean;
  platform?: string;
  pricingRevision?: string;
}

export interface StatusResponse {
  ok: boolean;
  status?: StatusSnapshot;
  taskRevision?: number;
  runningTasks?: number;
  error?: string;
}

export interface TrendModelBreakdown {
  model: string;
  total_tokens: number;
  request_count: number;
}

export interface HourlyUsagePoint {
  hour: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
  by_model?: TrendModelBreakdown[];
}

export interface DailyUsagePoint {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
  by_model?: TrendModelBreakdown[];
}

export interface ProjectedModelUsage {
  model: string;
  promptTokens: number;
  candidatesTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedUsd: number;
  priced: boolean;
  partiallyPriced: boolean;
  unpricedTokens: number;
  pricingKey?: string;
  pricingStatus?: string;
}

export interface UsagePeriodResponse {
  ok: boolean;
  period: UsagePeriodKey;
  snapshotId?: string;
  selectedAccountId: string;
  availableAccounts: Array<{
    id: string;
    label: string;
    email?: string;
    name?: string | null;
    type?: 'all' | 'account';
    total_tokens?: number;
    request_count?: number;
  }>;
  summary: {
    totalTokens: number;
    promptTokens: number;
    candidatesTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    requestCount: number;
    estimatedUsd: number;
    cacheHitRate: number;
    databasesScanned: number;
    databasesDiscovered: number;
    scanScopeDescription: string;
    pricedModels: number;
    unpricedModels: number;
    failedDatabasesCount: number;
    skippedLargeRecords: number;
    lastScannedAt: number;
    hasError: boolean;
    availability: 'complete' | 'partial' | 'cached' | 'unavailable';
    unknownTimeRecords: number;
    unknownTimeTokens: number;
    pricing_warnings?: string[];
  };
  byModel: ProjectedModelUsage[];
  dailyTrends: DailyUsagePoint[];
  todayHourly: HourlyUsagePoint[];
  periods?: Record<UsagePeriodKey, UsagePeriodResponse>;
  error?: string;
}

export interface DashboardSummaryResponse {
  ok: boolean;
  accounts: null;
  usage: {
    todayTokens: number;
    totalTokens: number;
    estimatedUsd: number;
    allTimeEstimatedUsd: number;
    requestCount: number;
    totalRequestCount: number;
    pricingModels: number;
    todayPricedModels: number;
    todayUnpricedModels: number;
    unpricedModels: number;
    pricedModels: number;
    databasesScanned: number;
    databasesDiscovered: number;
    scanScopeDescription: string;
    hasError: boolean;
    availability: string;
    todayHourly?: HourlyUsagePoint[];
    todayByModel?: ProjectedModelUsage[];
    periods?: Record<UsagePeriodKey, UsagePeriodResponse>;
  } | null;
  accountsError: string;
  usageError: string;
  generatedAt?: string;
  error?: string;
}

export interface UsageEventRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  timestamp_seconds: number;
  estimated_usd: number | null;
  priced: boolean;
}

export interface UsageEventsResponse {
  ok: boolean;
  rows: UsageEventRow[];
  total: number;
  offset: number;
  limit: number;
  generated_at: number;
  snapshot_id: string;
  availability?: string;
  scope?: string;
  error?: string;
}

export interface PricingSyncStatus {
  autoSyncEnabled: boolean;
  lastSyncAt: number;
  lastCheckAt: number;
  lastSyncSuccess: boolean;
  lastCheckSuccess: boolean;
  lastSyncError: string | null;
  feedVersion: string;
  sourceUrl: string;
  modelCount: number;
}

export interface MaintenanceEntry {
  name: string;
  title: string;
  subtitle: string;
  icon: string;
  category: 'safe' | 'stateful';
  section: string;
  defaultSelected: boolean;
  impactWarning?: string;
  bytes: number;
  fileCount: number;
  itemCount?: number;
  lastModifiedAt: number;
  exists: boolean;
  clearable: boolean;
  reason?: string;
}

export interface MaintenanceProtectedEntry {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  bytes: number;
  fileCount: number;
  exists: boolean;
  truncated?: boolean;
  protected: true;
}

export interface MaintenanceScanResponse {
  ok: boolean;
  token?: string;
  retentionDays: number;
  entries: MaintenanceEntry[];
  buckets: {
    runtimeCache: { id: string; bytes: number; clearableBytes: number; fileCount: number; available: boolean };
    historyLogs: { id: string; bytes: number; clearableBytes: number; fileCount: number; subagentCount: number; retentionDays: number; available: boolean };
  };
  safeBytes: number;
  statefulBytes: number;
  totalBytes: number;
  totalFiles: number;
  uncertainConversations: { count: number; message: string };
  protectedEntries: MaintenanceProtectedEntry[];
  protectedBytes: number;
  truncated: boolean;
  running: boolean;
  browserBusy: boolean;
  scannedAt: number;
  error?: string;
}

export interface IpcBaseReply {
  ok: boolean;
  code?: string;
  error?: string;
  message?: string;
}

export type IpcDynamicReply = IpcBaseReply & Record<string, unknown>;

export type ConversationRunStatus = 'running' | 'waiting' | 'completed';
export type ContextCapacitySource = 'explicit' | 'reference' | 'unknown';

export interface ContextModelStage {
  slotKey: string;
  role: 'planner' | 'executor' | 'model';
  section?: 'primary' | 'history';
  modelId: string;
  modelDisplayName: string;
  shortLabel: string;
  compactLabel: string;
  hasUsageData: boolean;
  isActive: boolean;
  compactionCount?: number;
  usedTokens: number;
  usedTokensCompact: string;
  usedTokensFormatted: string;
  peakContextTokens: number;
  peakContextCompact: string;
  peakContextFormatted: string;
  capacityTokens: number;
  capacityTokensCompact: string;
  isFallbackCapacity: boolean;
  capacitySource: ContextCapacitySource;
  usedRatio: number;
  usedRatioFormatted: string;
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
  capacitySource: ContextCapacitySource;
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
  modelStages?: ContextModelStage[];
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

export interface ContextConversationsListResponse {
  ok: boolean;
  conversations: ConversationContextSummaryItem[];
  recommendedId: string | null;
  error?: string;
}

export interface ContextConversationDetailResponse {
  ok: boolean;
  snapshot: ConversationContextSnapshot;
  error?: string;
}

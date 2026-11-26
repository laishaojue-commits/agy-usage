import './styles/theme.css';
import {
  applyMcpThemePreference,
  getRuntimeInfo,
  initMcpAppBridge,
  ipcCall,
  isMcpAppRuntime,
} from './api/bridge';
import type {
  ContextConversationDetailResponse,
  ContextConversationsListResponse,
  ConversationContextSnapshot,
  ConversationContextSummaryItem,
  DashboardSummaryResponse,
  MaintenanceScanResponse,
  PricingSyncStatus,
  RuntimeInfo,
  StatusResponse,
  StatusSnapshot,
  UsageEventsResponse,
  UsagePeriodKey,
  UsagePeriodResponse,
} from './api/types';
import { t } from './i18n/l10n';
import {
  getUiCapabilities,
  resolveAllowedView,
  type UiCapabilities,
  type ViewId,
} from './ui/capabilities';
import {
  AppShellController,
  computeStatusFingerprint,
  STATUS_SENSITIVE_VIEWS,
  type SidebarPatchState,
  type ToastItem,
} from './ui/shell';
import { renderAboutView } from './views/about';
import { renderContextView } from './views/context';
import { renderOverviewView } from './views/overview';
import { renderSettingsView, type ThemePreference } from './views/settings';
import { renderStorageView } from './views/storage';
import { renderUsageView } from './views/usage';

interface UiPrefsPayload {
  theme?: ThemePreference;
}

interface RenderPlan {
  sidebar: boolean;
  serviceAlert: boolean;
  main: boolean;
  toasts: boolean;
  resetScroll: boolean;
}

function emptyRenderPlan(): RenderPlan {
  return {
    sidebar: false,
    serviceAlert: false,
    main: false,
    toasts: false,
    resetScroll: false,
  };
}

const uiCapabilities: UiCapabilities = getUiCapabilities('mcp-app');

function readInitialView(capabilities: UiCapabilities): ViewId {
  if (typeof window === 'undefined') return capabilities.defaultView;
  const qs = new URLSearchParams(window.location.search).get('view');
  if (qs !== null) return resolveAllowedView(qs, capabilities);
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) return resolveAllowedView(hash, capabilities);
  return capabilities.defaultView;
}

function readInitialConversationId(): string | null {
  if (typeof window === 'undefined') return null;
  const qs = new URLSearchParams(window.location.search).get('conversationId');
  return qs && qs.trim() ? qs.trim().toLowerCase() : null;
}

function readThemePref(): ThemePreference {
  try {
    const saved = localStorage.getItem('gb-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {}
  return 'system';
}

function applyTheme(theme: ThemePreference) {
  try {
    localStorage.setItem('gb-theme', theme);
  } catch {}
  applyMcpThemePreference(theme);
}

interface AppState {
  activeView: ViewId;
  theme: ThemePreference;
  status: StatusSnapshot | null;
  dashboard: DashboardSummaryResponse | null;
  contextConversations: ConversationContextSummaryItem[];
  contextRecommendedId: string | null;
  selectedConversationId: string | null;
  contextAutoTrack: boolean;
  contextSnapshot: ConversationContextSnapshot | null;
  contextShowCompleted: boolean;
  contextExpandedMemberId: string | null;
  runtimeInfo: RuntimeInfo | null;
  usagePeriod: UsagePeriodKey;
  usageAccountId: string;
  usageDim: 'tokens' | 'requests';
  usage: UsagePeriodResponse | null;
  events: UsageEventsResponse | null;
  eventsQuery: string;
  eventsOffset: number;
  activeSnapshotId: string | null;
  pricingStatus: PricingSyncStatus | null;
  storageScan: MaintenanceScanResponse | null;
  storageRetentionDays: number;
  pingLatencyMs: number | null;
  loading: boolean;
  busyAction: string | null;
  serviceError: string | null;
  toasts: ToastItem[];
}

const initialUrlConversationId = readInitialConversationId();

const state: AppState = {
  activeView: readInitialView(uiCapabilities),
  theme: readThemePref(),
  status: null,
  dashboard: null,
  contextConversations: [],
  contextRecommendedId: null,
  selectedConversationId: initialUrlConversationId,
  contextAutoTrack: !initialUrlConversationId,
  contextSnapshot: null,
  contextShowCompleted: false,
  contextExpandedMemberId: null,
  runtimeInfo: null,
  usagePeriod: 'today',
  usageAccountId: 'all',
  usageDim: 'tokens',
  usage: null,
  events: null,
  eventsQuery: '',
  eventsOffset: 0,
  activeSnapshotId: null,
  pricingStatus: null,
  storageScan: null,
  storageRetentionDays: 7,
  pingLatencyMs: null,
  loading: true,
  busyAction: null,
  serviceError: null,
  toasts: [],
};

let toastSeq = 0;
let searchTimer: number | undefined;
let rafId: number | null = null;
let pendingPlan: RenderPlan = emptyRenderPlan();
let viewLoadSeq = 0;
let contextPollInFlight = false;
let shellController: AppShellController | null = null;

function getShellController(): AppShellController | null {
  const root = document.getElementById('app');
  if (!root) return null;
  if (!shellController) {
    shellController = new AppShellController(root);
  }
  return shellController;
}

function currentSidebarState(): SidebarPatchState {
  return {
    activeView: resolveAllowedView(state.activeView, uiCapabilities),
    status: state.status,
    serviceError: state.serviceError,
    busyAction: state.busyAction,
    capabilities: uiCapabilities,
    brandTitle: uiCapabilities.brandTitle,
  };
}

function mergeRenderPlan(target: RenderPlan, patch?: Partial<RenderPlan>): RenderPlan {
  const src: Partial<RenderPlan> = patch ?? { sidebar: true, serviceAlert: true, main: true };
  return {
    sidebar: target.sidebar || Boolean(src.sidebar),
    serviceAlert: target.serviceAlert || Boolean(src.serviceAlert),
    main: target.main || Boolean(src.main),
    toasts: target.toasts || Boolean(src.toasts),
    resetScroll: target.resetScroll || Boolean(src.resetScroll),
  };
}

function applyRender(plan: RenderPlan): void {
  const shell = getShellController();
  if (!shell) return;
  const sidebarState = currentSidebarState();
  shell.ensureMounted(sidebarState);
  if (plan.sidebar) {
    shell.patchSidebar(sidebarState);
  }
  if (plan.serviceAlert) {
    shell.patchServiceAlert(state.status, state.serviceError);
  }
  if (plan.toasts) {
    shell.patchToasts(state.toasts);
  }
  if (plan.main) {
    shell.patchMainView({
      html: renderViewContent(),
      resetScroll: plan.resetScroll,
    });
  }
}

function flushRender(patch?: Partial<RenderPlan>): void {
  const merged = mergeRenderPlan(pendingPlan, patch);
  pendingPlan = emptyRenderPlan();
  if (rafId !== null) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }
  applyRender(merged);
}

function scheduleRender(patch?: Partial<RenderPlan>): void {
  pendingPlan = mergeRenderPlan(pendingPlan, patch);
  if (rafId !== null) return;
  rafId = window.requestAnimationFrame(() => {
    rafId = null;
    const next = pendingPlan;
    pendingPlan = emptyRenderPlan();
    applyRender(next);
  });
}

function pushToast(text: string) {
  const id = ++toastSeq;
  state.toasts = [...state.toasts.slice(-2), { id, text }];
  scheduleRender({ sidebar: false, serviceAlert: false, main: false, toasts: true });
  window.setTimeout(() => {
    state.toasts = state.toasts.filter((x) => x.id !== id);
    scheduleRender({ sidebar: false, serviceAlert: false, main: false, toasts: true });
  }, 3200);
}

function applyUiPrefs(prefs: UiPrefsPayload | null | undefined) {
  if (!prefs || typeof prefs !== 'object') return;
  if (prefs.theme === 'system' || prefs.theme === 'light' || prefs.theme === 'dark') {
    state.theme = prefs.theme;
    applyTheme(state.theme);
  }
}

async function releaseUsageSnapshot() {
  if (!state.activeSnapshotId) return;
  const sid = state.activeSnapshotId;
  state.activeSnapshotId = null;
  await ipcCall({ command: 'usage_snapshot_release', snapshotId: sid }).catch(() => {});
}

async function loadStatusAndRuntime() {
  try {
    const [rt, st] = await Promise.all([
      state.runtimeInfo ? Promise.resolve(state.runtimeInfo) : getRuntimeInfo(),
      ipcCall<StatusResponse>({ command: 'status', includeTasks: false }),
    ]);
    state.runtimeInfo = rt;
    if (st.ok && st.status) {
      state.status = st.status;
      state.serviceError = null;
    } else if (st.error) {
      state.serviceError = st.error;
    }
  } catch (err) {
    state.serviceError = err instanceof Error ? err.message : t('win.common.service_offline');
  }
}

async function loadDashboard() {
  const res = await ipcCall<DashboardSummaryResponse>({ command: 'dashboard_summary' });
  if (res.ok) {
    state.dashboard = res;
  }
}

async function loadContextData() {
  const listRes = await ipcCall<ContextConversationsListResponse>({
    command: 'context_conversations_list',
    limit: 30,
  }).catch(() => null);
  if (listRes?.ok) {
    state.contextConversations = listRes.conversations ?? [];
    state.contextRecommendedId = listRes.recommendedId ?? null;
  }
  const targetId = state.contextAutoTrack
    ? state.contextRecommendedId || state.selectedConversationId || undefined
    : state.selectedConversationId || state.contextRecommendedId || undefined;

  const detailRes = await ipcCall<ContextConversationDetailResponse>({
    command: 'context_conversation_detail',
    ...(targetId ? { conversationId: targetId } : {}),
  }).catch(() => null);
  if (detailRes?.ok && detailRes.snapshot) {
    state.contextSnapshot = detailRes.snapshot;
    if (state.contextAutoTrack || !state.selectedConversationId) {
      state.selectedConversationId = detailRes.snapshot.conversationId;
    }
  }
}

function computeContextFingerprint(
  conversations: ConversationContextSummaryItem[],
  recommendedId: string | null,
  snapshot: ConversationContextSnapshot | null
): string {
  return JSON.stringify({
    recommendedId,
    convIds: conversations.map((c) => `${c.conversationId}:${c.status}:${c.lastActiveAt}:${c.childCount}:${c.activeChildCount}`),
    snapshot: snapshot
      ? {
          id: snapshot.conversationId,
          status: snapshot.status,
          lastActiveAt: snapshot.lastActiveAt,
          steps: snapshot.steps,
          hasUsage: snapshot.main.hasUsageData,
          modelId: snapshot.main.modelId,
          modelDisplayName: snapshot.main.modelDisplayName,
          capSource: snapshot.main.capacitySource,
          isOrchestrator: Boolean(snapshot.main.isOrchestrator),
          stages: (snapshot.main.modelStages ?? []).map(
            (s) =>
              `${s.slotKey}:${s.role}:${s.modelId}:${s.modelDisplayName}:${s.shortLabel}:${s.hasUsageData}:${s.isActive}:${s.usedTokens}:${s.capacityTokens}:${s.capacitySource}:${s.compactionCount ?? 0}`
          ),
          used: snapshot.main.usedTokens,
          peak: snapshot.main.peakContextTokens,
          cap: snapshot.main.capacityTokens,
          hit: snapshot.main.averageCacheHitRate,
          latestHit: snapshot.main.latestStepCacheHitRate,
          comp: snapshot.main.compactionCount,
          breakdown: [
            snapshot.main.breakdown.cachedContextTokens,
            snapshot.main.breakdown.uncachedContextTokens,
            snapshot.main.breakdown.latestOutputTokens,
          ],
          mainTokens: [
            snapshot.mainTokens?.totalTokens ?? 0,
            snapshot.mainTokens?.estimatedCostUsd ?? 0,
          ],
          swarmTotals: [
            snapshot.swarmTotals?.memberCount ?? 0,
            snapshot.swarmTotals?.totalTokens ?? 0,
            snapshot.swarmTotals?.estimatedCostUsd ?? 0,
          ],
          members: snapshot.members.map(
            (m) =>
              `${m.conversationId}:${m.status}:${m.killed}:${m.lastActiveAt}:${m.steps}:${m.context.modelId}:${m.context.capacitySource}:${m.context.usedTokens}:${m.compactionCount}:${m.tokens.totalTokens}`
          ),
        }
      : null,
  });
}

async function loadUsage(force = false) {
  const res = await ipcCall<UsagePeriodResponse>({
    command: 'usage_summary',
    period: state.usagePeriod,
    accountId: state.usageAccountId,
    force,
  });
  if (res.ok) {
    state.usage = res;
    if (res.snapshotId && res.snapshotId !== state.activeSnapshotId) {
      await releaseUsageSnapshot();
      state.activeSnapshotId = res.snapshotId;
    }
  }
  await loadUsageEvents(false);
}

async function loadUsageEvents(force = false) {
  const res = await ipcCall<UsageEventsResponse>({
    command: 'usage_events',
    period: state.usagePeriod,
    accountId: state.usageAccountId,
    query: state.eventsQuery,
    offset: state.eventsOffset,
    limit: 20,
    snapshotId: state.activeSnapshotId ?? undefined,
    pinSnapshot: Boolean(state.activeSnapshotId),
    force,
  });
  if (res.ok) {
    state.events = res;
    if (res.snapshot_id) state.activeSnapshotId = res.snapshot_id;
  }
}

async function loadPricingStatus() {
  const res = await ipcCall<{ ok: boolean; status?: PricingSyncStatus }>({ command: 'pricing_sync_status' });
  if (res.ok && res.status) state.pricingStatus = res.status;
}

async function loadStorageScan() {
  const res = await ipcCall<MaintenanceScanResponse>({
    command: 'maintenance_scan',
    retentionDays: state.storageRetentionDays,
  });
  if (res.ok) state.storageScan = res;
}

async function loadAboutPing() {
  const t0 = performance.now();
  const res = await ipcCall({ command: 'ping' });
  if (res.ok) {
    state.pingLatencyMs = Math.max(1, Math.round(performance.now() - t0));
  }
}

async function loadViewPayload(view: ViewId, force: boolean): Promise<void> {
  if (view === 'overview') {
    await Promise.all([loadDashboard(), loadContextData()]);
  } else if (view === 'context') {
    await loadContextData();
  } else if (view === 'usage') {
    await Promise.all([loadUsage(force), loadPricingStatus()]);
  } else if (view === 'storage') {
    await loadStorageScan();
  } else if (view === 'about') {
    await loadAboutPing();
  }
}

async function refreshCurrentView(force = false, seq = ++viewLoadSeq) {
  const targetView = state.activeView;
  state.loading = true;
  scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
  try {
    await Promise.all([loadStatusAndRuntime(), loadViewPayload(targetView, force)]);
  } finally {
    if (seq === viewLoadSeq) {
      state.loading = false;
      scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
    }
  }
}

async function navigateTo(requestedView: ViewId | string) {
  const view = resolveAllowedView(requestedView, uiCapabilities);
  if (state.activeView === view) return;
  const seq = ++viewLoadSeq;
  state.activeView = view;
  state.loading = true;
  flushRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: true });
  await refreshCurrentView(false, seq);
}

async function pollStatusSync() {
  const prevFingerprint = computeStatusFingerprint(state.status, state.serviceError);
  await loadStatusAndRuntime();
  const nextFingerprint = computeStatusFingerprint(state.status, state.serviceError);
  if (prevFingerprint === nextFingerprint) return;

  const shouldPatchMain = STATUS_SENSITIVE_VIEWS.has(state.activeView);
  scheduleRender({
    sidebar: true,
    serviceAlert: true,
    main: shouldPatchMain,
    resetScroll: false,
  });
}

async function pollContextSync() {
  if (contextPollInFlight) return;
  if (state.activeView !== 'context' && state.activeView !== 'overview') return;
  contextPollInFlight = true;
  const prevFp = computeContextFingerprint(
    state.contextConversations,
    state.contextRecommendedId,
    state.contextSnapshot
  );
  try {
    await loadContextData();
    const nextFp = computeContextFingerprint(
      state.contextConversations,
      state.contextRecommendedId,
      state.contextSnapshot
    );
    if (prevFp !== nextFp && (state.activeView === 'context' || state.activeView === 'overview')) {
      scheduleRender({
        sidebar: false,
        serviceAlert: false,
        main: true,
        resetScroll: false,
      });
    }
  } finally {
    contextPollInFlight = false;
  }
}

async function handleAction(action: string) {
  if (action === 'refresh-all') {
    state.busyAction = 'refresh';
    scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
    try {
      await refreshCurrentView(true);
    } finally {
      state.busyAction = null;
      scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
    }
    return;
  }

  if (action === 'refresh-usage') {
    state.busyAction = 'usage';
    scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    try {
      await loadUsage(true);
    } finally {
      state.busyAction = null;
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    }
    return;
  }

  if (action === 'scan-storage') {
    state.busyAction = 'storage';
    flushRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    try {
      await loadStorageScan();
    } finally {
      state.busyAction = null;
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    }
    return;
  }

  if (action === 'context-refresh') {
    state.busyAction = 'context';
    scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    try {
      await loadContextData();
    } finally {
      state.busyAction = null;
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    }
    return;
  }

  if (action === 'context-toggle-auto') {
    state.contextAutoTrack = !state.contextAutoTrack;
    if (state.contextAutoTrack) {
      state.busyAction = 'context';
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      try {
        await loadContextData();
      } finally {
        state.busyAction = null;
        scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      }
    } else {
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    }
    return;
  }

  if (action === 'context-jump-active') {
    state.contextAutoTrack = true;
    state.selectedConversationId = state.contextRecommendedId;
    state.contextExpandedMemberId = null;
    state.busyAction = 'context';
    scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    try {
      await loadContextData();
    } finally {
      state.busyAction = null;
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    }
    return;
  }

  if (action === 'context-toggle-completed') {
    state.contextShowCompleted = !state.contextShowCompleted;
    scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    return;
  }

  if (action === 'copy-diagnostics') {
    const diag = {
      appVersion: state.runtimeInfo?.appVersion || '0.1.0',
      mode: uiCapabilities.mode,
      platform: state.status?.platform || state.runtimeInfo?.platform || 'unknown',
      readOnlyMode: state.status?.readOnlyMode ?? state.runtimeInfo?.readOnlyMode ?? true,
      nodeVersion: state.runtimeInfo?.nodeVersion,
      rssMB: state.status?.rssMB,
      pingLatencyMs: state.pingLatencyMs,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      pushToast(t('win.about.copied'));
    } catch {
      pushToast(t('assistant.action_incomplete'));
    }
  }
}

function renderViewContent(): string {
  const view = resolveAllowedView(state.activeView, uiCapabilities);
  switch (view) {
    case 'overview':
      return renderOverviewView({
        status: state.status,
        dashboard: state.dashboard,
        contextSnapshot: state.contextSnapshot,
        loading: state.loading,
        busyAction: state.busyAction,
        capabilities: uiCapabilities,
      });
    case 'context':
      return renderContextView({
        conversations: state.contextConversations,
        recommendedId: state.contextRecommendedId,
        selectedConversationId: state.selectedConversationId,
        autoTrack: state.contextAutoTrack,
        snapshot: state.contextSnapshot,
        showCompleted: state.contextShowCompleted,
        expandedMemberId: state.contextExpandedMemberId,
        loading: state.loading,
        busyAction: state.busyAction,
      });
    case 'usage':
      return renderUsageView({
        period: state.usagePeriod,
        accountId: state.usageAccountId,
        dim: state.usageDim,
        usage: state.usage,
        events: state.events,
        eventsQuery: state.eventsQuery,
        eventsOffset: state.eventsOffset,
        pricingStatus: state.pricingStatus,
        busyAction: state.busyAction,
      });
    case 'storage':
      return renderStorageView({
        scan: state.storageScan,
        retentionDays: state.storageRetentionDays,
        loading: state.loading,
        busyAction: state.busyAction,
      });
    case 'settings':
      return renderSettingsView({
        status: state.status,
        runtimeInfo: state.runtimeInfo,
        theme: state.theme,
        capabilities: uiCapabilities,
      });
    case 'about':
      return renderAboutView({
        status: state.status,
        runtimeInfo: state.runtimeInfo,
        pingLatencyMs: state.pingLatencyMs,
        capabilities: uiCapabilities,
      });
  }
}

function attachEvents() {
  const root = document.getElementById('app');
  if (!root) return;

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const navBtn = target.closest<HTMLElement>('[data-nav]');
    if (navBtn?.dataset.nav) {
      void navigateTo(navBtn.dataset.nav);
      return;
    }
    const actionBtn = target.closest<HTMLElement>('[data-action]');
    if (actionBtn?.dataset.action) {
      void handleAction(actionBtn.dataset.action);
      return;
    }
    const memberBtn = target.closest<HTMLElement>('[data-context-member]');
    if (memberBtn?.dataset.contextMember) {
      const cid = memberBtn.dataset.contextMember;
      state.contextExpandedMemberId = state.contextExpandedMemberId === cid ? null : cid;
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      return;
    }
    const periodBtn = target.closest<HTMLElement>('[data-usage-period]');
    if (periodBtn?.dataset.usagePeriod) {
      const p = periodBtn.dataset.usagePeriod as UsagePeriodKey;
      if (p !== state.usagePeriod) {
        state.usagePeriod = p;
        state.eventsOffset = 0;
        void loadUsage(false).then(() => {
          scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
        });
      }
      return;
    }
    const dimBtn = target.closest<HTMLElement>('[data-usage-dim]');
    if (dimBtn?.dataset.usageDim) {
      state.usageDim = dimBtn.dataset.usageDim === 'requests' ? 'requests' : 'tokens';
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      return;
    }
    const pageBtn = target.closest<HTMLElement>('[data-events-page]');
    if (pageBtn?.dataset.eventsPage) {
      const limit = state.events?.limit ?? 20;
      const total = state.events?.total ?? 0;
      if (pageBtn.dataset.eventsPage === 'prev') {
        state.eventsOffset = Math.max(0, state.eventsOffset - limit);
      } else if (state.eventsOffset + limit < total) {
        state.eventsOffset += limit;
      }
      void loadUsageEvents(false).then(() => {
        scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      });
    }
  });

  root.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    if ('usageAccount' in target.dataset) {
      state.usageAccountId = target.value || 'all';
      state.eventsOffset = 0;
      void loadUsage(false).then(() => {
        scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      });
      return;
    }
    if ('contextConversation' in target.dataset) {
      const nextId = target.value?.trim() || null;
      state.contextAutoTrack = false;
      state.selectedConversationId = nextId;
      state.contextExpandedMemberId = null;
      state.busyAction = 'context';
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      void loadContextData().finally(() => {
        state.busyAction = null;
        scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      });
      return;
    }
    if ('storageRetention' in target.dataset) {
      state.storageRetentionDays = Number(target.value);
      state.busyAction = 'storage';
      flushRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      void loadStorageScan().finally(() => {
        state.busyAction = null;
        scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      });
      return;
    }
    if ('settingTheme' in target.dataset) {
      state.theme = target.value as ThemePreference;
      applyTheme(state.theme);
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      void ipcCall({ command: 'ui_prefs_set', theme: state.theme }).catch(() => {});
    }
  });

  root.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement | null;
    if (!target || !('eventsSearch' in target.dataset)) return;
    state.eventsQuery = target.value;
    state.eventsOffset = 0;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      void loadUsageEvents(false).then(() => {
        scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
      });
    }, 240);
  });

  root.addEventListener('mouseover', (e) => {
    const bar = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]');
    if (!bar?.dataset.tip) return;
    const box = bar.closest('.gb-chart-box');
    const tipEl = box?.querySelector<HTMLElement>('[data-chart-tip]');
    if (tipEl) tipEl.textContent = bar.dataset.tip;
  });

  const restoreChartTip = (svg: Element | null) => {
    if (!svg) return;
    const tipEl = svg.closest('.gb-chart-box')?.querySelector<HTMLElement>('[data-chart-tip]');
    if (tipEl) tipEl.textContent = tipEl.dataset.defaultTip ?? '';
  };

  root.addEventListener(
    'mouseleave',
    (e) => {
      const target = e.target as Element | null;
      if (target?.classList?.contains('gb-trend-svg')) {
        restoreChartTip(target);
      }
    },
    true
  );

  root.addEventListener('mouseout', (e) => {
    const target = e.target as Element | null;
    const svg = target?.closest('.gb-trend-svg');
    if (!svg) return;
    const related = (e as MouseEvent).relatedTarget as Node | null;
    if (related && svg.contains(related)) return;
    restoreChartTip(svg);
  });
}

async function bootstrap() {
  applyTheme(state.theme);
  attachEvents();
  flushRender({ sidebar: true, serviceAlert: true, main: true, toasts: true, resetScroll: true });

  if (isMcpAppRuntime()) {
    document.documentElement.setAttribute('data-gb-mode', 'mcp-app');
    let switchedByToolResult = false;
    let toolResultDelivered = false;
    try {
      await initMcpAppBridge({
        onToolInput: (args) => {
          const requestedConvId =
            typeof args.conversationId === 'string' && args.conversationId.trim()
              ? args.conversationId.trim().toLowerCase()
              : null;
          if (requestedConvId) {
            state.selectedConversationId = requestedConvId;
            state.contextAutoTrack = false;
            state.contextExpandedMemberId = null;
          }
          const requestedView = typeof args.view === 'string' ? args.view : null;
          if (requestedView !== null) {
            const nextView = resolveAllowedView(requestedView, uiCapabilities);
            if (state.activeView !== nextView) {
              state.activeView = nextView;
              state.loading = true;
              flushRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: true });
            }
          }
        },
        onToolResult: (sc) => {
          toolResultDelivered = true;
          if (sc.runtimeInfo && typeof sc.runtimeInfo === 'object') {
            state.runtimeInfo = sc.runtimeInfo as RuntimeInfo;
          }
          if (sc.uiPrefs && typeof sc.uiPrefs === 'object') {
            applyUiPrefs(sc.uiPrefs as UiPrefsPayload);
          }
          if (sc.status && typeof sc.status === 'object') {
            state.status = sc.status as StatusSnapshot;
          }
          const initialConvId =
            typeof sc.initialConversationId === 'string' && sc.initialConversationId.trim()
              ? sc.initialConversationId.trim().toLowerCase()
              : null;
          const convChanged = Boolean(
            initialConvId && initialConvId !== state.selectedConversationId
          );
          if (initialConvId) {
            state.selectedConversationId = initialConvId;
            state.contextAutoTrack = false;
            state.contextExpandedMemberId = null;
          }
          const initialView = typeof sc.initialView === 'string' ? sc.initialView : null;
          if (initialView !== null) {
            const nextView = resolveAllowedView(initialView, uiCapabilities);
            if (state.activeView !== nextView) {
              switchedByToolResult = true;
              void navigateTo(nextView);
            } else if (convChanged) {
              void loadContextData().then(() => {
                scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
              });
            } else {
              scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
            }
          } else if (convChanged) {
            void loadContextData().then(() => {
              scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
            });
          } else {
            scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
          }
        },
        onHostContextChanged: () => {
          if (state.theme === 'system') {
            applyTheme('system');
          }
        },
      });
      if (!toolResultDelivered) {
        const prefsRes = await ipcCall<{ ok: boolean; prefs?: UiPrefsPayload }>({ command: 'ui_prefs_get' }).catch(() => null);
        if (prefsRes?.ok && prefsRes.prefs) {
          applyUiPrefs(prefsRes.prefs);
        }
      }
      if (!switchedByToolResult) {
        await refreshCurrentView(false);
      }
    } catch (err) {
      state.loading = false;
      state.serviceError = err instanceof Error ? err.message : t('win.common.service_offline');
      scheduleRender({ sidebar: true, serviceAlert: true, main: true, resetScroll: false });
    }
  } else {
    await refreshCurrentView(false);
  }

  // Periodic light status & active context sync (no DOM write unless fingerprint changed)
  window.setInterval(() => {
    if (document.hidden) return;
    void pollStatusSync();
    void pollContextSync();
  }, 5000);
}

void bootstrap();

window.addEventListener('storage', (ev) => {
  if (ev.key === 'gb-theme') {
    state.theme = readThemePref();
    applyTheme(state.theme);
    if (state.activeView === 'settings') {
      scheduleRender({ sidebar: false, serviceAlert: false, main: true, resetScroll: false });
    }
  }
});
window.addEventListener('beforeunload', () => {
  void releaseUsageSnapshot();
});

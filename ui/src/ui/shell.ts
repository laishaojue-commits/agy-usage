import type { StatusSnapshot } from '../api/types';
import { t } from '../i18n/l10n';
import { appLogoUrl, escapeHtml } from '../utils/format';
import {
  getUiCapabilities,
  resolveAllowedView,
  type UiCapabilities,
  type ViewId,
} from './capabilities';

export type { ViewId };

export const NAV_ITEMS: ReadonlyArray<{ id: ViewId; key: string; icon: string }> = [
  {
    id: 'overview',
    key: 'nav.overview',
    icon: '<svg class="gb-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  },
  {
    id: 'context',
    key: 'win.nav.context',
    icon: '<svg class="gb-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4a8 8 0 1 0 8 8"/><path d="M12 12l4.5-4.5"/><circle cx="12" cy="12" r="1.5"/><path d="M16 4h4v4"/></svg>',
  },
  {
    id: 'usage',
    key: 'nav.usage',
    icon: '<svg class="gb-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20v-4"/></svg>',
  },
  {
    id: 'storage',
    key: 'win.nav.storage',
    icon: '<svg class="gb-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/><circle cx="7" cy="6" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="7" cy="18" r="1"/></svg>',
  },
  {
    id: 'settings',
    key: 'nav.settings',
    icon: '<svg class="gb-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  },
  {
    id: 'about',
    key: 'nav.about',
    icon: '<svg class="gb-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  },
];

export const STATUS_SENSITIVE_VIEWS: ReadonlySet<ViewId> = new Set(['overview', 'settings', 'about']);

export function isValidView(v: string | null | undefined): v is ViewId {
  return Boolean(v && NAV_ITEMS.some((n) => n.id === v));
}

export function computeStatusFingerprint(
  status: StatusSnapshot | null,
  serviceError: string | null
): string {
  return [
    status?.mode ?? '',
    status?.message ?? '',
    status?.appVersion ?? '',
    status?.locale ?? '',
    status?.pid ?? '',
    serviceError ?? '',
  ].join('|');
}

export function statusDotClass(
  status: StatusSnapshot | null
): 'ok' | 'warn' | 'danger' | '' {
  if (!status) return 'danger';
  const mode = status.mode;
  if (mode === 'mcp-direct') return 'ok';
  if (mode === 'stopped' || mode === 'error') return 'danger';
  return '';
}

export interface SidebarPatchState {
  activeView: ViewId;
  status: StatusSnapshot | null;
  serviceError: string | null;
  busyAction: string | null;
  capabilities?: UiCapabilities;
  brandTitle?: string;
}

export interface ToastItem {
  id: number;
  text: string;
}

interface SearchInputSnapshot {
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: 'forward' | 'backward' | 'none' | null;
}

interface ScrollSnapshot {
  mainTop: number;
  mainLeft: number;
  docTop: number;
  bodyTop: number;
  winX: number;
  winY: number;
}

export class AppShellController {
  private sidebarEl: HTMLElement | null = null;
  private brandSubEl: HTMLElement | null = null;
  private navButtons = new Map<ViewId, HTMLButtonElement>();
  private statusChipEl: HTMLElement | null = null;
  private statusDotEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private mainEl: HTMLElement | null = null;
  private serviceAlertHostEl: HTMLElement | null = null;
  private viewHostEl: HTMLElement | null = null;
  private toastHostEl: HTMLElement | null = null;

  private lastViewHtml: string | null = null;
  private lastAlertHtml: string | null = null;
  private lastToastsHtml: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly doc: Document = document,
    private readonly win: Window | undefined = typeof window !== 'undefined' ? window : undefined
  ) {}

  ensureMounted(initial: SidebarPatchState): void {
    const existingViewHost = this.root.querySelector<HTMLElement>('#gb-view-host');
    if (this.viewHostEl && existingViewHost === this.viewHostEl) {
      return;
    }

    const caps = initial.capabilities ?? getUiCapabilities('mcp-app');
    const brandTitle = initial.brandTitle || caps.brandTitle;
    const activeView = resolveAllowedView(initial.activeView, caps);
    const visibleSet = new Set(caps.visibleViews);
    const visibleNavItems = NAV_ITEMS.filter((item) => visibleSet.has(item.id));

    const navHtml = visibleNavItems.map(
      (item) => `
        <button class="gb-nav-item ${item.id === activeView ? 'active' : ''}" data-nav="${item.id}">
          ${item.icon}
          <span data-nav-label="${item.id}">${escapeHtml(t(item.key))}</span>
        </button>
      `
    ).join('');

    const dotCls = statusDotClass(initial.status);
    const statusLabel = initial.status?.message || initial.serviceError || t('sidebar.waiting_service');

    this.root.innerHTML = `
      <div class="gb-shell">
        <aside class="gb-sidebar" aria-label="${escapeHtml(t('nav.accessibility'))}">
          <div class="gb-brand">
            <img class="gb-brand-logo" src="${escapeHtml(appLogoUrl)}" alt="${escapeHtml(brandTitle)}" />
            <div>
              <div class="gb-brand-title">${escapeHtml(brandTitle)}</div>
              <div class="gb-brand-sub" data-brand-sub>${escapeHtml(t('win.brand_sub_mcp'))}</div>
            </div>
          </div>
          <nav class="gb-nav">${navHtml}</nav>
          <div class="gb-sidebar-footer">
            <div class="gb-status-chip" id="gb-status-chip" title="${escapeHtml(statusLabel)}">
              <span class="gb-dot ${dotCls}" id="gb-status-dot"></span>
              <span id="gb-status-text" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(statusLabel)}</span>
            </div>
          </div>
        </aside>
        <main class="gb-main" id="gb-main">
          <div id="gb-service-alert-host" class="gb-service-alert-host"></div>
          <div id="gb-view-host" class="gb-view-host"></div>
        </main>
      </div>
      <div id="gb-toast-host" class="gb-toast-host" hidden></div>
    `;

    this.sidebarEl = this.root.querySelector<HTMLElement>('.gb-sidebar');
    this.brandSubEl = this.root.querySelector<HTMLElement>('[data-brand-sub]');
    this.navButtons.clear();
    for (const item of visibleNavItems) {
      const btn = this.root.querySelector<HTMLButtonElement>(`[data-nav="${item.id}"]`);
      if (btn) this.navButtons.set(item.id, btn);
    }
    this.statusChipEl = this.root.querySelector<HTMLElement>('#gb-status-chip');
    this.statusDotEl = this.root.querySelector<HTMLElement>('#gb-status-dot');
    this.statusTextEl = this.root.querySelector<HTMLElement>('#gb-status-text');
    this.mainEl = this.root.querySelector<HTMLElement>('#gb-main');
    this.serviceAlertHostEl = this.root.querySelector<HTMLElement>('#gb-service-alert-host');
    this.viewHostEl = this.root.querySelector<HTMLElement>('#gb-view-host');
    this.toastHostEl = this.root.querySelector<HTMLElement>('#gb-toast-host');

    this.lastViewHtml = null;
    this.lastAlertHtml = null;
    this.lastToastsHtml = null;
  }

  patchSidebar(next: SidebarPatchState): void {
    this.ensureMounted(next);

    const caps = next.capabilities ?? getUiCapabilities('mcp-app');
    const activeView = resolveAllowedView(next.activeView, caps);

    if (this.sidebarEl) {
      const aria = t('nav.accessibility');
      if (this.sidebarEl.getAttribute('aria-label') !== aria) {
        this.sidebarEl.setAttribute('aria-label', aria);
      }
    }
    if (this.brandSubEl) {
      const subText = t('win.brand_sub_mcp');
      if (this.brandSubEl.textContent !== subText) {
        this.brandSubEl.textContent = subText;
      }
    }

    for (const item of NAV_ITEMS) {
      const btn = this.navButtons.get(item.id);
      if (!btn) continue;
      const expectedClass = item.id === activeView ? 'gb-nav-item active' : 'gb-nav-item';
      if (btn.className !== expectedClass) {
        btn.className = expectedClass;
      }
      const labelEl = btn.querySelector<HTMLElement>(`[data-nav-label="${item.id}"]`);
      const labelText = t(item.key);
      if (labelEl && labelEl.textContent !== labelText) {
        labelEl.textContent = labelText;
      }
    }

    const dotCls = statusDotClass(next.status);
    const expectedDotClass = dotCls ? `gb-dot ${dotCls}` : 'gb-dot';
    if (this.statusDotEl && this.statusDotEl.className !== expectedDotClass) {
      this.statusDotEl.className = expectedDotClass;
    }

    const statusLabel = next.status?.message || next.serviceError || t('sidebar.waiting_service');
    if (this.statusChipEl && this.statusChipEl.getAttribute('title') !== statusLabel) {
      this.statusChipEl.setAttribute('title', statusLabel);
    }
    if (this.statusTextEl && this.statusTextEl.textContent !== statusLabel) {
      this.statusTextEl.textContent = statusLabel;
    }
  }

  patchServiceAlert(status: StatusSnapshot | null, serviceError: string | null): void {
    if (!this.serviceAlertHostEl) return;
    const html =
      serviceError && !status
        ? `<div class="gb-banner danger">
            <div>
              <div class="gb-banner-title">${escapeHtml(t('win.common.service_offline'))}</div>
              <div class="gb-banner-sub">${escapeHtml(serviceError)}</div>
            </div>
            <button class="gb-btn sm" data-action="refresh-all">${escapeHtml(t('win.common.retry'))}</button>
          </div>`
        : '';
    if (html === this.lastAlertHtml) return;
    this.serviceAlertHostEl.innerHTML = html;
    this.lastAlertHtml = html;
  }

  patchToasts(toasts: readonly ToastItem[]): void {
    if (!this.toastHostEl) return;
    const html =
      toasts.length > 0
        ? toasts.map((item) => `<div class="gb-toast">${escapeHtml(item.text)}</div>`).join('')
        : '';
    if (html === this.lastToastsHtml) return;
    this.toastHostEl.innerHTML = html;
    this.toastHostEl.hidden = toasts.length === 0;
    this.lastToastsHtml = html;
  }

  private captureScroll(): ScrollSnapshot {
    return {
      mainTop: this.mainEl?.scrollTop ?? 0,
      mainLeft: this.mainEl?.scrollLeft ?? 0,
      docTop: this.doc.documentElement?.scrollTop ?? 0,
      bodyTop: this.doc.body?.scrollTop ?? 0,
      winX: typeof this.win?.scrollX === 'number' ? this.win.scrollX : 0,
      winY: typeof this.win?.scrollY === 'number' ? this.win.scrollY : 0,
    };
  }

  private restoreScroll(snap: ScrollSnapshot): void {
    if (this.mainEl) {
      this.mainEl.scrollTop = snap.mainTop;
      this.mainEl.scrollLeft = snap.mainLeft;
    }
    if (this.doc.documentElement) {
      this.doc.documentElement.scrollTop = snap.docTop;
    }
    if (this.doc.body) {
      this.doc.body.scrollTop = snap.bodyTop;
    }
    if (typeof this.win?.scrollTo === 'function' && (snap.winX !== 0 || snap.winY !== 0)) {
      this.win.scrollTo(snap.winX, snap.winY);
    }
  }

  private resetScrollToTop(): void {
    if (this.mainEl) {
      this.mainEl.scrollTop = 0;
      this.mainEl.scrollLeft = 0;
    }
    if (this.doc.documentElement) {
      this.doc.documentElement.scrollTop = 0;
    }
    if (this.doc.body) {
      this.doc.body.scrollTop = 0;
    }
    if (typeof this.win?.scrollTo === 'function') {
      this.win.scrollTo(0, 0);
    }
  }

  private captureSearchFocus(): SearchInputSnapshot | null {
    if (!this.viewHostEl) return null;
    const active = this.doc.activeElement as HTMLInputElement | null;
    if (!active) return null;
    const isSearch =
      typeof active.matches === 'function'
        ? active.matches('[data-events-search]')
        : Boolean(active.dataset && 'eventsSearch' in active.dataset);
    if (!isSearch) return null;
    if (typeof this.viewHostEl.contains === 'function' && !this.viewHostEl.contains(active)) {
      return null;
    }
    return {
      selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
      selectionDirection: active.selectionDirection ?? null,
    };
  }

  private restoreSearchFocus(snapshot: SearchInputSnapshot | null, scrollSnap: ScrollSnapshot): void {
    if (!snapshot || !this.viewHostEl) return;
    const nextInput = this.viewHostEl.querySelector<HTMLInputElement>('[data-events-search]');
    if (!nextInput) return;
    if (typeof nextInput.focus === 'function') {
      try {
        nextInput.focus({ preventScroll: true });
      } catch {
        nextInput.focus();
      }
    }
    if (
      typeof nextInput.setSelectionRange === 'function' &&
      snapshot.selectionStart !== null &&
      snapshot.selectionEnd !== null
    ) {
      try {
        nextInput.setSelectionRange(
          snapshot.selectionStart,
          snapshot.selectionEnd,
          snapshot.selectionDirection ?? undefined
        );
      } catch {}
    }
    // Re-apply scroll coordinates in case a runtime ignores focus({ preventScroll: true }).
    this.restoreScroll(scrollSnap);
  }

  patchMainView(options: { html: string; resetScroll?: boolean }): boolean {
    if (!this.viewHostEl) return false;
    const resetScroll = options.resetScroll === true;
    if (!resetScroll && options.html === this.lastViewHtml) {
      return false;
    }

    if (resetScroll) {
      this.viewHostEl.innerHTML = options.html;
      this.lastViewHtml = options.html;
      this.resetScrollToTop();
      return true;
    }

    const scrollSnap = this.captureScroll();
    const searchSnap = this.captureSearchFocus();

    this.viewHostEl.innerHTML = options.html;
    this.lastViewHtml = options.html;

    this.restoreScroll(scrollSnap);
    this.restoreSearchFocus(searchSnap, scrollSnap);
    return true;
  }

  getMainElement(): HTMLElement | null {
    return this.mainEl;
  }

  getViewHostElement(): HTMLElement | null {
    return this.viewHostEl;
  }
}

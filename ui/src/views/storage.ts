import type { MaintenanceScanResponse } from '../api/types';
import { t } from '../i18n/l10n';
import { escapeHtml, formatBytes } from '../utils/format';

export function renderStorageView(state: {
  scan: MaintenanceScanResponse | null;
  retentionDays: number;
  loading?: boolean;
  busyAction: string | null;
}): string {
  const { scan, retentionDays, loading = false, busyAction } = state;
  const isScanning = busyAction === 'storage' || loading;
  const safeBytes = scan?.safeBytes ?? 0;
  const statefulBytes = scan?.statefulBytes ?? 0;
  const protectedBytes = scan?.protectedBytes ?? 0;
  const totalAll = Math.max(1, safeBytes + statefulBytes + protectedBytes);

  const safePct = Math.round((safeBytes / totalAll) * 100);
  const histPct = Math.round((statefulBytes / totalAll) * 100);
  const protPct = Math.max(0, 100 - safePct - histPct);

  const entries = (scan?.entries ?? []).filter((e) => e.exists || e.bytes > 0);
  const protectedList = scan?.protectedEntries ?? [];

  const loadingCardHtml = !scan && isScanning
    ? `
      <div class="gb-card gb-loading-card" role="status" aria-live="polite">
        <div class="gb-loading-row">
          <span class="gb-spinner" aria-hidden="true"></span>
          <div>
            <div class="gb-card-title">${escapeHtml(t('win.storage.scanning_title'))}</div>
            <div class="gb-muted-text" style="margin-top:2px">${escapeHtml(t('win.storage.scanning_sub'))}</div>
          </div>
        </div>
      </div>
    `
    : '';

  return `
    <div class="gb-view-header">
      <div>
        <h1 class="gb-view-title">${escapeHtml(t('win.storage.title'))}</h1>
      </div>
      <div class="gb-header-actions">
        <select class="gb-select" data-storage-retention aria-label="${escapeHtml(t('win.storage.retention_label'))}" ${isScanning ? 'disabled' : ''}>
          <option value="7" ${retentionDays === 7 ? 'selected' : ''}>${escapeHtml(t('maintenance.simple.retention_7d'))}</option>
          <option value="30" ${retentionDays === 30 ? 'selected' : ''}>${escapeHtml(t('maintenance.simple.retention_30d'))}</option>
          <option value="0" ${retentionDays === 0 ? 'selected' : ''}>${escapeHtml(t('maintenance.simple.retention_0d'))}</option>
        </select>
        <button class="gb-btn primary" data-action="scan-storage" ${isScanning ? 'disabled' : ''}>
          ${escapeHtml(isScanning ? t('win.storage.scanning_btn') : t('win.storage.scan_btn'))}
        </button>
      </div>
    </div>

    ${loadingCardHtml || `
    <div class="gb-card">
      <div class="gb-card-header">
        <div>
          <div class="gb-muted-text">${escapeHtml(t('win.storage.reclaimable_preview'))}</div>
          <div class="gb-stat-hero gb-num">
            ${escapeHtml(scan ? formatBytes(scan.totalBytes) : '--')}
          </div>
          <div class="gb-muted-text">
            ${escapeHtml(t('maintenance.popover.protected.footer'))}
          </div>
        </div>
        <div class="gb-header-actions">
          ${isScanning ? `<span class="gb-badge"><span class="gb-spinner sm" aria-hidden="true"></span>${escapeHtml(t('win.storage.scanning_btn'))}</span>` : ''}
          ${scan?.running ? `<span class="gb-badge warn">${escapeHtml(t('win.storage.running_warn'))}</span>` : ''}
        </div>
      </div>

      <div class="gb-stack-bar">
        <div class="gb-stack-seg runtime" style="width:${safePct}%"></div>
        <div class="gb-stack-seg history" style="width:${histPct}%"></div>
        <div class="gb-stack-seg protected" style="width:${protPct}%"></div>
      </div>

      <div class="gb-storage-legend">
        <span class="gb-num"><span class="gb-dot" style="display:inline-block;background:var(--accent);margin-right:6px"></span>${escapeHtml(t('maintenance.simple.legend_runtime', { size: formatBytes(safeBytes) }))}</span>
        <span class="gb-num"><span class="gb-dot" style="display:inline-block;background:var(--warn);margin-right:6px"></span>${escapeHtml(t('maintenance.simple.legend_history', { size: formatBytes(statefulBytes) }))}</span>
        <span class="gb-num"><span class="gb-dot" style="display:inline-block;margin-right:6px"></span>${escapeHtml(t('maintenance.simple.legend_protected', { size: formatBytes(protectedBytes) }))}</span>
      </div>
    </div>

    <div class="gb-card gb-list-card">
      <div class="gb-row">
        <div class="gb-row-title">${escapeHtml(t('win.storage.categories_title'))}</div>
        <span class="gb-badge neutral">${entries.length}</span>
      </div>
      ${
        entries.length > 0
          ? entries
              .map(
                (entry) => `
                  <div class="gb-row">
                    <div class="gb-row-main">
                      <div class="gb-row-title">
                        <span>${escapeHtml(entry.title)}</span>
                        <span class="gb-badge ${entry.category === 'safe' ? 'ok' : 'warn'}">${escapeHtml(entry.category)}</span>
                      </div>
                      <div class="gb-row-sub">${escapeHtml(entry.subtitle)}</div>
                    </div>
                    <div class="gb-row-right">
                      <span class="gb-muted-text gb-num">${escapeHtml(t('maintenance.popover.files_count', { count: entry.fileCount }))}</span>
                      <strong class="gb-num" style="min-width:72px;text-align:right">${escapeHtml(formatBytes(entry.bytes))}</strong>
                    </div>
                  </div>
                `
              )
              .join('')
          : `<div class="gb-empty-box">${escapeHtml(scan ? t('maintenance.popover.runtime.empty') : t('win.common.empty'))}</div>`
      }
    </div>

    <div class="gb-card gb-list-card">
      <div class="gb-row">
        <div class="gb-row-title">${escapeHtml(t('win.storage.protected_title'))}</div>
        <span class="gb-badge ok">${escapeHtml(t('maintenance.popover.protected.badge'))}</span>
      </div>
      ${
        protectedList.length > 0
          ? protectedList
              .map(
                (item) => `
                  <div class="gb-row">
                    <div class="gb-row-main">
                      <div class="gb-row-title">${escapeHtml(item.title)}</div>
                      <div class="gb-row-sub">${escapeHtml(item.subtitle)}</div>
                    </div>
                    <div class="gb-row-right">
                      <strong class="gb-num">${escapeHtml(formatBytes(item.bytes))}</strong>
                    </div>
                  </div>
                `
              )
              .join('')
          : `<div class="gb-empty-box">${escapeHtml(t('win.common.empty'))}</div>`
      }
    </div>
    `}
  `;
}

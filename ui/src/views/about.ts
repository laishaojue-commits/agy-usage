import type { RuntimeInfo, StatusSnapshot } from '../api/types';
import { t } from '../i18n/l10n';
import { getUiCapabilities, type UiCapabilities } from '../ui/capabilities';
import { appLogoUrl, escapeHtml } from '../utils/format';

export function renderAboutView(state: {
  status: StatusSnapshot | null;
  runtimeInfo: RuntimeInfo | null;
  pingLatencyMs: number | null;
  capabilities?: UiCapabilities;
}): string {
  const { status, runtimeInfo, pingLatencyMs } = state;
  const capabilities = state.capabilities ?? getUiCapabilities('mcp-app');
  const version = runtimeInfo?.appVersion || '0.0.0';
  const pipeOk = Boolean(status);
  const readOnly = status?.readOnlyMode ?? runtimeInfo?.readOnlyMode ?? true;
  const brandTitle = capabilities.brandTitle;

  const nodeMemorySub = `${escapeHtml(runtimeInfo?.nodeVersion || 'Node.js')} · PID ${escapeHtml(status?.pid ?? runtimeInfo?.backendPid ?? '--')}${typeof status?.rssMB === 'number' && Number.isFinite(status.rssMB) ? ` · ${escapeHtml(status.rssMB)} MB RSS` : ''}`;

  const diagnosticsRowsHtml = `
    <div class="gb-row">
      <div class="gb-row-main">
        <div class="gb-row-title">${escapeHtml(t('win.about.mode_label'))}</div>
        <div class="gb-row-sub">${escapeHtml(t('win.about.mode_mcp_sub'))}</div>
      </div>
      <div class="gb-row-right">
        <span class="gb-badge ${pipeOk ? 'ok' : 'neutral'}">
          ${escapeHtml(`MCP App${pingLatencyMs !== null ? ` · ${pingLatencyMs}ms` : ''}`)}
        </span>
      </div>
    </div>

    <div class="gb-row">
      <div class="gb-row-main">
        <div class="gb-row-title">${escapeHtml(t('win.about.node_memory_label'))}</div>
        <div class="gb-row-sub gb-mono">${nodeMemorySub}</div>
      </div>
      <div class="gb-row-right">
        <span class="gb-badge ${status?.pid ? 'ok' : 'neutral'}">${escapeHtml(status?.pid ? t('win.common.enabled') : '--')}</span>
      </div>
    </div>

    <div class="gb-row">
      <div class="gb-row-main">
        <div class="gb-row-title">${escapeHtml(t('win.about.gate_label'))}</div>
        <div class="gb-row-sub">${escapeHtml(readOnly ? t('win.about.gate_mcp_enforced') : t('win.about.gate_disabled'))}</div>
      </div>
      <div class="gb-row-right">
        <span class="gb-badge ${readOnly ? 'ok' : 'warn'}">${escapeHtml(readOnly ? 'READ_ONLY=1' : 'READ_ONLY=0')}</span>
      </div>
    </div>
  `;

  return `
    <div class="gb-view-header">
      <div>
        <h1 class="gb-view-title">${escapeHtml(t('win.about.title'))}</h1>
        <p class="gb-view-sub">${escapeHtml(t('win.about.mcp_subtitle'))}</p>
      </div>
      <div class="gb-header-actions">
        <button class="gb-btn" data-action="copy-diagnostics">
          ${escapeHtml(t('win.about.copy_diag'))}
        </button>
      </div>
    </div>

    <div class="gb-card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:12px">
          <img src="${escapeHtml(appLogoUrl)}" width="44" height="44" alt="${escapeHtml(brandTitle)}" style="border-radius:10px" />
          <div>
            <div style="display:flex;align-items:center;gap:8px">
              <strong style="font-size:18px">${escapeHtml(brandTitle)}</strong>
              <span class="gb-badge">v${escapeHtml(version)}</span>
              <span class="gb-badge neutral">${escapeHtml(t('win.about.mcp_badge'))}</span>
            </div>
            <div class="gb-muted-text" style="margin-top:2px">${escapeHtml(t('win.brand_sub_mcp'))}</div>
          </div>
        </div>
        <span class="gb-badge ok">MIT License</span>
      </div>
    </div>

    <div class="gb-view-sub" style="font-weight:600;color:var(--text-secondary)">${escapeHtml(t('win.about.diag_title'))}</div>
    <div class="gb-card gb-list-card">
      ${diagnosticsRowsHtml}
    </div>

    <div class="gb-card">
      <div class="gb-card-title" style="margin-bottom:6px">${escapeHtml(t('win.about.license_title'))}</div>
      <div class="gb-row-sub">${escapeHtml(t('win.about.license_body'))}</div>
    </div>
  `;
}

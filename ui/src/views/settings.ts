import type { RuntimeInfo, StatusSnapshot } from '../api/types';
import { getConfiguredLanguage, t } from '../i18n/l10n';
import type { UiCapabilities } from '../ui/capabilities';
import { escapeHtml } from '../utils/format';

export type ThemePreference = 'system' | 'light' | 'dark';

export function renderSettingsView(state: {
  status: StatusSnapshot | null;
  runtimeInfo: RuntimeInfo | null;
  theme: ThemePreference;
  capabilities?: UiCapabilities;
}): string {
  const { status, runtimeInfo, theme } = state;
  const langValue = status?.configuredLanguage || getConfiguredLanguage();
  const readOnly = status?.readOnlyMode ?? runtimeInfo?.readOnlyMode ?? true;
  const readonlyDesc = readOnly
    ? t('win.settings.readonly_mcp_on')
    : t('win.settings.readonly_off');

  return `
    <div class="gb-view-header">
      <div>
        <h1 class="gb-view-title">${escapeHtml(t('settings.title'))}</h1>
      </div>
    </div>

    <div class="gb-view-sub" style="font-weight:600;color:var(--text-secondary)">${escapeHtml(t('win.settings.general_title'))}</div>
    <div class="gb-card gb-list-card">
      <div class="gb-row">
        <div class="gb-row-main">
          <div class="gb-row-title">${escapeHtml(t('settings.language.title'))}</div>
          <div class="gb-row-sub">${escapeHtml(t('win.settings.language_local_sub'))}</div>
        </div>
        <div class="gb-row-right">
          <select class="gb-select" data-setting-language aria-label="${escapeHtml(t('settings.language.title'))}">
            <option value="system" ${langValue === 'system' ? 'selected' : ''}>${escapeHtml(t('app.language.system', undefined, t('language.system')))}</option>
            <option value="zh-Hans" ${langValue === 'zh-Hans' ? 'selected' : ''}>简体中文</option>
            <option value="en" ${langValue === 'en' ? 'selected' : ''}>English</option>
          </select>
        </div>
      </div>

      <div class="gb-row">
        <div class="gb-row-main">
          <div class="gb-row-title">${escapeHtml(t('win.settings.theme_title'))}</div>
          <div class="gb-row-sub">${escapeHtml(t('win.settings.theme_sub'))}</div>
        </div>
        <div class="gb-row-right">
          <select class="gb-select" data-setting-theme aria-label="${escapeHtml(t('win.settings.theme_title'))}">
            <option value="system" ${theme === 'system' ? 'selected' : ''}>${escapeHtml(t('win.settings.theme_system'))}</option>
            <option value="light" ${theme === 'light' ? 'selected' : ''}>${escapeHtml(t('win.settings.theme_light'))}</option>
            <option value="dark" ${theme === 'dark' ? 'selected' : ''}>${escapeHtml(t('win.settings.theme_dark'))}</option>
          </select>
        </div>
      </div>
    </div>

    <div class="gb-view-sub" style="font-weight:600;color:var(--text-secondary)">${escapeHtml(t('win.settings.security_title'))}</div>
    <div class="gb-card gb-list-card">
      <div class="gb-row">
        <div class="gb-row-main">
          <div class="gb-row-title">${escapeHtml(t('win.settings.readonly_label'))}</div>
          <div class="gb-row-sub">${escapeHtml(readonlyDesc)}</div>
        </div>
        <div class="gb-row-right">
          <span class="gb-badge ${readOnly ? 'ok' : 'warn'}">${escapeHtml(readOnly ? 'READ_ONLY' : 'WRITABLE')}</span>
        </div>
      </div>
      <div class="gb-row">
        <div class="gb-row-main">
          <div class="gb-row-title">${escapeHtml(t('win.settings.plugin_data_dir'))}</div>
          <div class="gb-row-sub gb-mono">${escapeHtml(runtimeInfo?.stateDir || '--')}</div>
        </div>
      </div>
    </div>
  `;
}

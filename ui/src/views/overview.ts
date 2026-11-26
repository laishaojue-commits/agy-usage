import type {
  ConversationContextSnapshot,
  DashboardSummaryResponse,
  StatusSnapshot,
} from '../api/types';
import { assignModelColors, collectOrderedChartModels } from '../charts/palette';
import { buildStackedHourlyBars, renderStackedTrendChartSvg } from '../charts/stacked-bar';
import { renderContextWindowCard } from '../components/context-card';
import { t } from '../i18n/l10n';
import type { UiCapabilities } from '../ui/capabilities';
import {
  escapeHtml,
  formatCompactNumber,
  formatInt,
  formatUsd,
  renderModelIcon,
} from '../utils/format';

export function renderOverviewView(state: {
  status: StatusSnapshot | null;
  dashboard: DashboardSummaryResponse | null;
  contextSnapshot?: ConversationContextSnapshot | null;
  loading: boolean;
  busyAction: string | null;
  capabilities?: UiCapabilities;
}): string {
  const { dashboard, busyAction } = state;
  const usage = dashboard?.usage ?? null;

  const todayModels = usage?.todayByModel ?? [];
  const colorMap = assignModelColors(collectOrderedChartModels(todayModels, usage?.todayHourly));
  const hourlyBars = buildStackedHourlyBars(usage?.todayHourly, 'tokens', colorMap);
  const trendChart = renderStackedTrendChartSvg(hourlyBars, { width: 520, height: 158, dim: 'tokens', colorMap });
  const defaultChartTip = trendChart.peakSummaryText || t('overview.trend.24h_badge');
  const topModels = todayModels.slice(0, 3);
  const totalTodayTokens = usage?.todayTokens ?? 0;

  const contextCardHtml = renderContextWindowCard(state.contextSnapshot ?? null, {
    compact: true,
    loading: state.loading && !state.contextSnapshot,
  });

  return `
    <div class="gb-view-header">
      <div>
        <h1 class="gb-view-title">${escapeHtml(t('overview.title'))}</h1>
      </div>
      <div class="gb-header-actions">
        <button class="gb-btn" data-action="refresh-all" ${busyAction === 'refresh' ? 'disabled' : ''}>
          ${escapeHtml(t('common.refresh'))}
        </button>
      </div>
    </div>

    ${contextCardHtml}

    <div class="gb-grid-3">
      <div class="gb-card">
        <div class="gb-metric-label">${escapeHtml(t('overview.metric.today_tokens'))}</div>
        <div class="gb-metric-value">${escapeHtml(usage ? formatCompactNumber(usage.todayTokens) : '--')}</div>
        <div class="gb-metric-sub">
          ${escapeHtml(usage ? t('win.overview.total_tokens_short', { tokens: formatCompactNumber(usage.totalTokens) }) : t('overview.metric.total_tokens_placeholder'))}
        </div>
      </div>
      <div class="gb-card">
        <div class="gb-metric-label">
          <span>${escapeHtml(t('overview.metric.today_cost'))}</span>
          ${usage && usage.todayUnpricedModels > 0 ? `<span class="gb-badge warn">${escapeHtml(t('overview.cost.partial_badge'))}</span>` : ''}
        </div>
        <div class="gb-metric-value">${escapeHtml(usage ? formatUsd(usage.estimatedUsd) : '--')}</div>
        <div class="gb-metric-sub">
          ${escapeHtml(usage ? t('overview.metric.total_cost', { cost: formatUsd(usage.allTimeEstimatedUsd) }) : t('overview.metric.total_cost_placeholder'))}
        </div>
      </div>
      <div class="gb-card">
        <div class="gb-metric-label">${escapeHtml(t('overview.metric.today_requests'))}</div>
        <div class="gb-metric-value">${escapeHtml(usage ? formatInt(usage.requestCount) : '--')}</div>
        <div class="gb-metric-sub">
          ${escapeHtml(usage ? t('win.overview.total_requests_short', { count: formatInt(usage.totalRequestCount) }) : t('overview.metric.total_requests_placeholder'))}
        </div>
      </div>
    </div>

    <div class="gb-grid-split">
      <div class="gb-card gb-chart-box">
        <div class="gb-card-header">
          <span class="gb-card-title">${escapeHtml(t('overview.trend.title'))}</span>
          <span class="gb-badge">
            ${escapeHtml(
              trendChart.peakValueText
                ? t('overview.trend.peak_badge', { label: trendChart.peakLabel, peak: trendChart.peakValueText })
                : t('overview.trend.24h_badge')
            )}
          </span>
        </div>
        <div class="gb-chart-tip" data-chart-tip data-default-tip="${escapeHtml(defaultChartTip)}">${escapeHtml(defaultChartTip)}</div>
        ${trendChart.svg}
        ${trendChart.legendHtml}
      </div>

      <div class="gb-card">
        <div class="gb-card-header">
          <span class="gb-card-title">${escapeHtml(t('overview.bento.active_models'))}</span>
          <button class="gb-btn sm ghost" data-nav="usage">${escapeHtml(t('win.overview.view_details'))} →</button>
        </div>
        ${
          topModels.length > 0
            ? `<div style="display:flex;flex-direction:column;gap:12px">
                ${topModels
                  .map((m) => {
                    const share = totalTodayTokens > 0 ? Math.round((m.totalTokens / totalTodayTokens) * 100) : 0;
                    return `
                      <div class="gb-quota-row">
                        <div class="gb-quota-top">
                          <span class="gb-quota-label">${renderModelIcon(m.model, 16)}<span>${escapeHtml(m.model)}</span></span>
                          <span class="gb-num" style="font-weight:600">${escapeHtml(formatCompactNumber(m.totalTokens))}</span>
                        </div>
                        <div class="gb-track"><div class="gb-fill ok" style="width:${Math.max(4, share)}%"></div></div>
                        <div class="gb-muted-text">${escapeHtml(formatInt(m.requestCount))} · ${share}% · ${escapeHtml(m.priced ? formatUsd(m.estimatedUsd) : t('overview.model.unpriced_badge'))}</div>
                      </div>
                    `;
                  })
                  .join('')}
              </div>`
            : `<div class="gb-empty-box">${escapeHtml(dashboard?.usageError || t('overview.bento.empty_title'))}</div>`
        }
      </div>
    </div>
  `;
}

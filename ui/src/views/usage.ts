import type {
  PricingSyncStatus,
  UsageEventsResponse,
  UsagePeriodKey,
  UsagePeriodResponse,
} from '../api/types';
import { renderCostDonutSvg } from '../charts/cost-donut';
import { assignModelColors, collectOrderedChartModels } from '../charts/palette';
import {
  buildStackedDailyBars,
  buildStackedHourlyBars,
  renderStackedTrendChartSvg,
} from '../charts/stacked-bar';
import { t } from '../i18n/l10n';
import {
  escapeHtml,
  formatCompactNumber,
  formatInt,
  formatTimestamp,
  formatUsd,
  renderModelIcon,
} from '../utils/format';

export function renderUsageView(state: {
  period: UsagePeriodKey;
  accountId: string;
  dim: 'tokens' | 'requests';
  usage: UsagePeriodResponse | null;
  events: UsageEventsResponse | null;
  eventsQuery: string;
  eventsOffset: number;
  pricingStatus: PricingSyncStatus | null;
  busyAction: string | null;
}): string {
  const {
    period,
    accountId,
    dim,
    usage,
    events,
    eventsQuery,
    eventsOffset,
    pricingStatus,
    busyAction,
  } = state;

  const summary = usage?.summary;
  const byModel = usage?.byModel ?? [];
  const totalTokens = summary?.totalTokens ?? 0;
  const cachedTokens = summary?.cachedTokens ?? 0;
  const cacheHit = typeof summary?.cacheHitRate === 'number' && Number.isFinite(summary.cacheHitRate)
    ? Math.min(100, Math.max(0, summary.cacheHitRate)) : 0;
  const estUsd = summary?.estimatedUsd ?? 0;
  // Rough cache savings estimate when cache hit > 0 and cost > 0 (cached input typically ~10% of standard input)
  const roughSavingsUsd =
    estUsd > 0 && cacheHit > 0 && totalTokens > 0
      ? Math.max(0, estUsd * (cachedTokens / Math.max(1, totalTokens)) * 0.75)
      : 0;

  const rawTrendBuckets = period === 'today' ? usage?.todayHourly : usage?.dailyTrends;
  const colorMap = assignModelColors(collectOrderedChartModels(byModel, rawTrendBuckets));
  const points =
    period === 'today'
      ? buildStackedHourlyBars(usage?.todayHourly, dim, colorMap)
      : buildStackedDailyBars(usage?.dailyTrends, dim, colorMap);
  const trend = renderStackedTrendChartSvg(points, { width: 720, height: 184, dim, colorMap });

  const periodTitle = t(`usage.trend_title.${period}`);
  const defaultChartTip = trend.peakSummaryText || periodTitle;
  const accountsList = usage?.availableAccounts ?? [];

  const rows = events?.rows ?? [];
  const totalRows = events?.total ?? 0;
  const limit = events?.limit ?? 20;
  const currentPage = Math.floor(eventsOffset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(totalRows / limit));

  return `
    <div class="gb-view-header">
      <div>
        <h1 class="gb-view-title">${escapeHtml(t('usage.title'))}</h1>
        <p class="gb-view-sub">${escapeHtml(summary?.scanScopeDescription || '')}</p>
      </div>
      <div class="gb-header-actions">
        ${
          accountsList.length > 1
            ? `<select class="gb-select" data-usage-account aria-label="${escapeHtml(t('win.usage.account_filter'))}">
                ${accountsList
                  .map(
                    (a) =>
                      `<option value="${escapeHtml(a.id)}" ${a.id === accountId ? 'selected' : ''}>${escapeHtml(a.label)}</option>`
                  )
                  .join('')}
              </select>`
            : ''
        }
        <div class="gb-segmented" role="tablist" aria-label="${escapeHtml(t('usage.period_a11y'))}">
          ${(['today', '7d', '30d', 'all'] as const)
            .map(
              (p) =>
                `<button class="gb-seg-btn ${p === period ? 'active' : ''}" data-usage-period="${p}">${escapeHtml(
                  t(`usage.period.${p}`)
                )}</button>`
            )
            .join('')}
        </div>
        <button class="gb-btn" data-action="refresh-usage" ${busyAction === 'usage' ? 'disabled' : ''}>
          ${escapeHtml(t('common.refresh'))}
        </button>
      </div>
    </div>

    <div class="gb-card gb-chart-box">
      <div class="gb-card-header">
        <div>
          <div class="gb-muted-text">${escapeHtml(t('usage.section.token_usage'))}</div>
          <div style="font-size:26px;font-weight:700;letter-spacing:-0.02em" class="gb-num">
            ${escapeHtml(summary ? formatCompactNumber(totalTokens) : '--')}
          </div>
          <div class="gb-muted-text gb-num">
            ${escapeHtml(
              summary
                ? t('usage.tokens.summary', {
                    input: formatCompactNumber(summary.promptTokens),
                    cached: formatCompactNumber(summary.cachedTokens),
                    cacheWrite:
                      summary.cacheWriteTokens > 0
                        ? t('usage.tokens.cache_write_part', { count: formatCompactNumber(summary.cacheWriteTokens) })
                        : '',
                    output: formatCompactNumber(summary.candidatesTokens),
                  })
                : t('usage.tokens.placeholder')
            )}
          </div>
        </div>
        <div class="gb-header-actions">
          <div class="gb-segmented">
            <button class="gb-seg-btn ${dim === 'tokens' ? 'active' : ''}" data-usage-dim="tokens">${escapeHtml(
              t('win.usage.dim_tokens')
            )}</button>
            <button class="gb-seg-btn ${dim === 'requests' ? 'active' : ''}" data-usage-dim="requests">${escapeHtml(
              t('win.usage.dim_requests')
            )}</button>
          </div>
          <span class="gb-badge neutral">${escapeHtml(periodTitle)}</span>
        </div>
      </div>
      <div class="gb-chart-tip" data-chart-tip data-default-tip="${escapeHtml(defaultChartTip)}">
        ${escapeHtml(defaultChartTip)}
      </div>
      ${trend.svg}
      ${trend.legendHtml}
    </div>

    <div class="gb-grid-2">
      <div class="gb-card">
        <div class="gb-card-header">
          <span class="gb-card-title">${escapeHtml(t('usage.section.cost'))}</span>
          <span class="gb-num" style="font-size:20px;font-weight:700">${escapeHtml(summary ? formatUsd(estUsd) : '--')}</span>
        </div>
        ${renderCostDonutSvg(byModel, estUsd, colorMap)}
        ${
          summary && summary.unpricedModels > 0
            ? `<div class="gb-row-sub" style="margin-top:10px;color:var(--warn)">${escapeHtml(
                t('usage.cost.unpriced_models_note', { count: summary.unpricedModels })
              )}</div>`
            : ''
        }
      </div>

      <div class="gb-card" style="display:flex;flex-direction:column;justify-content:space-between;gap:14px">
        <div class="gb-card-header" style="margin-bottom:0">
          <span class="gb-card-title">${escapeHtml(t('usage.section.requests_cache'))}</span>
          ${summary?.availability === 'partial' ? `<span class="gb-badge warn">${escapeHtml(t('menu_panel.cost.partial_badge'))}</span>` : ''}
        </div>
        <div style="display:flex;align-items:baseline;justify-content:space-between">
          <div>
            <div style="font-weight:600">${escapeHtml(t('usage.section.total_requests'))}</div>
            <div class="gb-muted-text">
              ${escapeHtml(
                summary && summary.requestCount > 0
                  ? t('usage.requests.avg_per_call', {
                      count: formatCompactNumber(Math.round(summary.totalTokens / summary.requestCount)),
                    })
                  : t('usage.requests.none')
              )}
            </div>
          </div>
          <div style="font-size:22px;font-weight:700" class="gb-num">
            ${escapeHtml(summary ? t('usage.requests.value', { count: formatInt(summary.requestCount) }) : '--')}
          </div>
        </div>
        <div>
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px">
            <div>
              <div style="font-weight:600">${escapeHtml(t('usage.section.cache_hit_rate'))}</div>
              <div class="gb-muted-text">
                ${escapeHtml(t('usage.cache.read_detail', { count: formatCompactNumber(cachedTokens) }))}
                ${roughSavingsUsd > 0 ? ` · ${escapeHtml(t('win.usage.cache_saved', { saved: formatUsd(roughSavingsUsd) }))}` : ''}
              </div>
            </div>
            <div style="font-size:22px;font-weight:700" class="gb-num">${summary ? escapeHtml(cacheHit + '%') : '--'}</div>
          </div>
          <div class="gb-track"><div class="gb-fill ok" style="width:${Math.min(100, Math.max(0, cacheHit))}%"></div></div>
        </div>
      </div>
    </div>

    <div class="gb-card">
      <div class="gb-card-header">
        <div>
          <span class="gb-card-title">${escapeHtml(t('win.usage.log_title'))}</span>
          <div class="gb-row-sub">${escapeHtml(t('usage_log.status.total', { total: formatInt(totalRows) }))}</div>
        </div>
        <div class="gb-header-actions">
          <input
            type="search"
            class="gb-input"
            data-events-search
            value="${escapeHtml(eventsQuery)}"
            placeholder="${escapeHtml(t('win.usage.log_search'))}"
          />
        </div>
      </div>
      ${
        rows.length > 0
          ? `
            <div class="gb-table-wrap">
              <table class="gb-table">
                <thead>
                  <tr>
                    <th>${escapeHtml(t('win.usage.log_col_time'))}</th>
                    <th>${escapeHtml(t('win.usage.log_col_model'))}</th>
                    <th>${escapeHtml(t('win.usage.log_col_tokens'))}</th>
                    <th>${escapeHtml(t('win.usage.log_col_total'))}</th>
                    <th>${escapeHtml(t('win.usage.log_col_cost'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows
                    .map(
                      (r) => `
                        <tr>
                          <td class="gb-muted-text">${escapeHtml(formatTimestamp(r.timestamp_seconds))}</td>
                          <td>
                            <div style="display:flex;align-items:center;gap:6px">
                              ${renderModelIcon(r.model, 15)}
                              <span>${escapeHtml(r.model)}</span>
                            </div>
                          </td>
                          <td class="gb-muted-text">
                            ${escapeHtml(formatCompactNumber(r.input_tokens))} / ${escapeHtml(formatCompactNumber(r.cached_tokens))} / ${escapeHtml(formatCompactNumber(r.output_tokens))}
                          </td>
                          <td>${escapeHtml(formatCompactNumber(r.total_tokens))}</td>
                          <td>${escapeHtml(r.priced && r.estimated_usd !== null ? formatUsd(r.estimated_usd) : t('overview.model.unpriced_badge'))}</td>
                        </tr>
                      `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px">
              <span class="gb-muted-text">${currentPage} / ${totalPages}</span>
              <div class="gb-header-actions">
                <button class="gb-btn sm" data-events-page="prev" ${eventsOffset <= 0 ? 'disabled' : ''}>
                  ${escapeHtml(t('win.usage.log_prev'))}
                </button>
                <button class="gb-btn sm" data-events-page="next" ${eventsOffset + limit >= totalRows ? 'disabled' : ''}>
                  ${escapeHtml(t('win.usage.log_next'))}
                </button>
              </div>
            </div>
          `
          : `<div class="gb-empty-box">${escapeHtml(t('usage_log.empty.none'))}</div>`
      }
    </div>

    <div class="gb-card gb-list-card">
      <div class="gb-row">
        <div class="gb-row-main">
          <div class="gb-row-title">${escapeHtml(t('win.usage.pricing_title'))}</div>
          <div class="gb-row-sub">
            ${escapeHtml(
              t('win.usage.pricing_meta', {
                version: pricingStatus?.feedVersion || '--',
                count: pricingStatus?.modelCount ?? '--',
              })
            )}
          </div>
        </div>
        <div class="gb-row-right">
          <span class="gb-badge ok">${escapeHtml(t('win.usage.pricing_never'))}</span>
        </div>
      </div>
    </div>
  `;
}

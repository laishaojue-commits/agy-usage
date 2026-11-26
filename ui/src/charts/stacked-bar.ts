import type { DailyUsagePoint, HourlyUsagePoint, TrendModelBreakdown } from '../api/types';
import { t } from '../i18n/l10n';
import { escapeHtml, formatCompactNumber, formatInt } from '../utils/format';
import { MODEL_CHART_PALETTE, type TrendBucketWithBreakdown } from './palette';

export interface StackedBarSegment {
  model: string;
  value: number;
  tokens: number;
  requests: number;
  color: string;
  isFallback?: boolean;
}

export interface StackedTrendBarPoint {
  label: string;
  axisLabel: string;
  value: number;
  tokens: number;
  requests: number;
  future?: boolean;
  segments: StackedBarSegment[];
}

export interface StackedTrendRenderResult {
  svg: string;
  legendHtml: string;
  peakLabel: string;
  peakValueText: string;
  peakSummaryText: string;
  models: string[];
}

function buildEffectiveColorMap(
  buckets: readonly TrendBucketWithBreakdown[],
  dim: 'tokens' | 'requests',
  colorMap?: ReadonlyMap<string, string>
): Map<string, string> {
  const resolved = new Map<string, string>(colorMap ?? []);
  const totals = new Map<string, number>();

  for (const bucket of buckets) {
    for (const item of bucket.by_model ?? []) {
      const name = item.model?.trim();
      if (!name || resolved.has(name)) continue;
      const val = dim === 'requests' ? item.request_count : item.total_tokens;
      totals.set(name, (totals.get(name) ?? 0) + val);
    }
  }

  const missing = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  for (const name of missing) {
    resolved.set(name, MODEL_CHART_PALETTE[resolved.size % MODEL_CHART_PALETTE.length]!);
  }
  return resolved;
}

function buildSegmentsForBucket(
  breakdown: readonly TrendModelBreakdown[] | undefined,
  totalValue: number,
  totalTokens: number,
  totalRequests: number,
  dim: 'tokens' | 'requests',
  resolvedColors: ReadonlyMap<string, string>,
  colorOrder: ReadonlyMap<string, number>
): StackedBarSegment[] {
  if (totalValue <= 0) return [];

  const nonZero = (breakdown ?? [])
    .map((item) => {
      const model = item.model?.trim() ?? '';
      const val = dim === 'requests' ? item.request_count : item.total_tokens;
      return {
        model,
        value: val,
        tokens: item.total_tokens,
        requests: item.request_count,
      };
    })
    .filter((item) => item.model && item.value > 0);

  if (nonZero.length === 0) {
    return [
      {
        model: '',
        value: totalValue,
        tokens: totalTokens,
        requests: totalRequests,
        color: 'var(--accent)',
        isFallback: true,
      },
    ];
  }

  // Keep segments stacked in stable colorOrder bottom-to-top so model bands align across bars.
  nonZero.sort((a, b) => {
    const oa = colorOrder.get(a.model) ?? Number.MAX_SAFE_INTEGER;
    const ob = colorOrder.get(b.model) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return b.value - a.value || a.model.localeCompare(b.model);
  });

  return nonZero.map((seg) => ({
    ...seg,
    color: resolvedColors.get(seg.model) ?? MODEL_CHART_PALETTE[0],
  }));
}

function createOrderMap(colorMap: ReadonlyMap<string, string>): Map<string, number> {
  const order = new Map<string, number>();
  let idx = 0;
  for (const key of colorMap.keys()) {
    order.set(key, idx++);
  }
  return order;
}

export function buildStackedHourlyBars(
  hourly: HourlyUsagePoint[] | undefined,
  dim: 'tokens' | 'requests' = 'tokens',
  colorMap?: ReadonlyMap<string, string>
): StackedTrendBarPoint[] {
  const byHour = new Map<number, HourlyUsagePoint>();
  for (const pt of hourly ?? []) {
    const match = pt.hour.match(/\s(\d{2}):/);
    if (match) byHour.set(Number(match[1]), pt);
  }
  const resolvedColors = buildEffectiveColorMap(hourly ?? [], dim, colorMap);
  const colorOrder = createOrderMap(resolvedColors);
  const nowHour = new Date().getHours();
  const out: StackedTrendBarPoint[] = [];

  for (let h = 0; h < 24; h++) {
    const rec = byHour.get(h);
    const tokens = rec?.total_tokens ?? 0;
    const requests = rec?.request_count ?? 0;
    const value = dim === 'requests' ? requests : tokens;
    const hh = String(h).padStart(2, '0');
    out.push({
      label: `今日 ${hh}:00`,
      axisLabel: `${hh}时`,
      value,
      tokens,
      requests,
      future: h > nowHour && tokens === 0 && requests === 0,
      segments: buildSegmentsForBucket(
        rec?.by_model,
        value,
        tokens,
        requests,
        dim,
        resolvedColors,
        colorOrder
      ),
    });
  }
  return out;
}

export function buildStackedDailyBars(
  daily: DailyUsagePoint[] | undefined,
  dim: 'tokens' | 'requests' = 'tokens',
  colorMap?: ReadonlyMap<string, string>
): StackedTrendBarPoint[] {
  const rows = daily ?? [];
  const resolvedColors = buildEffectiveColorMap(rows, dim, colorMap);
  const colorOrder = createOrderMap(resolvedColors);

  return rows.map((pt) => {
    const tokens = pt.total_tokens;
    const requests = pt.request_count;
    const value = dim === 'requests' ? requests : tokens;
    return {
      label: pt.date,
      axisLabel: pt.date.slice(5),
      value,
      tokens,
      requests,
      segments: buildSegmentsForBucket(
        pt.by_model,
        value,
        tokens,
        requests,
        dim,
        resolvedColors,
        colorOrder
      ),
    };
  });
}

function allocateStackedHeights(values: readonly number[], totalH: number, minH: number): number[] {
  const n = values.length;
  if (n === 0 || totalH <= 0) return values.map(() => 0);
  if (n === 1) return [totalH];

  const heights = new Array<number>(n).fill(0);
  const locked = new Array<boolean>(n).fill(false);
  let remainingH = totalH;
  let remainingVal = values.reduce((acc, v) => acc + Math.max(0, v), 0);

  // Iteratively lock segments below minH so visible minimums never push total stack above totalH.
  while (true) {
    let lockedAny = false;
    for (let i = 0; i < n; i++) {
      if (locked[i]) continue;
      const v = Math.max(0, values[i]!);
      const raw = remainingVal > 0 ? (v / remainingVal) * remainingH : remainingH / n;
      if (raw < minH) {
        heights[i] = minH;
        locked[i] = true;
        remainingH = Math.max(0, remainingH - minH);
        remainingVal = Math.max(0, remainingVal - v);
        lockedAny = true;
      }
    }
    if (!lockedAny) break;
  }

  let unlockedCount = 0;
  for (let i = 0; i < n; i++) {
    if (!locked[i]) unlockedCount++;
  }
  for (let i = 0; i < n; i++) {
    if (locked[i]) continue;
    const v = Math.max(0, values[i]!);
    heights[i] = remainingVal > 0 ? (v / remainingVal) * remainingH : remainingH / Math.max(1, unlockedCount);
  }
  return heights;
}

function formatZeroOrFutureTip(pt: StackedTrendBarPoint, dim: 'tokens' | 'requests'): string {
  if (pt.future) return t('menu_panel.hover.future', { label: pt.label });
  return dim === 'requests'
    ? t('win.chart.hover_zero_requests', { label: pt.label })
    : t('win.chart.hover_zero_tokens', { label: pt.label });
}

function formatSegmentTip(
  pt: StackedTrendBarPoint,
  seg: StackedBarSegment,
  dim: 'tokens' | 'requests'
): string {
  if (seg.isFallback || !seg.model) {
    if (dim === 'tokens') {
      return t('menu_panel.hover.tokens', {
        label: pt.label,
        tokens: formatCompactNumber(pt.tokens),
      });
    }
    return t('menu_panel.hover.requests', {
      label: pt.label,
      count: formatInt(pt.requests),
    });
  }

  if (dim === 'tokens') {
    return t('win.chart.hover_model_tokens', {
      label: pt.label,
      model: seg.model,
      tokens: formatCompactNumber(seg.tokens),
    });
  }
  return t('win.chart.hover_model_requests', {
    label: pt.label,
    model: seg.model,
    count: formatInt(seg.requests),
  });
}

function formatPeakSummary(peakPt: StackedTrendBarPoint | undefined, dim: 'tokens' | 'requests'): string {
  if (!peakPt || peakPt.value <= 0) return '';
  if (dim === 'tokens') {
    return t('win.chart.peak_tokens', {
      label: peakPt.label,
      tokens: formatCompactNumber(peakPt.tokens),
    });
  }
  return t('win.chart.peak_requests', {
    label: peakPt.label,
    count: formatInt(peakPt.requests),
  });
}

export function renderStackedChartLegend(
  entries: ReadonlyArray<{ model: string; color: string }>
): string {
  if (entries.length === 0) return '';
  const items = entries
    .map(
      (item) => `<span class="gb-chart-legend-item">
        <span class="gb-chart-legend-dot" style="background:${escapeHtml(item.color)}"></span>
        <span class="gb-chart-legend-name">${escapeHtml(item.model)}</span>
      </span>`
    )
    .join('');
  return `<div class="gb-chart-legend">${items}</div>`;
}

export function renderStackedTrendChartSvg(
  points: StackedTrendBarPoint[],
  options: {
    width?: number;
    height?: number;
    dim?: 'tokens' | 'requests';
    colorMap?: ReadonlyMap<string, string>;
    showLegend?: boolean;
  } = {}
): StackedTrendRenderResult {
  const w = options.width ?? 560;
  const h = options.height ?? 168;
  const dim = options.dim ?? 'tokens';
  const padLeft = 44;
  const padRight = 10;
  const padTop = 14;
  const padBottom = 26;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const maxVal = Math.max(0, ...points.map((p) => p.value));
  let peakIdx = -1;
  points.forEach((p, i) => {
    if (p.value > 0 && (peakIdx < 0 || p.value > points[peakIdx]!.value)) peakIdx = i;
  });

  const formatVal = (v: number) => (dim === 'requests' ? formatInt(v) : formatCompactNumber(v));
  const midVal = maxVal > 0 ? maxVal / 2 : 0;

  const n = Math.max(1, points.length);
  const step = plotW / n;
  const barW = Math.max(3, Math.min(18, step * 0.62));

  const seenLegend = new Map<string, string>();
  const bars = points
    .map((pt, i) => {
      const cx = padLeft + i * step + step / 2;
      const x = cx - barW / 2;
      if (pt.value <= 0 || pt.segments.length === 0) {
        const barH = 2;
        const y = padTop + plotH - barH;
        const cls = pt.future ? 'gb-chart-bar future' : 'gb-chart-bar zero';
        const tip = formatZeroOrFutureTip(pt, dim);
        return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH}" rx="1" fill="currentColor" data-tip="${escapeHtml(tip)}"></rect>`;
      }

      for (const seg of pt.segments) {
        if (!seg.isFallback && seg.model && !seenLegend.has(seg.model)) {
          seenLegend.set(seg.model, seg.color);
        }
      }

      const ratio = maxVal > 0 ? pt.value / maxVal : 0;
      const rawBarH = ratio * plotH;
      const k = pt.segments.length;
      if (k === 1) {
        const seg = pt.segments[0]!;
        const segH = Math.min(plotH, Math.max(4, rawBarH));
        const segY = padTop + plotH - segH;
        const rx = Math.min(3, barW / 2, segH / 2);
        const tip = formatSegmentTip(pt, seg, dim);
        return `<rect class="gb-chart-bar active" x="${x.toFixed(1)}" y="${segY.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" rx="${rx.toFixed(1)}" fill="${escapeHtml(seg.color)}" data-tip="${escapeHtml(tip)}"></rect>`;
      }

      const gap = k * 3 + (k - 1) <= plotH ? 1 : k * 2 + (k - 1) * 0.5 <= plotH ? 0.5 : 0;
      const minSegH = k * 3 + (k - 1) * gap <= plotH ? 3 : Math.max(1, (plotH - (k - 1) * gap) / k);
      const minTotalH = k * minSegH + (k - 1) * gap;
      const targetTotalH = Math.min(plotH, Math.max(minTotalH, rawBarH));
      const availSegH = Math.max(0, targetTotalH - (k - 1) * gap);
      const heights = allocateStackedHeights(
        pt.segments.map((s) => s.value),
        availSegH,
        minSegH
      );

      let cursorBottom = padTop + plotH;
      return pt.segments
        .map((seg, idx) => {
          const segH = heights[idx]!;
          const segY = cursorBottom - segH;
          cursorBottom = segY - gap;
          const isTop = idx === k - 1;
          const rxAttr = isTop
            ? ` rx="${Math.min(2.5, barW / 2, segH / 2).toFixed(1)}"`
            : '';
          const tip = formatSegmentTip(pt, seg, dim);
          return `<rect class="gb-chart-bar active" x="${x.toFixed(1)}" y="${segY.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}"${rxAttr} fill="${escapeHtml(seg.color)}" data-tip="${escapeHtml(tip)}"></rect>`;
        })
        .join('');
    })
    .join('');

  const tickIndices =
    n <= 7
      ? points.map((_, i) => i)
      : [0, Math.floor((n - 1) * 0.25), Math.floor((n - 1) * 0.5), Math.floor((n - 1) * 0.75), n - 1];
  const uniqueTicks = Array.from(new Set(tickIndices));
  const axisLabels = uniqueTicks
    .map((idx) => {
      const pt = points[idx];
      if (!pt) return '';
      const x = padLeft + idx * step + step / 2;
      return `<text x="${x.toFixed(1)}" y="${h - 6}" text-anchor="middle" class="gb-chart-axis">${escapeHtml(pt.axisLabel)}</text>`;
    })
    .join('');

  const svg = `<svg class="gb-trend-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(t('component.chart.bar_a11y'))}">
    <line x1="${padLeft}" y1="${padTop}" x2="${w - padRight}" y2="${padTop}" class="gb-chart-grid" />
    <line x1="${padLeft}" y1="${padTop + plotH / 2}" x2="${w - padRight}" y2="${padTop + plotH / 2}" class="gb-chart-grid" />
    <line x1="${padLeft}" y1="${padTop + plotH}" x2="${w - padRight}" y2="${padTop + plotH}" class="gb-chart-grid baseline" />
    <text x="${padLeft - 6}" y="${padTop + 4}" text-anchor="end" class="gb-chart-axis">${maxVal > 0 ? escapeHtml(formatVal(maxVal)) : ''}</text>
    <text x="${padLeft - 6}" y="${padTop + plotH / 2 + 4}" text-anchor="end" class="gb-chart-axis">${maxVal > 0 ? escapeHtml(formatVal(midVal)) : ''}</text>
    <text x="${padLeft - 6}" y="${padTop + plotH + 3}" text-anchor="end" class="gb-chart-axis">0</text>
    ${bars}
    ${axisLabels}
  </svg>`;

  const legendEntries: Array<{ model: string; color: string }> = [];
  if (options.colorMap) {
    for (const [model, color] of options.colorMap.entries()) {
      if (seenLegend.has(model)) {
        legendEntries.push({ model, color });
      }
    }
  }
  for (const [model, color] of seenLegend.entries()) {
    if (!legendEntries.some((entry) => entry.model === model)) {
      legendEntries.push({ model, color });
    }
  }

  const peakPt = peakIdx >= 0 ? points[peakIdx] : undefined;
  return {
    svg,
    legendHtml: options.showLegend === false ? '' : renderStackedChartLegend(legendEntries),
    peakLabel: peakPt?.axisLabel ?? '',
    peakValueText: peakPt ? formatVal(peakPt.value) : '',
    peakSummaryText: formatPeakSummary(peakPt, dim),
    models: legendEntries.map((entry) => entry.model),
  };
}

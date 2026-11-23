import type { ProjectedModelUsage } from '../api/types';
import { t } from '../i18n/l10n';
import { escapeHtml, formatUsd } from '../utils/format';
import { assignModelColors, getModelColor, OTHER_MODELS_COLOR } from './palette';

export function renderCostDonutSvg(
  models: ProjectedModelUsage[],
  totalUsd: number,
  colorMap?: ReadonlyMap<string, string>
): string {
  const priced = models
    .filter((m) => m.estimatedUsd > 0)
    .sort(
      (a, b) =>
        b.estimatedUsd - a.estimatedUsd ||
        b.totalTokens - a.totalTokens ||
        a.model.localeCompare(b.model)
    );
  const size = 128;
  const cx = 64;
  const cy = 64;
  const r = 48;
  const circumference = 2 * Math.PI * r;

  if (priced.length === 0 || totalUsd <= 0) {
    return `
      <div class="gb-donut-wrap">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-label="${escapeHtml(t('component.donut.a11y'))}">
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track-bg)" stroke-width="14"></circle>
          <text x="${cx}" y="${cy + 2}" text-anchor="middle" class="gb-donut-center-val">$0</text>
          <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="gb-donut-center-sub">${escapeHtml(t('component.donut.equivalent_bill'))}</text>
        </svg>
        <div class="gb-donut-legend">
          <div class="gb-muted-text">${escapeHtml(t('usage.donut.empty_calls'))}</div>
        </div>
      </div>
    `;
  }

  const resolvedColors = colorMap ?? assignModelColors(priced);
  const top = priced.slice(0, 4);
  const restUsd = priced.slice(4).reduce((sum, m) => sum + m.estimatedUsd, 0);
  const slices = top.map((m, i) => ({
    label: m.model,
    usd: m.estimatedUsd,
    color: getModelColor(resolvedColors, m.model, i),
  }));
  if (restUsd > 0) {
    slices.push({
      label: t('usage.donut.other_models', { count: priced.length - 4 }),
      usd: restUsd,
      color: OTHER_MODELS_COLOR,
    });
  }

  let offset = 0;
  const circles = slices
    .map((s) => {
      const frac = Math.max(0, s.usd / totalUsd);
      const dash = frac * circumference;
      const gap = Math.max(0, circumference - dash);
      const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="14" stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
      offset += dash;
      return seg;
    })
    .join('');

  const legend = slices
    .map((s) => {
      const pct = Math.round((s.usd / totalUsd) * 100);
      return `<div class="gb-legend-row">
        <span class="gb-legend-dot" style="background:${s.color}"></span>
        <div class="gb-legend-info">
          <div class="gb-legend-name">${escapeHtml(s.label)}</div>
          <div class="gb-legend-sub">${escapeHtml(formatUsd(s.usd))} · ${pct}%</div>
        </div>
      </div>`;
    })
    .join('');

  return `
    <div class="gb-donut-wrap">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-label="${escapeHtml(t('component.donut.a11y'))}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track-bg)" stroke-width="14"></circle>
        ${circles}
        <text x="${cx}" y="${cy}" text-anchor="middle" class="gb-donut-center-val">${escapeHtml(formatUsd(totalUsd))}</text>
        <text x="${cx}" y="${cy + 15}" text-anchor="middle" class="gb-donut-center-sub">${escapeHtml(t('component.donut.equivalent_bill'))}</text>
      </svg>
      <div class="gb-donut-legend">${legend}</div>
    </div>
  `;
}

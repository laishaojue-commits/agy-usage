import appLogoUrl from '../../../assets/master-1024.png';
import claudeIconUrl from '../../../assets/model-icons/claude.png';
import geminiIconUrl from '../../../assets/model-icons/gemini.png';
import openaiIconUrl from '../../../assets/model-icons/openai.png';
import { t } from '../i18n/l10n';

export { appLogoUrl, claudeIconUrl, geminiIconUrl, openaiIconUrl };

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '--';
  if (value === 0) return '0';
  if (value < 1000) return String(Math.round(value));
  const tiers: Array<[string, number]> = [
    ['B', 1e9],
    ['M', 1e6],
    ['K', 1e3],
  ];
  for (const [unit, div] of tiers) {
    const v = value / div;
    if (v >= 1 || unit === 'K') {
      if (v >= 99.95) return `${Math.round(v)}${unit}`;
      return `${Number(v.toFixed(1))}${unit}`;
    }
  }
  return String(Math.round(value));
}

/** Formats token counts in international 3-sig-fig K/M/B shorthand without trailing zeros. */
export function formatContextTokens(value: number | null | undefined, significantDigits = 3): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '0';
  const integer = Math.round(value);
  if (integer < 1000) return String(integer);
  const rounded = Number(integer.toPrecision(significantDigits));
  const divisor = rounded >= 1e9 ? 1e9 : rounded >= 1e6 ? 1e6 : 1e3;
  const unit = divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : 'K';
  return `${Number((rounded / divisor).toPrecision(significantDigits))}${unit}`;
}

export function formatContextPercent(ratio: number | null | undefined): string {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return '0%';
  const percent = ratio * 100;
  if (percent >= 99.95) return `${Math.round(percent)}%`;
  if (percent >= 1) return `${Number(percent.toFixed(1))}%`;
  if (percent >= 0.01) return `${Number(percent.toFixed(2))}%`;
  const sig = Number(percent.toPrecision(2));
  const decimals = Math.min(20, Math.max(0, -Math.floor(Math.log10(sig)) + 2));
  const text = sig.toFixed(decimals).replace(/\.?0+$/, '');
  return `${text === '0' || !text ? String(sig) : text}%`;
}

export function formatRelativeAgeShort(tsSecOrMs: number | null | undefined): string {
  if (typeof tsSecOrMs !== 'number' || !Number.isFinite(tsSecOrMs) || tsSecOrMs <= 0) return '--';
  const ms = tsSecOrMs < 1e11 ? tsSecOrMs * 1000 : tsSecOrMs;
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60 && diffSec >= -5) return t('common.just_now');
  if (diffSec >= 60 && diffSec < 3600) {
    return `${Math.floor(diffSec / 60)} 分钟前`;
  }
  if (diffSec >= 3600 && diffSec < 86400) {
    return `${Math.floor(diffSec / 3600)} 小时前`;
  }
  return formatTimestamp(ms);
}

export function formatInt(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return Math.round(value).toLocaleString('zh-CN');
}

export function formatUsd(usd: number | null | undefined): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return '--';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatTimestamp(tsSecOrMs: number | null | undefined): string {
  if (typeof tsSecOrMs !== 'number' || !Number.isFinite(tsSecOrMs) || tsSecOrMs <= 0) return '--';
  const ms = tsSecOrMs < 1e11 ? tsSecOrMs * 1000 : tsSecOrMs;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

export function formatRelativeTime(tsSecOrMs: number | null | undefined): string {
  if (typeof tsSecOrMs !== 'number' || !Number.isFinite(tsSecOrMs) || tsSecOrMs <= 0) return '--';
  const ms = tsSecOrMs < 1e11 ? tsSecOrMs * 1000 : tsSecOrMs;
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60 && diffSec >= -5) return t('common.just_now');
  return formatTimestamp(ms);
}

export type ModelBrand = 'gemini' | 'claude' | 'openai' | 'other';

export function detectModelBrand(modelName: string): ModelBrand {
  const low = String(modelName || '').toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(low)) return 'claude';
  if (/gpt|openai|^o[1-9]\b|o[1-9]-/.test(low)) return 'openai';
  if (/gemini|google|argon|carbon|hydrogen|neon|flash/.test(low)) return 'gemini';
  return 'other';
}

export function modelBrandIconUrl(brand: ModelBrand): string {
  if (brand === 'claude') return claudeIconUrl;
  if (brand === 'openai') return openaiIconUrl;
  return geminiIconUrl;
}

export function renderModelIcon(modelName: string, size = 20): string {
  const brand = detectModelBrand(modelName);
  const url = modelBrandIconUrl(brand);
  return `<img class="gb-model-icon" src="${escapeHtml(url)}" width="${size}" height="${size}" alt="" loading="lazy" />`;
}

export function quotaColorClass(pct: number | null | undefined): 'ok' | 'warn' | 'danger' | 'unknown' {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'unknown';
  if (pct <= 5) return 'danger';
  if (pct <= 20) return 'warn';
  return 'ok';
}

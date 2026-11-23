const COMPACT_NUMBER_TIERS: ReadonlyArray<readonly [string, number]> = [
  ['K', 1e3],
  ['M', 1e6],
  ['B', 1e9],
];

/**
 * 格式化常驻 HUD 胶囊精简数字（四舍五入；<1K 展示整数；>=1K 最多保留 1 位小数并去尾零，>=99.95 取整，>=999.5 自动进位 K/M/B）。
 */
export function compactBarNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const rounded = Math.round(value);
  if (rounded < 1000) return String(rounded);
  for (let i = 0; i < COMPACT_NUMBER_TIERS.length; i++) {
    const [unit, divisor] = COMPACT_NUMBER_TIERS[i]!;
    const unitVal = rounded / divisor;
    if (unitVal >= 999.5 && i < COMPACT_NUMBER_TIERS.length - 1) continue;
    if (unitVal < 99.95) return `${Number(unitVal.toFixed(1))}${unit}`;
    return `${Math.round(unitVal)}${unit}`;
  }
  return String(rounded);
}

/**
 * 格式化详情卡片紧凑计数（四舍五入；<1K 展示整数；>=1K 保留 significantDigits 位有效数字并去尾零且支持 K/M/B 进位）。
 */
export function compactNumber(value: number, significantDigits = 3): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const integer = Math.round(value);
  if (integer < 1000) return String(integer);
  const rounded = Number(integer.toPrecision(significantDigits));
  const divisor = rounded >= 1e9 ? 1e9 : rounded >= 1e6 ? 1e6 : 1e3;
  const unit = divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : 'K';
  return `${Number((rounded / divisor).toPrecision(significantDigits))}${unit}`;
}

/**
 * 格式化详情卡片中的速率与延迟指标（TPS / TTFT）：
 * <9.995 最多 2 位小数去尾零；<99.95 最多 1 位小数去尾零；<999.5 取整；>=999.5 紧凑进位 K/M/B。
 */
export function compactRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 9.995) return String(Number(value.toFixed(2)));
  if (value < 99.95) return String(Number(value.toFixed(1)));
  if (value < 999.5) return String(Math.round(value));
  return compactNumber(Math.round(value), 3);
}

/**
 * 格式化最多保留 fractionDigits 位小数的简约数字（去除多余尾零，如 15.50 -> 15.5、0.00 -> 0）。
 */
export function compactDecimal(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const digits = Math.max(0, Math.min(20, Math.floor(fractionDigits)));
  if (digits === 0) return String(Math.round(value) || 0);
  const rounded = Number(value.toFixed(digits));
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return String(rounded);
}

/**
 * 格式化简约百分比（>=99.95% 取整；>=1% 最多 1 位小数去尾零；(0, 1)% 最多 2 位小数或 2 位有效数字去尾零）。
 */
export function compactPercent(ratio: number, _significantDigits = 3): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const percent = ratio * 100;
  if (percent >= 99.95) return `${Math.round(percent)}%`;
  if (percent >= 1) return `${Number(percent.toFixed(1))}%`;
  if (percent >= 0.01) return `${Number(percent.toFixed(2))}%`;
  const sig = Number(percent.toPrecision(2));
  const decimals = Math.min(20, Math.max(0, -Math.floor(Math.log10(sig)) + 2));
  const text = sig.toFixed(decimals).replace(/\.?0+$/, '');
  return `${text === '0' || !text ? String(sig) : text}%`;
}

/**
 * 格式化简约估算美元金额（0 显示 $0；微额保留至多 4/6 位有效小数并去尾零；常规保留至多 2 位小数去尾零；>=1000 进位 K/M/B）。
 */
export function compactUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) {
    const r4 = Number(usd.toFixed(4));
    if (r4 > 0) return `~$${String(r4)}`;
    const s6 = usd.toFixed(6).replace(/\.?0+$/, '');
    if (s6 && s6 !== '0') return `~$${s6}`;
    return '$0';
  }
  if (usd < 999.995) {
    return `~$${String(Number(usd.toFixed(2)))}`;
  }
  return `~$${compactNumber(Math.round(usd), 3)}`;
}
function isChineseLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  return normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg' || normalized.startsWith('zh-hans');
}

export function durationText(value: number, language: string = 'zh'): string {
  const seconds = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (isChineseLanguage(language)) {
    if (seconds === 0) return '0秒';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
    return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${rest ? `${rest}秒` : ''}`;
  }
  if (seconds === 0) return '0s';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${rest ? `${rest}s` : ''}`;
}

export function formatTurnDurationCompact(seconds: number, language: string = 'zh'): string {
  const isZh = isChineseLanguage(language);
  const prefix = isZh ? '本轮 ' : 'Turn ';
  if (!Number.isFinite(seconds) || seconds < 0) return `${prefix}0s`;
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${prefix}${rounded}s`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours > 0) return `${prefix}${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  return `${prefix}${minutes}m`;
}

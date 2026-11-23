import type { TrendModelBreakdown } from '../api/types';

export const MODEL_CHART_PALETTE = [
  '#0A84FF',
  '#10B981',
  '#8B5CF6',
  '#F59E0B',
  '#EC4899',
  '#06B6D4',
  '#F97316',
  '#64748B',
] as const;

export const OTHER_MODELS_COLOR = '#64748B';

export interface ModelColorEntry {
  model: string;
  estimatedUsd?: number;
  totalTokens?: number;
  total_tokens?: number;
}

export interface TrendBucketWithBreakdown {
  by_model?: TrendModelBreakdown[];
}

/**
 * Assign a fixed color per model from the shared palette.
 * String lists preserve explicit caller order; metric objects sort by estimatedUsd desc, then tokens desc, then name.
 */
export function assignModelColors(
  models: Iterable<string | ModelColorEntry>
): Map<string, string> {
  const items = Array.from(models);
  let orderedNames: string[];

  if (items.every((item): item is string => typeof item === 'string')) {
    orderedNames = items;
  } else {
    const entries: Array<{ model: string; usd: number; tokens: number }> = [];
    for (const item of items) {
      if (typeof item === 'string') {
        entries.push({ model: item, usd: 0, tokens: 0 });
      } else if (item && typeof item.model === 'string') {
        entries.push({
          model: item.model,
          usd: Number(item.estimatedUsd ?? 0) || 0,
          tokens: Number(item.totalTokens ?? item.total_tokens ?? 0) || 0,
        });
      }
    }
    entries.sort(
      (a, b) =>
        b.usd - a.usd ||
        b.tokens - a.tokens ||
        a.model.localeCompare(b.model)
    );
    orderedNames = entries.map((e) => e.model);
  }

  const colorMap = new Map<string, string>();
  for (const rawName of orderedNames) {
    const name = rawName.trim();
    if (!name || colorMap.has(name)) continue;
    colorMap.set(name, MODEL_CHART_PALETTE[colorMap.size % MODEL_CHART_PALETTE.length]!);
  }
  return colorMap;
}

/**
 * Merge period summary models (cost-first, then tokens) with any models present only in trend buckets.
 */
export function collectOrderedChartModels(
  summaryModels: readonly ModelColorEntry[] | undefined,
  trendPoints: readonly TrendBucketWithBreakdown[] | undefined
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const sortedSummary = [...(summaryModels ?? [])]
    .filter((m) => m && typeof m.model === 'string' && m.model.trim())
    .sort(
      (a, b) =>
        (Number(b.estimatedUsd ?? 0) || 0) - (Number(a.estimatedUsd ?? 0) || 0) ||
        (Number(b.totalTokens ?? b.total_tokens ?? 0) || 0) -
          (Number(a.totalTokens ?? a.total_tokens ?? 0) || 0) ||
        a.model.localeCompare(b.model)
    );

  for (const entry of sortedSummary) {
    const name = entry.model.trim();
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }

  const extraTotals = new Map<string, { tokens: number; requests: number }>();
  for (const pt of trendPoints ?? []) {
    for (const item of pt.by_model ?? []) {
      const name = item.model?.trim();
      if (!name || seen.has(name)) continue;
      const cur = extraTotals.get(name) ?? { tokens: 0, requests: 0 };
      cur.tokens += item.total_tokens ?? 0;
      cur.requests += item.request_count ?? 0;
      extraTotals.set(name, cur);
    }
  }

  const extraNames = [...extraTotals.entries()]
    .sort(
      (a, b) =>
        b[1].tokens - a[1].tokens ||
        b[1].requests - a[1].requests ||
        a[0].localeCompare(b[0])
    )
    .map(([name]) => name);

  return ordered.concat(extraNames);
}

export function getModelColor(
  colorMap: ReadonlyMap<string, string> | undefined,
  model: string,
  fallbackIndex = 0
): string {
  const mapped = colorMap?.get(model);
  if (mapped) return mapped;
  return MODEL_CHART_PALETTE[Math.abs(fallbackIndex) % MODEL_CHART_PALETTE.length]!;
}

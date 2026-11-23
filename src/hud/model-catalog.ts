import { normalizeModelId } from '../model-identity.js';
import {
  getEffectiveModelPriceAlias,
  getRemoteModelSpec,
  MODEL_CAPACITIES,
  MODEL_NAMES,
  resolveObservedModelByEnum,
  resolveObservedModelByIdOrAlias,
} from '../model-catalog.js';
import { resolveDatabaseModelFullName } from '../usage-types.js';
import { bt } from '../i18n.js';
/**
 * Antigravity 模型有效上下文窗口阈值映射目录
 * 严格对齐 Antigravity 官方运行时与 assets/model-catalog.json 标准上下文阈值 (<=200K / 256K / 128K)
 * 彻底剔除从第三方插件照搬的 1M / 2M 虚假容量
 */

export interface ModelCapacitySpec {
  modelId: string;
  displayName: string;
  capacityTokens: number;
  capacityCompact: string;
  isFallback: boolean;
}

/**
 * Antigravity 标准上下文压缩阈值 (对齐 assets/model-catalog.json <=200K 标准上下文基准)
 */
const HUD_CAPACITY_SUFFIX_RE =
  /(?:-(?:tiered|extra-high|extra-low|xhigh|extra|high|medium|low|minimal|thinking|max|latest))+$/i;

export const DEFAULT_CONTEXT_CAPACITY_TOKENS = 200_000;

interface ModelFamilyRule {
  pattern: RegExp;
  capacityTokens: number;
  capacityCompact: string;
  defaultDisplayName: string;
}

/**
 * 模型族参考容量（只有请求明确返回的容量才是实测值）
 * 缺少明确容量时才使用这些参考值；不能据此断言宿主实际窗口或压缩阈值，
 * 绝不展示虚构的 1M / 2M 容量。
 */
const MODEL_CAPACITY_RULES: readonly ModelFamilyRule[] = [
  {
    pattern: /^gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d+)?)-pro|^gemini-pro/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini Pro',
  },
  {
    pattern: /^gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d+)?)-flash/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini Flash',
  },
  {
    pattern: /^gemini-4-argon/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini 4 Argon',
  },
  {
    pattern: /^gemini-4-carbon/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini 4 Carbon',
  },
  {
    pattern: /^gemini-[4-9](?:\.\d+)?-[a-z0-9]+/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini',
  },
  {
    pattern: /^claude-(?:[3-9]|(?:opus|sonnet|haiku|[a-z]{3,16})-\d)|^claude-(?:sonnet|opus|haiku|fable|mythos)/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Claude',
  },
  {
    pattern: /^gpt-4o|^gpt-4\.1|^gpt-[5-9]|^o1|^o3|^o4/i,
    capacityTokens: 128_000,
    capacityCompact: '128K',
    defaultDisplayName: 'GPT-4o',
  },
  {
    pattern: /^gpt-oss/i,
    capacityTokens: 128_000,
    capacityCompact: '128K',
    defaultDisplayName: 'GPT-OSS',
  },
];

const INTERNAL_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  'gemini-4-argon-trial': 'Gemini 4 Argon Trial',
  'gemini-4-carbon-trial': 'Gemini 4 Carbon Trial',
  'gemini-3.8-flash-control': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-n': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-tiered': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-exp-a': 'Gemini 3.8 Flash',
  'gemini-3.7-flash-tiered': 'Gemini 3.7 Flash',
  'gemini-3.7-flash-safety-le': 'Gemini 3.7 Flash',
  'gemini-3.6-flash-tiered': 'Gemini 3.6 Flash',
  'gemini-3.6-flash-exp-a': 'Gemini 3.6 Flash',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3-flash-a': 'Gemini 3 Flash',
  'gemini-pro-default': 'Gemini Pro',
};

function formatCompactCapacity(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  const k = Math.round(tokens / 1_000);
  return `${k}K`;
}

function autoFormatDynamicModelName(normalizedId: string): string | null {
  const geminiMatch = normalizedId.match(/^gemini-([4-9](?:\.\d+)?)-([a-z][a-z0-9]*?)(?:-(trial|preview|exp))?$/i);
  if (geminiMatch) {
    const ver = geminiMatch[1]!;
    const code = geminiMatch[2]!.charAt(0).toUpperCase() + geminiMatch[2]!.slice(1).toLowerCase();
    const suffix = geminiMatch[3]
      ? ` ${geminiMatch[3].charAt(0).toUpperCase() + geminiMatch[3].slice(1).toLowerCase()}`
      : '';
    return `Gemini ${ver} ${code}${suffix}`;
  }
  const claudeMatch = normalizedId.match(
    /^claude-((?!thinking|preview|trial|latest|high|medium|low|max|minimal|xhigh|extra|tiered|fast|batch|exp)[a-z]{3,16})-(\d+)-(\d+)$/i
  );
  if (claudeMatch) {
    const tier = claudeMatch[1]!.charAt(0).toUpperCase() + claudeMatch[1]!.slice(1).toLowerCase();
    return `Claude ${tier} ${claudeMatch[2]}.${claudeMatch[3]}`;
  }
  const gptMatch = normalizedId.match(/^gpt-([5-9](?:\.\d+)?)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*))?$/i);
  if (gptMatch) {
    const ver = gptMatch[1]!;
    const suffix = gptMatch[2]
      ? ` ${gptMatch[2]
          .split('-')
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
          .join(' ')}`
      : '';
    return `GPT-${ver}${suffix}`;
  }
  return null;
}

const EFFORT_PAREN_RE = /[（(]\s*(?:Extra\s+High|Extra\s+Low|XHigh|Extra|High|Medium|Low|Minimal|Max|Thinking|高|中|低|思考)\s*[）)]/gi;
const EFFORT_TRAIL_RE = /\s+(?:Extra\s+High|Extra\s+Low|XHigh|Extra|High|Medium|Low|Minimal|Max|Thinking)\b.*$/i;
const UNKNOWN_MODEL_LABELS = new Set(['未知模型', 'Unknown Model']);

function isUnknownResolvedLabel(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  return !trimmed || UNKNOWN_MODEL_LABELS.has(trimmed) || trimmed === bt('usage.unknown_model');
}

function stripButtonDecorations(raw: string): string {
  return raw
    .replace(/^models\//i, '')
    .trim()
    .replace(/^[+\s·•]+|[⌃⌄^\s]+$/g, '')
    .trim();
}

export function stripOrchestratorWrapper(raw: string): {
  isOrchestrator: boolean;
  inner: string;
  isParenForm: boolean;
  isTrailingSuffix: boolean;
} {
  const cleaned = stripButtonDecorations(raw);
  if (!cleaned) {
    return { isOrchestrator: false, inner: '', isParenForm: false, isTrailingSuffix: false };
  }
  const parenMatch = cleaned.match(/^Orchestrator\s*[（(]\s*([^）)]+?)\s*[）)]\s*$/i);
  if (parenMatch) {
    return {
      isOrchestrator: true,
      inner: parenMatch[1]!.trim(),
      isParenForm: true,
      isTrailingSuffix: false,
    };
  }
  const trailingMatch = cleaned.match(/^(.+?)\s*[（(]\s*Orchestrator\s*[）)]\s*$/i);
  if (trailingMatch) {
    return {
      isOrchestrator: true,
      inner: trailingMatch[1]!.trim(),
      isParenForm: true,
      isTrailingSuffix: true,
    };
  }
  const spacePrefixMatch = cleaned.match(/^Orchestrator(?:\s*[:·•/-]\s*|\s+)(.+)$/i);
  if (spacePrefixMatch) {
    return {
      isOrchestrator: true,
      inner: spacePrefixMatch[1]!.trim(),
      isParenForm: false,
      isTrailingSuffix: false,
    };
  }
  if (/^Orchestrator$/i.test(cleaned)) {
    return { isOrchestrator: true, inner: '', isParenForm: false, isTrailingSuffix: false };
  }
  return { isOrchestrator: false, inner: cleaned, isParenForm: false, isTrailingSuffix: false };
}

/**
 * 依据运行时动态观察注册表与目录别名，将数字 modelEnum (如 1532 -> Gemini 4 Neon (High))
 * 映射为标准 ModelCapacitySpec；未命中时返回 null，绝不硬编码伪造。
 */
export function resolveObservedModelSpecByEnum(modelEnum?: number | null): ModelCapacitySpec | null {
  if (typeof modelEnum !== 'number' || !Number.isSafeInteger(modelEnum) || modelEnum <= 0) {
    return null;
  }
  const observed = resolveObservedModelByEnum(modelEnum);
  if (observed) {
    const primaryRef = observed.modelId || observed.displayName || observed.modelOrAlias || '';
    if (primaryRef) {
      const spec = resolveModelCapacity(primaryRef);
      const preferredDisplay =
        observed.displayName &&
        !/^MODEL_PLACEHOLDER_M\d+$/i.test(observed.displayName)
          ? observed.displayName
          : spec.displayName;
      return {
        ...spec,
        displayName: preferredDisplay || spec.displayName,
      };
    }
  }
  if (modelEnum > 1000) {
    const placeholder = `MODEL_PLACEHOLDER_M${modelEnum - 1000}`;
    const observedByAlias = resolveObservedModelByIdOrAlias(placeholder);
    if (observedByAlias) {
      const primaryRef = observedByAlias.modelId || observedByAlias.displayName || placeholder;
      const spec = resolveModelCapacity(primaryRef);
      return {
        ...spec,
        displayName: observedByAlias.displayName || spec.displayName,
      };
    }
    const directAlias = getEffectiveModelPriceAlias(placeholder);
    if (directAlias && directAlias.toLowerCase() !== placeholder.toLowerCase()) {
      return resolveModelCapacity(directAlias);
    }
  }
  return null;
}

/**
 * 归一化前端 DOM 探针或 SQLite gen_metadata 传入的模型字符串，解析对应的 Antigravity 有效上下文阈值与展示名称
 */
export function resolveModelCapacity(rawModelInput?: string | null, depth = 0): ModelCapacitySpec {
  const raw = typeof rawModelInput === 'string' ? rawModelInput.trim() : '';
  if (!raw) {
    return {
      modelId: 'unknown-model',
      displayName: bt('usage.unknown_model'),
      capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
      capacityCompact: '~200K',
      isFallback: true,
    };
  }

  // 清理 API 前缀、前端按钮可能附带的加号及下拉箭头（保留括号以便先剥离 Orchestrator 包装）
  const decoratedStripped = stripButtonDecorations(raw);

  if (depth < 3) {
    const observedDirect = resolveObservedModelByIdOrAlias(decoratedStripped);
    if (observedDirect) {
      const targetRef = observedDirect.modelId || observedDirect.displayName || '';
      if (targetRef && targetRef.toLowerCase() !== decoratedStripped.toLowerCase()) {
        const resolved = resolveModelCapacity(targetRef, depth + 1);
        if (
          observedDirect.displayName &&
          resolved.isFallback &&
          !/^MODEL_PLACEHOLDER_M\d+$/i.test(observedDirect.displayName)
        ) {
          return { ...resolved, displayName: observedDirect.displayName };
        }
        return resolved;
      }
    }

    const orch = stripOrchestratorWrapper(decoratedStripped);
    if (orch.isOrchestrator) {
      if (!orch.inner) {
        return {
          modelId: 'unknown-model',
          displayName: bt('usage.unknown_model'),
          capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
          capacityCompact: '~200K',
          isFallback: true,
        };
      }
      const orchAlias = getEffectiveModelPriceAlias(decoratedStripped);
      if (orchAlias && orchAlias.toLowerCase() !== decoratedStripped.toLowerCase()) {
        return resolveModelCapacity(orchAlias, depth + 1);
      }
      const innerObserved = resolveObservedModelByIdOrAlias(orch.inner);
      if (innerObserved?.modelId) {
        return resolveModelCapacity(innerObserved.modelId, depth + 1);
      }
      const innerAlias = getEffectiveModelPriceAlias(orch.inner);
      if (innerAlias && innerAlias.toLowerCase() !== orch.inner.toLowerCase()) {
        return resolveModelCapacity(innerAlias, depth + 1);
      }
      const isSingleTokenParen =
        orch.isParenForm &&
        !orch.isTrailingSuffix &&
        !/\s/.test(orch.inner) &&
        !/^(?:gemini|claude|gpt|o[1-9]|llama|deepseek|qwen|mistral|grok)/i.test(orch.inner);
      if (isSingleTokenParen) {
        const resolvedLegacy = resolveDatabaseModelFullName(decoratedStripped, decoratedStripped);
        if (!isUnknownResolvedLabel(resolvedLegacy) && resolvedLegacy.toLowerCase() !== decoratedStripped.toLowerCase()) {
          return resolveModelCapacity(resolvedLegacy, depth + 1);
        }
      }
      return resolveModelCapacity(orch.inner, depth + 1);
    }
  }

  // 清理思考档位后缀（如 "+ Gemini 3.8 Flash High ^"、"Gemini 4 Neon (High)"）
  const cleanedRaw = (decoratedStripped || raw)
    .replace(EFFORT_PAREN_RE, '')
    .replace(EFFORT_TRAIL_RE, '')
    .trim();

  if (depth < 3) {
    const directDynamicAlias = getEffectiveModelPriceAlias(cleanedRaw);
    if (directDynamicAlias && directDynamicAlias.toLowerCase() !== cleanedRaw.toLowerCase()) {
      return resolveModelCapacity(directDynamicAlias, depth + 1);
    }
    const observedCleaned = resolveObservedModelByIdOrAlias(cleanedRaw);
    if (observedCleaned?.modelId && observedCleaned.modelId.toLowerCase() !== cleanedRaw.toLowerCase()) {
      const resolved = resolveModelCapacity(observedCleaned.modelId, depth + 1);
      if (
        observedCleaned.displayName &&
        resolved.isFallback &&
        !/^MODEL_PLACEHOLDER_M\d+$/i.test(observedCleaned.displayName)
      ) {
        return { ...resolved, displayName: observedCleaned.displayName };
      }
      return resolved;
    }
    if (/\borchestrator\b|^gemini-flash-worker(?:-agy)?$|^MODEL_PLACEHOLDER_M\d+$/i.test(cleanedRaw)) {
      const resolvedAlias = resolveDatabaseModelFullName(cleanedRaw, cleanedRaw);
      if (!isUnknownResolvedLabel(resolvedAlias) && resolvedAlias !== cleanedRaw) {
        return resolveModelCapacity(resolvedAlias, depth + 1);
      }
    }
  }

  let normalizedId = (cleanedRaw || decoratedStripped || raw)
    .toLowerCase()
    .replace(/^models-/, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');

  normalizedId = normalizeModelId(normalizedId)
    .replace(HUD_CAPACITY_SUFFIX_RE, '');

  if (depth < 3) {
    const normalizedAlias = getEffectiveModelPriceAlias(normalizedId);
    if (normalizedAlias && normalizedAlias.toLowerCase() !== normalizedId) {
      return resolveModelCapacity(normalizedAlias, depth + 1);
    }
    const observedNorm = resolveObservedModelByIdOrAlias(normalizedId);
    if (observedNorm?.modelId && observedNorm.modelId.toLowerCase() !== normalizedId) {
      const normTarget = normalizeModelId(observedNorm.modelId).replace(HUD_CAPACITY_SUFFIX_RE, '');
      if (normTarget && normTarget !== normalizedId) {
        return resolveModelCapacity(normTarget, depth + 1);
      }
    }
  }

  const remoteSpec = getRemoteModelSpec(normalizedId);
  const observedSpec = resolveObservedModelByIdOrAlias(normalizedId) ?? resolveObservedModelByIdOrAlias(cleanedRaw);
  const observedDisplayName =
    observedSpec?.displayName && !/^MODEL_PLACEHOLDER_M\d+$/i.test(observedSpec.displayName)
      ? observedSpec.displayName.replace(EFFORT_PAREN_RE, '').replace(EFFORT_TRAIL_RE, '').trim() || observedSpec.displayName
      : undefined;
  const bundledCapacity =
    Object.hasOwn(MODEL_CAPACITIES, normalizedId) &&
    typeof MODEL_CAPACITIES[normalizedId] === 'number' &&
    MODEL_CAPACITIES[normalizedId]! > 0
      ? MODEL_CAPACITIES[normalizedId]!
      : undefined;
  const displayName =
    remoteSpec?.displayName ||
    INTERNAL_DISPLAY_NAME_OVERRIDES[normalizedId] ||
    (Object.hasOwn(MODEL_NAMES, normalizedId) ? MODEL_NAMES[normalizedId] : undefined) ||
    observedDisplayName ||
    autoFormatDynamicModelName(normalizedId) ||
    cleanedRaw ||
    raw;

  const explicitCap = remoteSpec?.capacityTokens ?? bundledCapacity ?? observedSpec?.maxTokens;
  if (explicitCap) {
    return {
      modelId: normalizedId,
      displayName,
      capacityTokens: explicitCap,
      capacityCompact: formatCompactCapacity(explicitCap),
      isFallback: false,
    };
  }

  for (const rule of MODEL_CAPACITY_RULES) {
    if (rule.pattern.test(normalizedId)) {
      return {
        modelId: normalizedId,
        displayName,
        capacityTokens: rule.capacityTokens,
        capacityCompact: rule.capacityCompact,
        isFallback: false,
      };
    }
  }

  if (remoteSpec?.displayName) {
    return {
      modelId: normalizedId,
      displayName,
      capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
      capacityCompact: '200K',
      isFallback: false,
    };
  }

  return {
    modelId: normalizedId || 'unknown-model',
    displayName: displayName || cleanedRaw || raw || bt('usage.unknown_model'),
    capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
    capacityCompact: '~200K',
    isFallback: true,
  };
}

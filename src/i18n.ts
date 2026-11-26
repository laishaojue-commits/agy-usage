import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type I18nNamespace = 'app' | 'backend';

interface ZhLocalePack {
  app: Record<string, string>;
  backend: Record<string, string>;
}

const ACTIVE_LOCALE = 'zh-Hans';

function resolveZhPackPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../assets/i18n/zh-Hans.json'),
    join(here, '../../assets/i18n/zh-Hans.json'),
    join(process.cwd(), 'assets/i18n/zh-Hans.json'),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function loadZhPack(): ZhLocalePack {
  const packPath = resolveZhPackPath();
  if (!packPath) return { app: {}, backend: {} };
  try {
    const parsed = JSON.parse(readFileSync(packPath, 'utf8')) as Partial<ZhLocalePack>;
    return {
      app: parsed.app && typeof parsed.app === 'object' ? { ...parsed.app } : {},
      backend: parsed.backend && typeof parsed.backend === 'object' ? { ...parsed.backend } : {},
    };
  } catch {
    return { app: {}, backend: {} };
  }
}

const zhPack = loadZhPack();

export function getActiveLocale(): string {
  return ACTIVE_LOCALE;
}

export function setActiveLocale(_input?: unknown): string {
  return ACTIVE_LOCALE;
}

/** 按键读取简体中文文本并执行 {param} 插值。 */
export function translate(
  _locale: string | undefined,
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
  options: {
    namespace?: I18nNamespace;
    fallback?: string;
  } = {}
): string {
  const ns: I18nNamespace = options.namespace ?? 'backend';
  const table = ns === 'app' ? zhPack.app : zhPack.backend;
  const template =
    (Object.hasOwn(table, key) ? table[key] : undefined) ??
    options.fallback ??
    key;
  if (!params) return template;

  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const val = params[name];
    return val === null || val === undefined ? '' : String(val);
  });
}

/** 查询 backend 命名空间简体中文文案的便捷方法。 */
export function bt(
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
  fallback?: string
): string {
  return translate(ACTIVE_LOCALE, key, params, { namespace: 'backend', fallback });
}

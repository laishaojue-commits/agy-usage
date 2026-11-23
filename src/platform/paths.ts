import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface BundleLayout {
  platform: NodeJS.Platform;
  appPath: string;
  executablePath: string;
  resourcesDir: string;
  asarPath: string;
  asarUnpackedPath: string;
  languageServerPath: string;
  languageServerCandidates: string[];
  plistPath?: string;
  codeSignaturePath?: string;
}

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

export function isMacOS(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

function resolvePlatform(appPath?: string, explicitPlatform?: NodeJS.Platform): NodeJS.Platform {
  if (explicitPlatform) return explicitPlatform;
  if (appPath && /\.app(?:[/\\]?)$/i.test(appPath)) return 'darwin';
  return process.platform;
}

export function normalizePathForCompare(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const raw = String(targetPath ?? '').trim();
  if (!raw) return '';
  if (platform === 'win32') {
    const normalized = win32.normalize(raw.replaceAll('/', '\\'));
    const root = win32.parse(normalized).root;
    const trimmed =
      normalized.length > root.length
        ? normalized.replace(/\\+$/, '')
        : normalized;
    return trimmed.toLowerCase();
  }
  const normalized = posix.normalize(raw);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function pathsEqual(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const left = normalizePathForCompare(a, platform);
  const right = normalizePathForCompare(b, platform);
  return Boolean(left) && left === right;
}

export function pathStartsWith(
  candidate: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normCandidate = normalizePathForCompare(candidate, platform);
  const normPrefix = normalizePathForCompare(prefix, platform);
  if (!normCandidate || !normPrefix) return false;
  if (normCandidate === normPrefix) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  const boundaryPrefix = normPrefix.endsWith(sep) ? normPrefix : `${normPrefix}${sep}`;
  return normCandidate.startsWith(boundaryPrefix);
}

function isRealHome(home: string | undefined, platform: NodeJS.Platform): boolean {
  if (home === undefined) return true;
  return pathsEqual(home, homedir(), platform);
}

export function defaultStateDir(
  home?: string,
  options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
): string {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const resolvedHome = home ?? homedir();
  if (platform === 'win32') {
    const appData = isRealHome(home, platform) ? env.APPDATA?.trim() : '';
    return appData
      ? win32.join(appData, 'GravityBox')
      : win32.join(resolvedHome, 'AppData', 'Roaming', 'GravityBox');
  }
  return posix.join(resolvedHome, 'Library', 'Application Support', 'GravityBox');
}

export function defaultCacheDir(
  home?: string,
  options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
): string {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const resolvedHome = home ?? homedir();
  if (platform === 'win32') {
    const localAppData = isRealHome(home, platform) ? env.LOCALAPPDATA?.trim() : '';
    return localAppData
      ? win32.join(localAppData, 'GravityBox', 'Cache')
      : win32.join(resolvedHome, 'AppData', 'Local', 'GravityBox', 'Cache');
  }
  return posix.join(resolvedHome, 'Library', 'Caches', 'GravityBox');
}

export function defaultAppSupportDir(
  home?: string,
  options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
): string {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const resolvedHome = home ?? homedir();
  if (platform === 'win32') {
    const appData = isRealHome(home, platform) ? env.APPDATA?.trim() : '';
    return appData || win32.join(resolvedHome, 'AppData', 'Roaming');
  }
  return posix.join(resolvedHome, 'Library', 'Application Support');
}

export function defaultAntigravityProfileDir(
  home?: string,
  name = 'Antigravity',
  options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
): string {
  const platform = options?.platform ?? process.platform;
  const p = platform === 'win32' ? win32 : posix;
  return p.join(defaultAppSupportDir(home, options), name);
}

export function defaultAntigravityAppDirs(
  home?: string,
  options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
): string[] {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const resolvedHome = home ?? homedir();
  const seen = new Set<string>();
  const dirs: string[] = [];
  const pushUnique = (candidate: string | undefined) => {
    const trimmed = candidate?.trim();
    if (!trimmed) return;
    const key = normalizePathForCompare(trimmed, platform);
    if (!key || seen.has(key)) return;
    seen.add(key);
    dirs.push(trimmed);
  };

  pushUnique(env.GRAVITYBOX_APP_PATH);

  if (platform === 'win32') {
    const localAppData =
      (isRealHome(home, platform) ? env.LOCALAPPDATA?.trim() : '') ||
      win32.join(resolvedHome, 'AppData', 'Local');
    pushUnique(win32.join(localAppData, 'Programs', 'Antigravity'));
    const programFiles =
      env.ProgramFiles?.trim() ||
      env.PROGRAMFILES?.trim() ||
      'C:\\Program Files';
    pushUnique(win32.join(programFiles, 'Antigravity'));
    return dirs;
  }

  pushUnique('/Applications/Antigravity.app');
  return dirs;
}

export function resolveBundleLayout(
  appPath: string,
  platformOrOptions?: NodeJS.Platform | { platform?: NodeJS.Platform; checkExists?: (path: string) => boolean }
): BundleLayout {
  const opts = typeof platformOrOptions === 'string'
    ? { platform: platformOrOptions }
    : (platformOrOptions ?? {});
  const platform = resolvePlatform(appPath, opts.platform);
  const checkExists = opts.checkExists ?? existsSync;

  if (platform === 'win32') {
    const cleanApp = appPath.replace(/[/\\]+$/, '') || appPath;
    const executablePath = win32.join(cleanApp, 'Antigravity.exe');
    const resourcesDir = win32.join(cleanApp, 'resources');
    const asarPath = win32.join(resourcesDir, 'app.asar');
    const asarUnpackedPath = win32.join(resourcesDir, 'app.asar.unpacked');
    const primaryLs = win32.join(resourcesDir, 'bin', 'language_server.exe');
    const fallbackLs = win32.join(resourcesDir, 'language_server.exe');
    const languageServerCandidates = [primaryLs, fallbackLs];
    const languageServerPath = checkExists(primaryLs)
      ? primaryLs
      : (checkExists(fallbackLs) ? fallbackLs : primaryLs);
    return {
      platform,
      appPath: cleanApp,
      executablePath,
      resourcesDir,
      asarPath,
      asarUnpackedPath,
      languageServerPath,
      languageServerCandidates,
    };
  }

  const cleanApp = appPath.length > 1 ? appPath.replace(/\/+$/, '') : appPath;
  const contentsDir = posix.join(cleanApp, 'Contents');
  const resourcesDir = posix.join(contentsDir, 'Resources');
  const languageServerPath = posix.join(resourcesDir, 'bin', 'language_server');
  return {
    platform,
    appPath: cleanApp,
    executablePath: posix.join(contentsDir, 'MacOS', 'Antigravity'),
    resourcesDir,
    asarPath: posix.join(resourcesDir, 'app.asar'),
    asarUnpackedPath: posix.join(resourcesDir, 'app.asar.unpacked'),
    languageServerPath,
    languageServerCandidates: [languageServerPath],
    plistPath: posix.join(contentsDir, 'Info.plist'),
    codeSignaturePath: posix.join(contentsDir, '_CodeSignature', 'CodeResources'),
  };
}

export function getControlEndpoint(
  stateDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const resolved = win32.resolve(stateDir);
    const normalized = normalizePathForCompare(resolved, 'win32');
    const digest = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\gravitybox-${digest}`;
  }
  return posix.join(stateDir, 'control.sock');
}

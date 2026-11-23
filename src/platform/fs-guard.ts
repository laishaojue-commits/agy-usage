import { chmodSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { homedir } from 'node:os';

export interface StatLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isSocket?: () => boolean;
  uid?: number;
}

export interface OwnershipCheckOptions {
  platform?: NodeJS.Platform;
  currentUid?: number;
}

function matchesPosixUid(info: StatLike, options?: OwnershipCheckOptions): boolean {
  const platform = options?.platform ?? process.platform;
  if (platform === 'win32') return true;
  const expectedUid = options?.currentUid ?? process.getuid?.();
  return info.uid === expectedUid;
}

/**
 * Verify a path stat represents a regular, non-symlink file owned by the current user.
 * Skips POSIX uid checks on Windows (where lstat.uid is 0 and process.getuid is undefined)
 * while still strictly rejecting symlinks and non-regular files.
 */
export function isOwnedByCurrentUser<T extends StatLike>(
  info: T | null | undefined,
  options?: OwnershipCheckOptions
): info is T {
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile()) return false;
  return matchesPosixUid(info, options);
}

export function isOwnedDirectoryByCurrentUser<T extends StatLike>(
  info: T | null | undefined,
  options?: OwnershipCheckOptions
): info is T {
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) return false;
  return matchesPosixUid(info, options);
}

export function isOwnedSocketByCurrentUser<T extends StatLike>(
  info: T | null | undefined,
  options?: OwnershipCheckOptions
): info is T {
  if (!info) return false;
  if (info.isSymbolicLink() || typeof info.isSocket !== 'function' || !info.isSocket()) return false;
  return matchesPosixUid(info, options);
}

export function isOwnedEntryByCurrentUser<T extends StatLike>(
  info: T | null | undefined,
  options?: OwnershipCheckOptions
): info is T {
  if (!info || info.isSymbolicLink()) return false;
  if (!info.isFile() && !info.isDirectory()) return false;
  return matchesPosixUid(info, options);
}

export async function safeChmod(
  targetPath: string,
  mode: number,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform === 'win32') return;
  await chmod(targetPath, mode);
}

export function safeChmodSync(
  targetPath: string,
  mode: number,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32') return;
  chmodSync(targetPath, mode);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact macOS/Linux home/temp paths (e.g. /Users/alice/...) and Windows drive/UNC paths
 * (e.g. C:\Users\demo\...) from user-facing messages.
 */
export function redactLocalPaths(
  msg: string,
  replacement = '[path]',
  extraEnv: NodeJS.ProcessEnv = process.env
): string {
  let out = String(msg ?? '');
  if (!out) return out;

  // Scrub active environment roots (handles usernames containing spaces on Windows/macOS).
  const envRoots = [
    extraEnv.LOCALAPPDATA,
    extraEnv.APPDATA,
    extraEnv.USERPROFILE,
    extraEnv.HOME,
    extraEnv === process.env ? homedir() : undefined,
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length >= 3)
    .map(v => v.trim());

  const uniqueRoots = Array.from(new Set(envRoots)).sort((a, b) => b.length - a.length);
  for (const root of uniqueRoots) {
    const variants = Array.from(new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\'), root.replaceAll('\\', '\\\\')]));
    for (const variant of variants) {
      const re = new RegExp(`${escapeRegExp(variant)}(?:[\\\\/][^\\s'"<>|]+)*`, 'gi');
      out = out.replace(re, replacement);
    }
  }

  // Windows extended-length device paths
  out = out.replace(/\\\\\?\\[A-Za-z]:(?:\\{1,2}|\/)[^\s'"<>|]+/g, replacement);
  // Windows UNC paths
  out = out.replace(/\\\\[^\\\s'"<>|]+\\[^\s'"<>|]+/g, replacement);
  // Windows drive-letter paths (e.g. C:\Users\demo\..., C:/Users/alice/..., D:\...)
  out = out.replace(/(?<![A-Za-z0-9_])[A-Za-z]:(?:\\{1,2}|\/)[^\s'"<>|]*/g, replacement);
  // POSIX local user / system temp / volume paths
  out = out.replace(/\/(?:Users|private|var|tmp|Volumes|home)\/[^\s'"<>|]+/g, replacement);

  return out;
}

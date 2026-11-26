import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

/** Allowed placeholder email domains for tests and docs (private domains must never be committed). */
export const ALLOWED_EMAIL_DOMAINS = new Set([
  'example.invalid',
  'example.test',
  'example.com',
  'test.com',
  'test.example',
  'antigravity.test',
  'google.test',
  'gravity.test',
  'antigravity.dev',
  'users.noreply.github.com',
]);

/** Allowed placeholder home usernames for tests and docs. */
export const ALLOWED_HOME_USERS = new Set([
  'alice',
  'bob',
  'charlie',
  'demo',
  'example',
  'fixture',
  'private',
  'sandbox',
  'shared',
  'temp',
  'test',
  'user',
]);
export const ALLOWED_MACOS_HOME_USERS = ALLOWED_HOME_USERS;

/** SHA-256 fingerprints of banned sensitive local identifiers / names (never stored in plaintext). */
export const BANNED_TOKEN_HASHES = new Set([
  '654a64a2b7a73dff84d0077181edaf215876848c834b8af2ca0f146f8b3a93d3',
  '02e2d9c306b6a3516440a9554f6138fa5639308d98f0d601c0bf9e21f2ec7576',
  'cd4133c3f081dd3c655b93dea7db240cde873b67a48f2743d087eea0262bac1a',
  '939ca8a9ad878d9e2ded9c4eef8004d1552685aaa523f0f1720f36eca3a27fa2',
]);

export const BANNED_CJK_BIGRAM_HASHES = new Set([
  'bcdaac6d7ced9038d09b70760d68791ecb03e55caa2f51f894e6c7e6e5414efd',
]);

export const BANNED_QUOTED_ALIAS_HASHES = new Set([
  '8651f50cc42532e3543e36a01dc906cff39c5474ff8f6427f1902841910c717e',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.icns', '.ico',
  '.dmg', '.zip', '.tar', '.gz', '.pdf', '.woff', '.woff2',
  '.ttf', '.otf', '.node', '.sqlite', '.db', '.bin',
]);

const SKIPPED_DIRS = new Set([
  '.git', '.agents', 'node_modules', 'dist', 'dist-mcp', 'build', '.cache',
  'vendor', 'reports', 'artifacts',
]);

const EMAIL_RE = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63})\b/g;
const RETINA_ASSET_RE = /^(?:1|2|3)x\.(?:png|jpe?g|webp|gif|svg)$/i;
const LOCAL_HOME_PATH_PATTERNS = [
  { label: '/Users', re: /(?:^|[^A-Za-z0-9_])\/Users\/([\p{L}\p{N}._-]{1,80})(?=\/|[^A-Za-z0-9._-]|$)/gu, marker: '/Users/' },
  { label: '/home', re: /(?:^|[^A-Za-z0-9_])\/home\/([\p{L}\p{N}._-]{1,80})(?=\/|[^A-Za-z0-9._-]|$)/gu, marker: '/home/' },
  { label: 'C:\\Users', re: /(?:^|[^A-Za-z0-9_])[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)([\p{L}\p{N}._-]{1,80})(?=\\|\/|[^A-Za-z0-9._-]|$)/giu, marker: 'Users' },
];
const SECRET_SYNTHETIC_EXEMPT_RE = /^(?:ya29\.|AIza|gh[pousr]_|github_pat_|sk-proj-|sk-ant-|sk-live-)(?:fixture[_-]|synthetic[_-])[a-z0-9_-]{0,75}$/i;
const WINDOWS_DRIVE_RE = /(?<![\w:/])([A-Za-z]):(?:\\{1,2}|\/)([\p{L}\p{N}_. -]{1,100})(?=\\|\/)/gu;
const PRIVATE_IP_RE = /(?<![\w.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?![\w.])/g;
const SECRET_PATTERNS = [
  { name: 'Google OAuth Client Secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,80}\b/g },
  { name: 'Google OAuth Refresh Token', re: /(?<![A-Za-z0-9_+/])1\/\/[A-Za-z0-9_-]{24,256}\b/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{12,512}\b/g },
  { name: 'Private Key Header', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, allowSynthetic: false },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, allowSynthetic: true },
  { name: 'Google OAuth Token', re: /\bya29\.[0-9A-Za-z\-_.]{24,}\b/g, allowSynthetic: true },
  { name: 'GitHub Token', re: /\b(?:gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{30,})\b/g, allowSynthetic: true },
  { name: 'API/Webhook Token', re: /\b(?:(?:sk-proj-|sk-ant-|sk-live-)[0-9A-Za-z\-_]{16,}|xox[baprs]-[0-9A-Za-z-]{16,}|AKIA[0-9A-Z]{16})\b/g, allowSynthetic: true },
];
const ASCII_TOKEN_RE = /[A-Za-z0-9]+/g;
const CJK_RUN_RE = /[\u4e00-\u9fff]{2,}/g;
const QUOTED_LITERAL_RE = /(["'`])([^"'`\r\n]{1,64})\1/g;

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function isExcludedPrivacyPath(filePath, { includeBuild = false } = {}) {
  const rel = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!rel) return true;
  if (rel === 'AGENTS.md' || rel.startsWith('licenses/')) return true;
  const segments = rel.split('/');
  if (segments.some((seg) => SKIPPED_DIRS.has(seg) && !(includeBuild && ['dist', 'dist-mcp', 'artifacts'].includes(seg)))) return true;
  if (BINARY_EXTENSIONS.has(extname(rel).toLowerCase())) return true;
  return false;
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function redactLocalPart(localPart) {
  if (localPart.length <= 2) return '*'.repeat(localPart.length);
  return `${localPart[0]}***${localPart[localPart.length - 1]}`;
}

export function scanContentForPrivacy(content, filePath, options = {}) {
  const rel = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (isExcludedPrivacyPath(rel, options) || !content || content.includes('\0')) return [];

  const allowedDomains = options.allowedDomains ?? ALLOWED_EMAIL_DOMAINS;
  const allowedHomeUsers = options.allowedHomeUsers ?? ALLOWED_MACOS_HOME_USERS;
  const tokenHashes = options.tokenHashes ?? BANNED_TOKEN_HASHES;
  const cjkBigramHashes = options.cjkBigramHashes ?? BANNED_CJK_BIGRAM_HASHES;
  const quotedAliasHashes = options.quotedAliasHashes ?? BANNED_QUOTED_ALIAS_HASHES;
  const issues = [];
  if (rel.endsWith('.html') || rel.endsWith('.js')) {
    content = content.replace(/data:image\/(?:png|jpe?g|webp|gif|x-icon|svg\+xml);base64,[A-Za-z0-9+/]+=*/gi, (m) => ' '.repeat(m.length));
  }

  for (const match of content.matchAll(EMAIL_RE)) {
    const [, localPart, domain] = match;
    if (RETINA_ASSET_RE.test(domain)) continue;
    const normalizedDomain = domain.toLowerCase();
    if (!allowedDomains.has(normalizedDomain)) {
      issues.push({
        code: 'DISALLOWED_EMAIL_DOMAIN',
        file: rel,
        line: lineNumberAt(content, match.index ?? 0),
        detail: `Disallowed email domain ${redactLocalPart(localPart)}@${normalizedDomain}`,
      });
    }
  }

  for (const { label, re, marker } of LOCAL_HOME_PATH_PATTERNS) {
    for (const match of content.matchAll(re)) {
      const username = match[1];
      if (!allowedHomeUsers.has(username.toLowerCase())) {
        const markerOffset = match[0].toLowerCase().indexOf(marker.toLowerCase());
        const pos = (match.index ?? 0) + Math.max(0, markerOffset);
        issues.push({
          code: 'DISALLOWED_LOCAL_HOME_PATH',
          file: rel,
          line: lineNumberAt(content, pos),
          detail: `Disallowed local home path ${label}/${redactLocalPart(username)}`,
        });
      }
    }
  }

  for (const match of content.matchAll(WINDOWS_DRIVE_RE)) {
    const directory = match[2].trim().toLowerCase();
    if (['users', 'windows', 'program files', 'program files (x86)', 'programdata'].includes(directory)) continue;
    if (/\.(?:test\.mjs|rs)$/.test(rel) && ['gravitybox', 'agy-usage', 'agy-usage-tool', 'fixture', 'fake', 'demo', 'test', 'temp', 'synthetic', 'apps', 'program files'].includes(directory)) continue;
    issues.push({ code: 'DISALLOWED_DRIVE_PATH', file: rel, line: lineNumberAt(content, match.index), detail: 'Suspicious absolute drive path' });
  }

  for (const match of content.matchAll(PRIVATE_IP_RE)) {
    if (match[0].split('.').some((part) => Number(part) > 255)) continue;
    if (rel === 'Cargo.lock' || rel.endsWith('package-lock.json')) continue;
    issues.push({ code: 'PRIVATE_IP_LITERAL', file: rel, line: lineNumberAt(content, match.index), detail: 'RFC1918 private IP literal' });
  }

  for (const { name, re, allowSynthetic } of SECRET_PATTERNS) {
    for (const match of content.matchAll(re)) {
      const raw = match[0];
      if (allowSynthetic && SECRET_SYNTHETIC_EXEMPT_RE.test(raw)) continue;
      issues.push({
        code: 'DISALLOWED_SECRET_LITERAL',
        file: rel,
        line: lineNumberAt(content, match.index ?? 0),
        detail: `Suspicious plaintext ${name} literal`,
      });
    }
  }

  const asciiTokens = [];
  for (const match of content.matchAll(ASCII_TOKEN_RE)) {
    const lower = match[0].toLowerCase();
    const index = match.index ?? 0;
    if (tokenHashes.has(sha256Hex(lower))) {
      issues.push({
        code: 'SENSITIVE_TOKEN_MATCH',
        file: rel,
        line: lineNumberAt(content, index),
        detail: 'Matched banned personal identifier fingerprint',
      });
    }
    asciiTokens.push({ lower, index });
    if (asciiTokens.length > 3) asciiTokens.shift();
    if (asciiTokens.length >= 3) {
      const a = asciiTokens[asciiTokens.length - 3];
      const b = asciiTokens[asciiTokens.length - 2];
      const c = asciiTokens[asciiTokens.length - 1];
      if (tokenHashes.has(sha256Hex(`${a.lower} ${b.lower} ${c.lower}`))) {
        issues.push({
          code: 'SENSITIVE_NAME_MATCH',
          file: rel,
          line: lineNumberAt(content, a.index),
          detail: 'Matched banned personal name fingerprint',
        });
      }
    }
  }

  for (const match of content.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    const baseIndex = match.index ?? 0;
    for (let i = 0; i <= run.length - 2; i++) {
      const bigram = run.slice(i, i + 2);
      if (cjkBigramHashes.has(sha256Hex(bigram))) {
        issues.push({
          code: 'SENSITIVE_CJK_NAME_MATCH',
          file: rel,
          line: lineNumberAt(content, baseIndex + i),
          detail: 'Matched banned personal CJK name fingerprint',
        });
      }
    }
  }

  for (const match of content.matchAll(QUOTED_LITERAL_RE)) {
    const literal = match[2].trim();
    if (literal && quotedAliasHashes.has(sha256Hex(literal))) {
      issues.push({
        code: 'SENSITIVE_ALIAS_MATCH',
        file: rel,
        line: lineNumberAt(content, match.index ?? 0),
        detail: 'Matched banned personal alias fingerprint',
      });
    }
  }

  issues.sort((a, b) => a.line - b.line);
  return issues;
}

async function listGitFiles(repoRoot, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\0').filter(Boolean);
}

async function walkDirectory(dir, baseRoot, options = {}) {
  const collected = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const rel = relative(baseRoot, fullPath).replaceAll('\\', '/');
    if (isExcludedPrivacyPath(rel, options)) continue;
    if (entry.isDirectory()) {
      collected.push(...(await walkDirectory(fullPath, baseRoot, options)));
    } else if (entry.isFile()) {
      collected.push(rel);
    }
  }
  return collected;
}

export async function runPrivacyCheck({ repoRoot = root, staged = false } = {}) {
  const issues = [];
  let scannedCount = 0;

  if (staged) {
    const stagedFiles = (await listGitFiles(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']))
      .filter((file) => !isExcludedPrivacyPath(file));
    for (const rel of stagedFiles) {
      let content = '';
      try {
        const { stdout } = await execFileAsync('git', ['show', `:${rel}`], {
          cwd: repoRoot,
          maxBuffer: 16 * 1024 * 1024,
        });
        content = stdout;
      } catch {
        continue;
      }
      scannedCount++;
      issues.push(...scanContentForPrivacy(content, rel));
    }
    return { scannedCount, issues };
  }

  let files;
  if (existsSync(join(repoRoot, '.git'))) {
    const tracked = await listGitFiles(repoRoot, ['ls-files', '-z']);
    const untracked = await listGitFiles(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
    files = [...new Set([...tracked, ...untracked])].filter((file) => !isExcludedPrivacyPath(file));
  } else {
    files = await walkDirectory(repoRoot, repoRoot);
  }

  for (const rel of files) {
    let content;
    try {
      content = await readFile(join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    scannedCount++;
    issues.push(...scanContentForPrivacy(content, rel));
  }

  return { scannedCount, issues };
}

export async function scanDirectoryForPrivacy(targetDir, { excludePrefixes = [], options = {} } = {}) {
  const issues = [];
  let scannedCount = 0;
  const files = await walkDirectory(targetDir, targetDir, options);
  for (const rel of files) {
    if (excludePrefixes.some((prefix) => rel.startsWith(prefix))) continue;
    let content;
    try {
      content = await readFile(join(targetDir, rel), 'utf8');
    } catch {
      continue;
    }
    scannedCount++;
    issues.push(...scanContentForPrivacy(content, rel, options));
  }
  return { scannedCount, issues };
}

function unquoteGitPath(raw) {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) {
    return trimmed;
  }
  const inner = trimmed.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const oct = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 3;
        continue;
      }
      const esc = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
      const ch = inner[i + 1];
      if (ch in esc) {
        bytes.push(esc[ch]);
        i += 1;
        continue;
      }
    }
    bytes.push(...Buffer.from(inner[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripDiffPrefix(token, prefix) {
  const unquoted = unquoteGitPath(token);
  if (unquoted === '/dev/null') return null;
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

function parseDiffGitLine(line) {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === '\\') {
        i += 2;
        continue;
      }
      if (rest[i] === '"') {
        i++;
        break;
      }
      i++;
    }
    const bPart = rest.slice(i).trim();
    return stripDiffPrefix(bPart, 'b/') ?? stripDiffPrefix(rest.slice(0, i), 'a/');
  }
  const quotedBIdx = rest.indexOf(' "b/');
  if (quotedBIdx >= 0) {
    return stripDiffPrefix(rest.slice(quotedBIdx + 1), 'b/');
  }
  for (let idx = rest.indexOf(' b/'); idx >= 0; idx = rest.indexOf(' b/', idx + 1)) {
    const aPath = rest.slice(0, idx);
    const bPath = rest.slice(idx + 1);
    if (aPath.startsWith('a/') && bPath.startsWith('b/') && aPath.slice(2) === bPath.slice(2)) {
      return bPath.slice(2);
    }
  }
  const lastBIdx = rest.lastIndexOf(' b/');
  if (lastBIdx >= 0) {
    return stripDiffPrefix(rest.slice(lastBIdx + 1), 'b/');
  }
  return null;
}

export function splitGitPatchByFile(patch) {
  if (!patch || typeof patch !== 'string') return [];
  const rawSections = patch.split(/(?=^diff --git )/m).filter(Boolean);
  const sections = [];
  for (const section of rawSections) {
    if (!section.startsWith('diff --git ')) {
      if (section.trim()) {
        sections.push({ filePath: 'patch-preamble', content: section });
      }
      continue;
    }
    const lines = section.split(/\r?\n/);
    const diffLinePath = parseDiffGitLine(lines[0]);
    let plusPath = null;
    let minusPath = null;
    let renameToPath = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('@@ ') || line === '@@' || line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
        break;
      }
      if (line.startsWith('+++ ')) {
        plusPath = stripDiffPrefix(line.slice(4), 'b/');
      } else if (line.startsWith('--- ')) {
        minusPath = stripDiffPrefix(line.slice(4), 'a/');
      } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
        renameToPath = unquoteGitPath(line.slice(line.indexOf(' to ') + 4));
      }
    }
    const filePath = (plusPath ?? renameToPath ?? minusPath ?? diffLinePath ?? 'unknown.diff')
      .replaceAll('\\', '/')
      .replace(/^\.\//, '');
    sections.push({ filePath, content: section });
  }
  return sections;
}

export async function scanGitHistory(repoRoot = root) {
  if (!existsSync(join(repoRoot, '.git'))) {
    return { scannedCount: 0, issues: [] };
  }
  const git = (args) => execFileAsync('git', args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout);
  const hashes = (await git(['rev-list', '--all', '--reflog']).catch(() => '')).split(/\s+/).filter(Boolean);
  const issues = [];
  for (const hash of hashes) {
    const label = 'history/' + hash.slice(0, 12);
    const meta = await git(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', hash]);
    const [_author, authorEmail, _committer, committerEmail] = meta.split('\0');
    if (![authorEmail, committerEmail].every((email) => /^[^@\s]+@users\.noreply\.github\.com$/i.test(email ?? ''))) {
      issues.push({ file: label, line: 1, code: 'NONPUBLIC_GIT_IDENTITY', detail: 'Commit author/committer email is not a public noreply address' });
    }
    issues.push(...scanContentForPrivacy(meta.replaceAll('\0', '\n'), label));
    const patch = await git(['-c', 'core.quotePath=false', 'show', '--format=', '--no-ext-diff', '--no-textconv', '-p', '-m', hash]);
    for (const { filePath, content: section } of splitGitPatchByFile(patch)) {
      const sectionIssues = scanContentForPrivacy(section, filePath, { includeBuild: true });
      for (const issue of sectionIssues) {
        issues.push({
          ...issue,
          file: `${label}:${filePath}`,
        });
      }
    }
  }
  const tagObjects = await git(['for-each-ref', '--format=%(refname)%09%(taggeremail)%09%(contents:subject)', 'refs/tags']).catch(() => '');
  issues.push(...scanContentForPrivacy(tagObjects, 'history/tags'));
  return { scannedCount: hashes.length, issues };
}

async function main() {
  const staged = process.argv.includes('--staged');
  const result = await runPrivacyCheck({ repoRoot: root, staged });
  if (process.argv.includes('--include-build')) {
    for (const dir of ['dist', 'ui/dist-mcp', 'artifacts/agy-usage-tool']) {
      if (!existsSync(join(root, dir))) continue;
      const built = await scanDirectoryForPrivacy(join(root, dir), { options: { includeBuild: true } });
      result.scannedCount += built.scannedCount;
      result.issues.push(...built.issues.map((issue) => ({ ...issue, file: dir + '/' + issue.file })));
    }
  }
  if (process.argv.includes('--git-history')) {
    const history = await scanGitHistory(root);
    result.scannedCount += history.scannedCount;
    result.issues.push(...history.issues);
  }
  if (result.issues.length > 0) {
    process.stderr.write(`❌ [privacy-gate] Found ${result.issues.length} potential privacy/secret issue(s) across ${result.scannedCount} scanned items:\n`);
    for (const issue of result.issues.slice(0, 50)) {
      process.stderr.write(`  - ${issue.file}:${issue.line} [${issue.code}]\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✅ [privacy-gate] Passed (${result.scannedCount} ${staged ? 'staged' : 'workspace'} items scanned, 0 issues)\n`);
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[privacy-gate] Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

import { realpathSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Removes orphan compiled artifacts (.js / .js.map / .d.ts / .d.ts.map) in `dist/`
 * that no longer correspond to a source `.ts` file under `src/`.
 */
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const DIST_ARTIFACT_RE = /\.(?:js|d\.ts)(?:\.map)?$/;

function toJsStem(file) {
  return file.replace(/\.(?:js\.map|d\.ts\.map|d\.ts)$/, '.js');
}

async function listFiles(dir) {
  const result = [];
  async function walk(relative = '') {
    let entries;
    try {
      entries = await readdir(join(dir, relative), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const next = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.push(next.split('\\').join('/'));
    }
  }
  await walk();
  return result;
}

export async function planDistCleanup({ projectRoot = defaultRoot, srcDir = 'src', distDir = 'dist', whitelist = [] } = {}) {
  const srcFiles = (await listFiles(join(projectRoot, srcDir))).filter((file) => file.endsWith('.ts'));
  const expected = new Set(srcFiles.map((file) => file.replace(/\.ts$/, '.js')));
  const keep = new Set(whitelist);
  const distFiles = (await listFiles(join(projectRoot, distDir))).filter((file) => DIST_ARTIFACT_RE.test(file));
  const orphans = distFiles
    .filter((file) => {
      const stemJs = toJsStem(file);
      return !expected.has(stemJs) && !keep.has(file) && !keep.has(stemJs);
    })
    .sort();
  return { expected: [...expected].sort(), whitelist: [...keep], orphans };
}

export async function cleanDist(options = {}) {
  const plan = await planDistCleanup(options);
  const projectRoot = options.projectRoot ?? defaultRoot;
  const distDir = options.distDir ?? 'dist';
  for (const relative of plan.orphans) {
    await rm(join(projectRoot, distDir, ...relative.split('/')), { force: true });
  }
  return { ...plan, removed: plan.orphans };
}

function isDirectRun(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  try {
    return norm(realpathSync(entry)) === norm(realpathSync(fileURLToPath(metaUrl)));
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const plan = dryRun ? await planDistCleanup() : await cleanDist();
  if (!plan.orphans.length) process.stdout.write('dist matches src; no orphan files\n');
  else {
    for (const file of plan.orphans) {
      process.stdout.write(`${dryRun ? 'Would remove' : 'Removed'} dist/${file} (no matching src)\n`);
    }
  }
}

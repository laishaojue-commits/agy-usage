import { inspectPluginBackend } from './plugin-allowlist.mjs';
import { scanDirectoryForPrivacy } from './check-privacy.mjs';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function normalizePathCompare(targetPath) {
  const resolved = resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function getDefaultPluginPaths(homeDir = homedir()) {
  const pluginsRoot = join(resolve(homeDir), '.gemini', 'config', 'plugins');
  const legacyDir = resolve(join(pluginsRoot, 'gravitybox'));
  const legacyAgyUsageDir = resolve(join(pluginsRoot, 'agy-usage'));
  return {
    pluginsRoot,
    dest: resolve(join(pluginsRoot, 'agy-usage-tool')),
    legacyDir,
    legacyDirs: [legacyDir, legacyAgyUsageDir],
  };
}

const LEGACY_MANAGED_MARKER_FILE = '.agy-usage-tool-managed-legacy.json';

async function cleanupLegacyPluginDir(legacyDir, rmImpl = rm) {
  if (!existsSync(legacyDir)) {
    return { dir: legacyDir, removed: false, manifestRemoved: false, locked: false };
  }
  const manifestPath = join(legacyDir, 'plugin.json');
  const legacyPkgPath = join(legacyDir, 'package.json');
  const legacyMarkerPath = join(legacyDir, LEGACY_MANAGED_MARKER_FILE);
  const expectedName = basename(legacyDir);

  let isLegacyPlugin = false;
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      isLegacyPlugin = manifest?.name === 'gravitybox' || manifest?.name === 'agy-usage';
    } catch {
      return { dir: legacyDir, removed: false, manifestRemoved: false, locked: false };
    }
  } else if (existsSync(legacyMarkerPath)) {
    try {
      const marker = JSON.parse(await readFile(legacyMarkerPath, 'utf8'));
      isLegacyPlugin =
        marker?.managedBy === 'agy-usage-tool-installer' &&
        (marker?.plugin === 'gravitybox' || marker?.plugin === 'agy-usage');
    } catch {
      return { dir: legacyDir, removed: false, manifestRemoved: false, locked: false };
    }
  } else if (existsSync(legacyPkgPath)) {
    try {
      const legacyPkg = JSON.parse(await readFile(legacyPkgPath, 'utf8'));
      isLegacyPlugin =
        legacyPkg?.name === 'gravitybox-mcp-plugin' ||
        legacyPkg?.name === 'agy-usage' ||
        legacyPkg?.name === 'agy-usage-mcp-plugin';
    } catch {
      return { dir: legacyDir, removed: false, manifestRemoved: false, locked: false };
    }
  } else {
    const entries = await readdir(legacyDir).catch(() => null);
    if (Array.isArray(entries) && entries.length === 0 && (expectedName === 'gravitybox' || expectedName === 'agy-usage')) {
      isLegacyPlugin = true;
    }
  }

  if (!isLegacyPlugin) {
    return { dir: legacyDir, removed: false, manifestRemoved: false, locked: false };
  }

  try {
    await rmImpl(legacyDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    return { dir: legacyDir, removed: !existsSync(legacyDir), manifestRemoved: !existsSync(manifestPath), locked: false };
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY')
    ) {
      await rmImpl(manifestPath, { force: true }).catch(() => {});
      await rmImpl(join(legacyDir, 'mcp_config.json'), { force: true }).catch(() => {});
      await writeFile(
        legacyMarkerPath,
        JSON.stringify({ managedBy: 'agy-usage-tool-installer', plugin: expectedName }, null, 2) + '\n',
        'utf8'
      ).catch(() => {});
      return {
        dir: legacyDir,
        removed: !existsSync(legacyDir),
        manifestRemoved: !existsSync(manifestPath),
        locked: existsSync(legacyDir),
      };
    }
    throw err;
  }
}

function runNpm(args, cwd = repoRoot) {
  if (process.platform === 'win32') {
    return execFileAsync('cmd.exe', ['/d', '/c', 'npm', ...args], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  return execFileAsync('npm', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function ensurePluginDeps() {
  const sdkDir = join(repoRoot, 'plugin', 'node_modules', '@modelcontextprotocol', 'sdk');
  if (existsSync(sdkDir)) return;
  const hasLock = existsSync(join(repoRoot, 'plugin', 'package-lock.json'));
  const args = hasLock
    ? ['--prefix', 'plugin', 'ci', '--omit=dev', '--ignore-scripts']
    : ['--prefix', 'plugin', 'install', '--omit=dev', '--ignore-scripts'];
  await runNpm(args, repoRoot);
}

async function ensureUiMcpDeps() {
  const extAppsDir = join(repoRoot, 'ui', 'node_modules', '@modelcontextprotocol', 'ext-apps');
  const singlefileDir = join(repoRoot, 'ui', 'node_modules', 'vite-plugin-singlefile');
  if (existsSync(extAppsDir) && existsSync(singlefileDir)) return;
  const hasLock = existsSync(join(repoRoot, 'ui', 'package-lock.json'));
  const args = hasLock
    ? ['--prefix', 'ui', 'ci', '--ignore-scripts']
    : ['--prefix', 'ui', 'install', '--ignore-scripts'];
  await runNpm(args, repoRoot);
}

async function ensurePluginLogo() {
  const srcLogo = join(repoRoot, 'assets', 'master-1024.png');
  const dstLogo = join(repoRoot, 'plugin', 'assets', 'logo.png');
  await mkdir(dirname(dstLogo), { recursive: true });
  await copyFile(srcLogo, dstLogo);
}

export async function buildPluginArtifacts() {
  await ensureUiMcpDeps();
  await ensurePluginDeps();
  await ensurePluginLogo();
  await runNpm(['run', 'build'], repoRoot);
  await runNpm(['run', 'ui:build'], repoRoot);

  const htmlPath = join(repoRoot, 'ui', 'dist-mcp', 'mcp-app.html');
  const htmlStat = await stat(htmlPath);
  if (!htmlStat.isFile() || htmlStat.size === 0) {
    throw new Error(`Missing or empty single-file MCP App build artifact: ${htmlPath}`);
  }
  return {
    htmlPath,
    htmlBytes: htmlStat.size,
  };
}

const SIBLING_STAGE_DIR_NAME = '.agy-usage-tool-install-stage';
const LEGACY_SIBLING_STAGE_DIR_NAME = '.agy-usage-install-stage';
const MANAGED_BACKUP_DIR_RE = /^stage-\d+-\d+-previous$/;
const MANAGED_BACKUP_MARKER_FILE = '.agy-usage-tool-managed-backup.json';
const LEGACY_MANAGED_BACKUP_MARKER_FILE = '.agy-usage-managed-backup.json';
const MANAGED_BACKUP_MARKER = {
  managedBy: 'agy-usage-tool-installer',
  plugin: 'agy-usage-tool',
};
const VALID_PLUGIN_NAMES = new Set(['agy-usage-tool', 'agy-usage']);

async function readJsonIfRegularFile(filePath) {
  try {
    const st = await lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Verifies that a backup directory inside `.agy-usage-tool-install-stage` is a non-symlink
 * directory carrying explicit ownership proof from `agy-usage-tool` (or legacy `agy-usage`) installer.
 */
export async function isManagedAgyUsageBackup(entryPath) {
  const st = await lstat(entryPath).catch(() => null);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;

  const manifest = await readJsonIfRegularFile(join(entryPath, 'plugin.json'));
  if (manifest && typeof manifest.name === 'string') {
    return VALID_PLUGIN_NAMES.has(manifest.name);
  }

  for (const markerFile of [MANAGED_BACKUP_MARKER_FILE, LEGACY_MANAGED_BACKUP_MARKER_FILE]) {
    const marker = await readJsonIfRegularFile(join(entryPath, markerFile));
    if (
      (marker?.managedBy === MANAGED_BACKUP_MARKER.managedBy || marker?.managedBy === 'agy-usage-installer') &&
      VALID_PLUGIN_NAMES.has(marker?.plugin)
    ) {
      return true;
    }
  }

  const pkg = await readJsonIfRegularFile(join(entryPath, 'package.json'));
  const backendPkg = await readJsonIfRegularFile(join(entryPath, 'backend', 'package.json'));
  if (
    (pkg?.name === 'agy-usage-tool' || pkg?.name === 'agy-usage-mcp-plugin' || pkg?.name === 'agy-usage') &&
    (backendPkg?.name === 'agy-usage-tool-backend' || backendPkg?.name === 'agy-usage-backend')
  ) {
    return true;
  }

  return false;
}

async function stripManifestsAndMarkLockedBackup(backupDir, rmImpl = rm) {
  await rmImpl(join(backupDir, 'plugin.json'), { force: true }).catch(() => {});
  await rmImpl(join(backupDir, 'mcp_config.json'), { force: true }).catch(() => {});
  await writeFile(
    join(backupDir, MANAGED_BACKUP_MARKER_FILE),
    JSON.stringify(MANAGED_BACKUP_MARKER, null, 2) + '\n',
    'utf8'
  ).catch(() => {});
}

const NON_SIBLING_MANAGED_BACKUP_RE = /^\.agy-usage-tool-plugin-stage-\d+-\d+-previous$/;

async function cleanupStaleBackups(stageRoot, excludeNames = new Set(), rmImpl = rm) {
  const base = basename(stageRoot);
  if (base !== SIBLING_STAGE_DIR_NAME && base !== LEGACY_SIBLING_STAGE_DIR_NAME) return;
  const entries = await readdir(stageRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || excludeNames.has(entry.name)) continue;
    if (!MANAGED_BACKUP_DIR_RE.test(entry.name)) continue;
    const entryPath = join(stageRoot, entry.name);
    if (!(await isManagedAgyUsageBackup(entryPath))) continue;
    await rmImpl(entryPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 }).catch(async () => {
      await stripManifestsAndMarkLockedBackup(entryPath, rmImpl);
    });
  }
}

async function cleanupNonSiblingBackups(parentDir, excludeNames = new Set(), rmImpl = rm) {
  const entries = await readdir(parentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || excludeNames.has(entry.name)) continue;
    if (!NON_SIBLING_MANAGED_BACKUP_RE.test(entry.name)) continue;
    const entryPath = join(parentDir, entry.name);
    if (!(await isManagedAgyUsageBackup(entryPath))) continue;
    await rmImpl(entryPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 }).catch(async () => {
      await stripManifestsAndMarkLockedBackup(entryPath, rmImpl);
    });
  }
}

async function validateInstallDestination(dest) {
  const existing = await lstat(dest).catch((err) => {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  });
  if (!existing) return null;
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error(`Invalid plugin destination: ${dest}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dest, 'plugin.json'), 'utf8'));
  } catch {
    throw new Error(`Destination does not contain an agy-usage-tool installation: ${dest}`);
  }
  if (manifest?.name !== 'agy-usage-tool') {
    throw new Error(`Destination does not contain an agy-usage-tool installation: ${dest}`);
  }
  return existing;
}

async function resolveStageRoot(parentDir) {
  if (basename(parentDir).toLowerCase() === 'plugins' && dirname(parentDir) !== parentDir) {
    const siblingStage = join(dirname(parentDir), SIBLING_STAGE_DIR_NAME);
    try {
      const existing = await lstat(siblingStage).catch((err) => {
        if (err && err.code === 'ENOENT') return null;
        throw err;
      });
      if (existing) {
        if (existing.isDirectory() && !existing.isSymbolicLink()) {
          return { stageRoot: siblingStage, usingSiblingStage: true };
        }
        return { stageRoot: parentDir, usingSiblingStage: false };
      }
      await mkdir(siblingStage, { recursive: true });
      return { stageRoot: siblingStage, usingSiblingStage: true };
    } catch {
      return { stageRoot: parentDir, usingSiblingStage: false };
    }
  }
  return { stageRoot: parentDir, usingSiblingStage: false };
}

export async function installPlugin(options = {}) {
  const renameImpl = options._rename ?? rename;
  const rmImpl = options._rm ?? rm;
  const defaults = getDefaultPluginPaths(options.homeDir ?? homedir());
  const dest = resolve(
    options.dest ||
      process.env.AGY_USAGE_PLUGIN_DEST ||
      process.env.GRAVITYBOX_PLUGIN_DEST ||
      defaults.dest
  );
  const isDefaultInstall = normalizePathCompare(dest) === normalizePathCompare(defaults.dest);

  // Validate target upfront before building, staging, or touching any existing rollback backups.
  await validateInstallDestination(dest);

  const doBuild = options.build !== false;
  const buildInfo = doBuild
    ? await buildPluginArtifacts()
    : {
        htmlPath: join(repoRoot, 'ui', 'dist-mcp', 'mcp-app.html'),
        htmlBytes: (await stat(join(repoRoot, 'ui', 'dist-mcp', 'mcp-app.html'))).size,
      };

  const rootPkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const parentDir = dirname(dest);
  await mkdir(parentDir, { recursive: true });

  const { stageRoot, usingSiblingStage } = await resolveStageRoot(parentDir);
  const stagePrefix = usingSiblingStage ? 'stage-' : '.agy-usage-tool-plugin-stage-';
  const stagingDir = join(stageRoot, `${stagePrefix}${process.pid}-${Date.now()}`);
  try {
    await mkdir(join(stagingDir, 'assets'), { recursive: true });
    await mkdir(join(stagingDir, 'bin'), { recursive: true });
    await mkdir(join(stagingDir, 'ui'), { recursive: true });
    await mkdir(join(stagingDir, 'backend', 'assets'), { recursive: true });

    await copyFile(join(repoRoot, 'plugin', 'plugin.json'), join(stagingDir, 'plugin.json'));
    await copyFile(join(repoRoot, 'plugin', 'mcp_config.json'), join(stagingDir, 'mcp_config.json'));
    await copyFile(join(repoRoot, 'plugin', 'README.md'), join(stagingDir, 'README.md'));
    await copyFile(join(repoRoot, 'plugin', 'package.json'), join(stagingDir, 'package.json'));
    if (existsSync(join(repoRoot, 'plugin', 'package-lock.json'))) {
      await copyFile(join(repoRoot, 'plugin', 'package-lock.json'), join(stagingDir, 'package-lock.json'));
    }
    await copyFile(join(repoRoot, 'plugin', 'assets', 'logo.png'), join(stagingDir, 'assets', 'logo.png'));
    await copyFile(join(repoRoot, 'plugin', 'bin', 'server.mjs'), join(stagingDir, 'bin', 'server.mjs'));
    await copyFile(buildInfo.htmlPath, join(stagingDir, 'ui', 'mcp-app.html'));

    await cp(join(repoRoot, 'plugin', 'node_modules'), join(stagingDir, 'node_modules'), {
      recursive: true,
      dereference: true,
    });

    await writeFile(
      join(stagingDir, 'backend', 'package.json'),
      JSON.stringify(
        {
          name: 'agy-usage-tool-backend',
          version: rootPkg.version,
          private: true,
          type: 'module',
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    const sourceDist = join(repoRoot, 'dist');
    const modules = await inspectPluginBackend(sourceDist, join(stagingDir, 'bin', 'server.mjs'));
    for (const file of modules) {
      const target = join(stagingDir, 'backend', 'dist', file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(sourceDist, file), target);
    }
    await copyFile(join(repoRoot, 'LICENSE'), join(stagingDir, 'LICENSE'));
    await copyFile(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), join(stagingDir, 'THIRD_PARTY_NOTICES.md'));
    await cp(join(repoRoot, 'assets', 'i18n'), join(stagingDir, 'backend', 'assets', 'i18n'), {
      recursive: true,
    });
    const catalogSrc = join(repoRoot, 'assets', 'model-catalog.json');
    if (existsSync(catalogSrc)) {
      await copyFile(catalogSrc, join(stagingDir, 'backend', 'assets', 'model-catalog.json'));
    }

    const privacy = await scanDirectoryForPrivacy(stagingDir, { options: { includeBuild: true } });
    if (privacy.issues.length) {
      throw Error('Plugin privacy gate failed: ' + privacy.issues.slice(0, 8).map((issue) => issue.file + ':' + issue.line + ' ' + issue.code).join(', '));
    }

    const existing = await validateInstallDestination(dest);
    const backup = stagingDir + '-previous';
    let movedToBackup = false;
    let inPlaceUpdated = false;
    if (existing) {
      try {
        await renameImpl(dest, backup);
        movedToBackup = true;
      } catch (renameErr) {
        if (renameErr && typeof renameErr === 'object' && (renameErr.code === 'EBUSY' || renameErr.code === 'EPERM')) {
          await rmImpl(join(dest, 'backend', 'dist'), { recursive: true, force: true });
          await cp(stagingDir, dest, { recursive: true, force: true });
          await rmImpl(stagingDir, { recursive: true, force: true }).catch(() => {});
          inPlaceUpdated = true;
        } else {
          throw renameErr;
        }
      }
    }
    if (!inPlaceUpdated) {
      try {
        await renameImpl(stagingDir, dest);
      } catch (error) {
        if (movedToBackup) {
          try {
            await renameImpl(backup, dest);
          } catch (rollbackError) {
            throw new Error(
              `Failed to activate staged plugin at ${dest} (${error?.message || String(error)}) and rollback failed (${rollbackError?.message || String(rollbackError)}); preserved backup at ${backup}`,
              { cause: error }
            );
          }
        }
        throw error;
      }
    }
    if (movedToBackup) {
      await rmImpl(backup, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 }).catch(async () => {
        await stripManifestsAndMarkLockedBackup(backup, rmImpl);
        process.stderr.write(`[plugin] Previous managed backup was retained at ${backup}\n`);
      });
    }
    if (usingSiblingStage) {
      await cleanupStaleBackups(
        stageRoot,
        movedToBackup ? new Set([basename(backup)]) : new Set(),
        rmImpl
      );
      const legacyStage = join(dirname(stageRoot), LEGACY_SIBLING_STAGE_DIR_NAME);
      if (existsSync(legacyStage)) {
        await cleanupStaleBackups(legacyStage, new Set(), rmImpl);
        await rmdir(legacyStage).catch(() => {});
      }
    } else {
      await cleanupNonSiblingBackups(
        stageRoot,
        movedToBackup ? new Set([basename(backup)]) : new Set(),
        rmImpl
      );
    }

    const legacyResults = isDefaultInstall
      ? await Promise.all(defaults.legacyDirs.map((dir) => cleanupLegacyPluginDir(dir, rmImpl)))
      : [];
    const removedLegacyDirs = legacyResults.filter((r) => r.removed).map((r) => r.dir);
    const legacyCleanupPendingDirs = legacyResults.filter((r) => r.locked).map((r) => r.dir);

    return {
      dest,
      version: rootPkg.version,
      htmlBytes: buildInfo.htmlBytes,
      removedLegacyDir: removedLegacyDirs[0] ?? null,
      legacyCleanupPending: legacyCleanupPendingDirs[0] ?? null,
      removedLegacyDirs,
      legacyCleanupPendingDirs,
    };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    if (usingSiblingStage) {
      await rmdir(stageRoot).catch(() => {});
    }
  }
}

function parseDestArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dest') {
      const val = args[i + 1];
      if (!val || val.startsWith('-')) {
        throw new Error('Missing destination path after --dest');
      }
      return val;
    }
    if (arg.startsWith('--dest=')) {
      const val = arg.slice('--dest='.length);
      if (!val || val.startsWith('-')) {
        throw new Error('Missing destination path after --dest=');
      }
      return val;
    }
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const buildOnly = args.includes('--build-only');
  const noBuild = args.includes('--no-build');
  const dest = parseDestArg(args);

  if (buildOnly) {
    const info = await installPlugin({ dest: resolve(repoRoot, 'artifacts', 'agy-usage-tool'), build: !noBuild });
    process.stdout.write('[plugin:build] OK: artifacts/agy-usage-tool (UI: ' + info.htmlBytes + ' bytes)\n');
    return;
  }

  const res = await installPlugin({ dest, build: !noBuild });
  process.stdout.write(
    `[plugin:install] OK: agy-usage-tool v${res.version} installed to ${res.dest} (ui/mcp-app.html: ${res.htmlBytes} bytes)\n`
  );
  for (const dir of res.removedLegacyDirs) {
    process.stdout.write(`[plugin:install] Removed legacy plugin directory: ${dir}\n`);
  }
  for (const dir of res.legacyCleanupPendingDirs) {
    process.stderr.write(
      `[plugin:install] Warning: legacy plugin manifests removed, but directory is still locked by an active process: ${dir}\n`
    );
  }
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[plugin] Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

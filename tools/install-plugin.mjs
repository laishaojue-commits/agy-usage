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
  return {
    pluginsRoot,
    dest: resolve(join(pluginsRoot, 'agy-usage')),
    legacyDir: resolve(join(pluginsRoot, 'gravitybox')),
  };
}

async function cleanupLegacyGravityBoxPlugin(legacyDir) {
  if (!existsSync(legacyDir)) {
    return { removed: false, manifestRemoved: false, locked: false };
  }
  const manifestPath = join(legacyDir, 'plugin.json');
  const legacyPkgPath = join(legacyDir, 'package.json');

  let isLegacyPlugin = false;
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      isLegacyPlugin = manifest?.name === 'gravitybox';
    } catch {
      return { removed: false, manifestRemoved: false, locked: false };
    }
  } else if (existsSync(legacyPkgPath)) {
    try {
      const legacyPkg = JSON.parse(await readFile(legacyPkgPath, 'utf8'));
      isLegacyPlugin = legacyPkg?.name === 'gravitybox-mcp-plugin';
    } catch {
      return { removed: false, manifestRemoved: false, locked: false };
    }
  }

  if (!isLegacyPlugin) {
    return { removed: false, manifestRemoved: false, locked: false };
  }

  try {
    await rm(legacyDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    return { removed: !existsSync(legacyDir), manifestRemoved: !existsSync(manifestPath), locked: false };
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY')
    ) {
      await rm(manifestPath, { force: true }).catch(() => {});
      await rm(join(legacyDir, 'mcp_config.json'), { force: true }).catch(() => {});
      return {
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

const SIBLING_STAGE_DIR_NAME = '.agy-usage-install-stage';
const MANAGED_BACKUP_DIR_RE = /^stage-\d+-\d+-previous$/;
const MANAGED_BACKUP_MARKER_FILE = '.agy-usage-managed-backup.json';
const MANAGED_BACKUP_MARKER = {
  managedBy: 'agy-usage-installer',
  plugin: 'agy-usage',
};

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
 * Verifies that a backup directory inside `.agy-usage-install-stage` is a non-symlink
 * directory carrying explicit ownership proof from `agy-usage` installer.
 */
export async function isManagedAgyUsageBackup(entryPath) {
  const st = await lstat(entryPath).catch(() => null);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;

  const manifest = await readJsonIfRegularFile(join(entryPath, 'plugin.json'));
  if (manifest && typeof manifest.name === 'string') {
    return manifest.name === 'agy-usage';
  }

  const marker = await readJsonIfRegularFile(join(entryPath, MANAGED_BACKUP_MARKER_FILE));
  if (
    marker?.managedBy === MANAGED_BACKUP_MARKER.managedBy &&
    marker?.plugin === MANAGED_BACKUP_MARKER.plugin
  ) {
    return true;
  }

  const pkg = await readJsonIfRegularFile(join(entryPath, 'package.json'));
  const backendPkg = await readJsonIfRegularFile(join(entryPath, 'backend', 'package.json'));
  if (
    (pkg?.name === 'agy-usage-mcp-plugin' || pkg?.name === 'agy-usage') &&
    backendPkg?.name === 'agy-usage-backend'
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

async function cleanupStaleBackups(stageRoot, excludeNames = new Set(), rmImpl = rm) {
  if (basename(stageRoot) !== SIBLING_STAGE_DIR_NAME) return;
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
    throw new Error(`Destination does not contain an agy-usage installation: ${dest}`);
  }
  if (manifest?.name !== 'agy-usage') {
    throw new Error(`Destination does not contain an agy-usage installation: ${dest}`);
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
  const stagePrefix = usingSiblingStage ? 'stage-' : '.agy-usage-plugin-stage-';
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
          name: 'agy-usage-backend',
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
    for (const assetFile of ['model-catalog.json', 'pricing-feed.json']) {
      const srcAsset = join(repoRoot, 'assets', assetFile);
      if (existsSync(srcAsset)) {
        await copyFile(srcAsset, join(stagingDir, 'backend', 'assets', assetFile));
      }
    }

    const privacy = await scanDirectoryForPrivacy(stagingDir, { options: { includeBuild: true } });
    if (privacy.issues.length) {
      throw Error('Plugin privacy gate failed: ' + privacy.issues.slice(0, 8).map((issue) => issue.file + ':' + issue.line + ' ' + issue.code).join(', '));
    }

    const existing = await validateInstallDestination(dest);
    const backup = stagingDir + '-previous';
    let movedToBackup = false;
    if (existing) {
      await renameImpl(dest, backup);
      movedToBackup = true;
    }
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
    }

    const legacyResult = isDefaultInstall
      ? await cleanupLegacyGravityBoxPlugin(defaults.legacyDir)
      : { removed: false, manifestRemoved: false, locked: false };

    return {
      dest,
      version: rootPkg.version,
      htmlBytes: buildInfo.htmlBytes,
      removedLegacyDir: legacyResult.removed ? defaults.legacyDir : null,
      legacyCleanupPending: legacyResult.locked ? defaults.legacyDir : null,
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

async function main() {
  const args = process.argv.slice(2);
  const buildOnly = args.includes('--build-only');
  const noBuild = args.includes('--no-build');
  const destIdx = args.indexOf('--dest');
  const dest = destIdx >= 0 ? args[destIdx + 1] : undefined;

  if (buildOnly) {
    const info = await installPlugin({ dest: resolve(repoRoot, 'artifacts', 'agy-usage'), build: !noBuild });
    process.stdout.write('[plugin:build] OK: artifacts/agy-usage (UI: ' + info.htmlBytes + ' bytes)\n');
    return;
  }

  const res = await installPlugin({ dest, build: !noBuild });
  process.stdout.write(
    `[plugin:install] OK: agy-usage v${res.version} installed to ${res.dest} (ui/mcp-app.html: ${res.htmlBytes} bytes)\n`
  );
  if (res.removedLegacyDir) {
    process.stdout.write(
      `[plugin:install] Removed legacy gravitybox plugin directory: ${res.removedLegacyDir}\n`
    );
  } else if (res.legacyCleanupPending) {
    process.stderr.write(
      `[plugin:install] Warning: legacy plugin manifests removed, but directory is still locked by an active process: ${res.legacyCleanupPending}\n`
    );
  }
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[plugin] Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

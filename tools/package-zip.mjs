import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { scanDirectoryForPrivacy } from './check-privacy.mjs';
import { installPlugin } from './install-plugin.mjs';
import { inspectPluginBackend } from './plugin-allowlist.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const FIXED_ARCHIVE_DATE = new Date('2026-01-01T00:00:00Z');

function toDosDateTime(date = FIXED_ARCHIVE_DATE) {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  return { dosDate, dosTime };
}

async function collectBundleFiles(rootDir) {
  const results = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      const st = await lstat(fullPath);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing symlink inside bundle: ${fullPath}`);
      }
      if (entry.name === '.git') {
        throw new Error(`Refusing .git entry inside bundle: ${fullPath}`);
      }
      if (st.isDirectory()) {
        await walk(fullPath);
      } else if (st.isFile()) {
        results.push({
          relPath: relative(rootDir, fullPath).replaceAll('\\', '/'),
          fullPath,
        });
      }
    }
  }
  await walk(rootDir);
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results;
}

/**
 * Builds a deterministic, cross-platform PKZIP archive from a verified directory
 * without relying on OS-specific `zip` or PowerShell binaries.
 */
export async function createZipArchive(sourceDir, outZipPath) {
  const files = await collectBundleFiles(sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const item of files) {
    const raw = await readFile(item.fullPath);
    const compressed = deflateRawSync(raw, { level: 6 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(item.relPath, 'utf8');
    const { dosDate, dosTime } = toDosDateTime(FIXED_ARCHIVE_DATE);
    const utf8Flag = 0x0800;

    // Local file header (30 bytes + filename)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed: 2.0
    lfh.writeUInt16LE(utf8Flag, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    // Central directory header (46 bytes + filename)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4); // version made by: Unix
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(utf8Flag, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    const posixMode = item.relPath === 'bin/server.mjs' ? 0o755 : 0o644;
    cdh.writeUInt32LE(((0o100000 | posixMode) << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset, 42);

    localParts.push(lfh, nameBuf, payload);
    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  if (files.length > 0xffff || offset > 0xffffffff || centralDirBuf.length > 0xffffffff) {
    throw new Error('Archive exceeds ZIP32 limits');
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const archiveBuf = Buffer.concat([...localParts, centralDirBuf, eocd]);
  await mkdir(resolve(outZipPath, '..'), { recursive: true });
  await writeFile(outZipPath, archiveBuf);
  return {
    zipPath: outZipPath,
    fileCount: files.length,
    bytes: archiveBuf.length,
    entries: files.map((f) => f.relPath),
  };
}

async function verifyBackendDistParity(bundleDir) {
  const backendDistDir = join(bundleDir, 'backend', 'dist');
  const distStat = await lstat(backendDistDir).catch((err) => {
    if (err && err.code === 'ENOENT') {
      throw new Error(`Missing backend dist directory: ${backendDistDir}`);
    }
    throw err;
  });
  if (!distStat.isDirectory() || distStat.isSymbolicLink()) {
    throw new Error(`Invalid backend dist directory: ${backendDistDir}`);
  }

  const verifiedModules = await inspectPluginBackend(
    backendDistDir,
    join(bundleDir, 'bin', 'server.mjs')
  );
  const actualDistFiles = (await collectBundleFiles(backendDistDir))
    .map((item) => item.relPath)
    .sort();

  const verifiedSet = new Set(verifiedModules);
  const actualSet = new Set(actualDistFiles);
  const unexpected = actualDistFiles.filter((file) => !verifiedSet.has(file)).sort();
  const missing = verifiedModules.filter((file) => !actualSet.has(file)).sort();

  if (unexpected.length > 0 || missing.length > 0) {
    const details = [];
    if (unexpected.length > 0) details.push(`unexpected=[${unexpected.join(', ')}]`);
    if (missing.length > 0) details.push(`missing=[${missing.join(', ')}]`);
    throw new Error(
      `Backend dist file parity check failed for ${backendDistDir}: ${details.join('; ')}`
    );
  }
  return verifiedModules;
}

export async function packagePluginZip({
  rebuild = false,
  bundleDir = join(repoRoot, 'artifacts', 'agy-usage-tool'),
  outDir = join(repoRoot, 'artifacts'),
} = {}) {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const resolvedBundleDir = resolve(bundleDir);
  const resolvedOutDir = resolve(outDir);

  if (rebuild || !existsSync(join(resolvedBundleDir, 'plugin.json'))) {
    await installPlugin({ dest: resolvedBundleDir, build: true });
  }

  const verifiedModules = await verifyBackendDistParity(resolvedBundleDir);
  const privacy = await scanDirectoryForPrivacy(resolvedBundleDir, { options: { includeBuild: true } });
  if (privacy.issues.length > 0) {
    throw new Error(
      `Bundle privacy gate failed: ${privacy.issues.slice(0, 8).map((i) => `${i.file}:${i.line} ${i.code}`).join(', ')}`
    );
  }

  const zipName = `agy-usage-tool-v${pkg.version}.zip`;
  const zipPath = join(resolvedOutDir, zipName);
  const sumsPath = join(resolvedOutDir, 'SHA256SUMS.txt');
  await rm(zipPath, { force: true });

  const archive = await createZipArchive(resolvedBundleDir, zipPath);
  const zipSha256 = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  await writeFile(sumsPath, `${zipSha256}  ${zipName}\n`, 'utf8');

  return {
    version: pkg.version,
    zipName,
    zipPath,
    sumsPath,
    zipSha256,
    fileCount: archive.fileCount,
    bytes: archive.bytes,
    backendModuleCount: verifiedModules.length,
    entries: archive.entries,
  };
}

async function main() {
  const rebuild = process.argv.includes('--rebuild');
  const res = await packagePluginZip({ rebuild });
  process.stdout.write(
    `[plugin:zip] OK: artifacts/${res.zipName} (${res.bytes} bytes, ${res.fileCount} files, ${res.backendModuleCount} backend modules, sha256=${res.zipSha256})\n`
  );
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[plugin:zip] Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

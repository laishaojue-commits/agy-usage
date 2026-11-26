import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SqliteReadSnapshot } from '../dist/sqlite-read.js';
import { assertRegularSqliteFiles } from '../dist/sqlite-path.js';
import { LocalUsageStatsManager } from '../dist/usage-core.js';
import { scanContentForPrivacy, scanGitHistory, splitGitPatchByFile } from '../tools/check-privacy.mjs';
import { inspectPluginBackend } from '../tools/plugin-allowlist.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

test('LocalUsageStatsManager performs zero network calls and backend allowlist forbids fetch/require/eval', async t => {
  const dir = await fixture(t);
  const fetchSpy = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch must never be invoked in pure local L0 mode');
  });

  const local = new LocalUsageStatsManager({ stateDir: dir, geminiDir: dir });
  local.setAutoRemotePricingSync(true);
  assert.equal(local.isAutoRemotePricingSyncEnabled(), false);
  assert.deepEqual(await local.syncRemotePricing(), { synced: false });
  await local.getUsageSummary(true);
  assert.equal(fetchSpy.mock.callCount(), 0);

  const modules = await inspectPluginBackend(
    fileURLToPath(new URL('../dist', import.meta.url)),
    fileURLToPath(new URL('../plugin/bin/server.mjs', import.meta.url))
  );
  assert.equal(modules.length, 34);
});

test('four SQLite readers see committed WAL data without mutating rows under an active writer', async t => {
  const dir = await fixture(t);
  const path = join(dir, 'test.db');
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1); BEGIN IMMEDIATE; INSERT INTO items VALUES (2);");
  const readers = Array.from({ length: 4 }, () => new SqliteReadSnapshot(path));
  try {
    const results = await Promise.all(readers.map(reader => reader.query('SELECT COUNT(*) AS n FROM items')));
    for (const result of results) {
      assert.equal(result.ok, true, result.error);
      assert.equal(result.rows[0].n, 1);
    }
    assert.equal((await readers[0].query('INSERT INTO items VALUES (3)')).ok, false);
    writer.exec('ROLLBACK;');
    assert.equal(writer.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
  } finally {
    await Promise.all(readers.map(reader => reader.close()));
    writer.close();
  }
  await mkdir(path + '-wal');
  assert.throws(() => assertRegularSqliteFiles(path), /sidecar/);
});

test('SQLite reads allow legitimate ancestor directory junctions/symlinks while rejecting symlinked or directory db/sidecars', async t => {
  const root = await fixture(t);
  const realDir = join(root, 'real');
  const linkedDir = join(root, 'linked');
  const outsideDir = join(root, 'outside');
  await mkdir(realDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  const realDb = join(realDir, 'test.db');
  const writer = new DatabaseSync(realDb);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (7); BEGIN IMMEDIATE; INSERT INTO items VALUES (8);");

  await symlink(realDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedDb = join(linkedDir, 'test.db');
  assert.doesNotThrow(() => assertRegularSqliteFiles(linkedDb));
  if (process.platform === 'win32') {
    assert.doesNotThrow(() => assertRegularSqliteFiles(join(linkedDir, 'TEST.DB')));
  }

  const reader = new SqliteReadSnapshot(linkedDb);
  try {
    const result = await reader.query('SELECT id FROM items ORDER BY id');
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.rows.map(row => row.id), [7]);
  } finally {
    await reader.close();
    writer.exec('ROLLBACK;');
    writer.close();
  }
  assert.doesNotThrow(() => assertRegularSqliteFiles(linkedDb));

  // Non-regular directory sidecar under an ancestor junction must still be rejected.
  await mkdir(linkedDb + '-wal');
  assert.throws(() => assertRegularSqliteFiles(linkedDb), /Invalid SQLite file or sidecar/);
  await rm(linkedDb + '-wal', { recursive: true, force: true });

  // Reparse-point/junction sidecar under an ancestor junction must also be rejected.
  await symlink(outsideDir, linkedDb + '-shm', process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertRegularSqliteFiles(linkedDb), /Invalid SQLite file or sidecar/);
  await rm(linkedDb + '-shm', { recursive: true, force: true });

  // Directory in place of main .db file must be rejected.
  await mkdir(join(realDir, 'dir.db'));
  assert.throws(() => assertRegularSqliteFiles(join(linkedDir, 'dir.db')), /Invalid SQLite file or sidecar/);

  // File symlink sidecar / db (unprivileged on POSIX, or Windows with Developer Mode).
  const outsideDb = join(outsideDir, 'outside.db');
  await writeFile(outsideDb, '');
  let fileSymlinkCreated = false;
  try {
    await symlink(outsideDb, linkedDb + '-wal');
    fileSymlinkCreated = true;
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  }
  if (fileSymlinkCreated) {
    assert.throws(() => assertRegularSqliteFiles(linkedDb), /Invalid SQLite file or sidecar/);
    await rm(linkedDb + '-wal', { force: true });
  }
});

test('complete MCP HTML carries a matching hashed inline script policy', async () => {
  const html = await readFile(new URL('../ui/dist-mcp/mcp-app.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0][1], /\bsrc\s*=/i);
  const hash = createHash('sha256').update(scripts[0][2]).digest('base64');
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/i);
  assert.ok(policy?.[1].includes("script-src 'sha256-" + hash + "'"));
  assert.ok(policy[1].includes("connect-src 'none'"));
  assert.ok(policy.index < scripts[0].index);
});

test('privacy covers Unicode paths, token formats, built output and unpublished Git identities', async t => {
  const unicodeHome = ['C:', 'Users', '合成目录名', 'project'].join('\\');
  const drivePath = ['D:', '合成项目', 'project'].join('\\');
  const clientSecret = 'GOCSPX-' + 'A'.repeat(24);
  const refresh = '1//' + 'X'.repeat(25);
  const jwt = ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(20)].join('.');
  const privateAddress = [192, 168, 1, 1].join('.');
  const input = [unicodeHome, drivePath, clientSecret, refresh, jwt, privateAddress].join('\n');
  const issues = scanContentForPrivacy(input, 'backend/dist/example.js', { includeBuild: true });
  assert.deepEqual(issues.map(i => i.code), [
    'DISALLOWED_LOCAL_HOME_PATH', 'DISALLOWED_DRIVE_PATH', 'DISALLOWED_SECRET_LITERAL',
    'DISALLOWED_SECRET_LITERAL', 'DISALLOWED_SECRET_LITERAL', 'PRIVATE_IP_LITERAL',
  ]);
  const dir = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  const syntheticPrivateMail = 'fixture' + '@' + 'personal.example';
  git('config', 'user.name', 'Synthetic Test Author');
  git('config', 'user.email', syntheticPrivateMail);
  await writeFile(join(dir, 'fixture.txt'), 'sample\n');
  git('add', 'fixture.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic fixture');
  const result = await scanGitHistory(dir);
  assert.equal(result.scannedCount, 1);
  assert.ok(result.issues.some(i => i.code === 'NONPUBLIC_GIT_IDENTITY'));
});

test('scanGitHistory attributes patch sections to real file paths without relaxing drive-path checks', async t => {
  const dir = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Public Fixture');
  git('config', 'user.email', 'public-fixture@users.noreply.github.com');

  await mkdir(join(dir, 'test'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });

  const fixtureStatePath = ['D:', 'agy-usage-tool', 'State'].join('\\');
  await writeFile(join(dir, 'test', 'sample.test.mjs'), `export const sample = ${JSON.stringify(fixtureStatePath)};\n`);
  git('add', 'test/sample.test.mjs');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'safe fixture drive paths');

  const cleanHistory = await scanGitHistory(dir);
  assert.equal(cleanHistory.scannedCount, 1);
  assert.deepEqual(cleanHistory.issues, []);

  const disallowedTestPath = ['D:', '合成项目', 'secret'].join('\\');
  await writeFile(
    join(dir, 'test', 'sample.test.mjs'),
    `export const sample = ${JSON.stringify(fixtureStatePath)};\nexport const leak = ${JSON.stringify(disallowedTestPath)};\n`
  );
  await writeFile(join(dir, 'src', 'demo.ts'), `export const prodPath = ${JSON.stringify(fixtureStatePath)};\n`);
  git('add', 'test/sample.test.mjs', 'src/demo.ts');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'disallowed drive paths');

  const flagged = await scanGitHistory(dir);
  assert.equal(flagged.scannedCount, 2);
  const driveIssues = flagged.issues.filter(i => i.code === 'DISALLOWED_DRIVE_PATH');
  assert.equal(driveIssues.length, 2);
  assert.ok(driveIssues.some(i => i.file.endsWith(':test/sample.test.mjs')));
  assert.ok(driveIssues.some(i => i.file.endsWith(':src/demo.ts')));

  const spoofPatch = [
    'diff --git a/src/demo.ts b/src/demo.ts',
    '--- a/src/demo.ts',
    '+++ b/src/demo.ts',
    '@@ -1 +1,2 @@',
    '+// +++ b/test/spoof.test.mjs',
    `+const x = ${JSON.stringify(fixtureStatePath)};`,
  ].join('\n');
  const sections = splitGitPatchByFile(spoofPatch);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].filePath, 'src/demo.ts');
});

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export function assertRegularSqliteFiles(path: string): void {
  const resolved = resolve(path);
  // Allow legitimate ancestor directory junctions/symlinks (e.g. ~/.gemini junction on Windows, /var -> /private/var on macOS)
  // while rejecting symlinked/reparse or non-regular .db and -wal/-shm sidecar files. This check is not atomic with SQLite open.
  const compared = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
  const realParent = realpathSync(dirname(resolved));
  const fileName = basename(resolved);
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = resolved + suffix;
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid SQLite file or sidecar');
      if (compared(realpathSync(candidate)) !== compared(join(realParent, fileName + suffix))) {
        throw new Error('Invalid SQLite path');
      }
    } catch (error) {
      if (!suffix || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

import { readFile } from 'node:fs/promises';
import { posix, join } from 'node:path';
import ts from 'typescript';

export const ALLOWED_BACKEND_MODULES = new Set([
  'conversation-context.js', 'data-directory.js', 'files.js',
  'hud/metrics-engine.js', 'hud/model-catalog.js', 'i18n.js',
  'maintenance-catalog.js', 'maintenance-core.js', 'maintenance-discovery.js',
  'maintenance-journal.js', 'metric-format.js', 'model-catalog.js', 'model-identity.js', 'mutex.js',
  'platform/fs-guard.js', 'platform/paths.js', 'pricing.js',
  'protobuf-projection.js', 'protobuf.js', 'read-only-gate.js', 'safe-input.js',
  'sqlite-path.js', 'sqlite-read.js', 'sqlite-worker.js',
  'usage-aggregate.js', 'usage-core.js', 'usage-ledger-core.js', 'usage-ledger-worker.js',
  'usage-pricing.js', 'usage-projections.js', 'usage-report.js', 'usage-revalue.js',
  'usage-scanner.js', 'usage-types.js',
]);

const BUILTINS = new Set([
  'node:crypto', 'node:fs', 'node:fs/promises', 'node:os', 'node:path',
  'node:sqlite', 'node:url', 'node:worker_threads', 'node:async_hooks', 'node:util',
]);

export async function inspectPluginBackend(distDir, entryPath) {
  const entry = await readFile(entryPath, 'utf8');
  const pending = new Set([...entry.matchAll(/importBackend\('([^']+)'\)/g)].map((m) => m[1]));
  for (const file of pending) {
    if (!ALLOWED_BACKEND_MODULES.has(file)) throw Error('Plugin dependency not allowlisted: ' + file);
    const source = ts.createSourceFile(file, await readFile(join(distDir, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const add = (specifier) => {
      if (specifier.startsWith('.')) pending.add(posix.normalize(posix.join(posix.dirname(file), specifier)));
      else if (!BUILTINS.has(specifier)) throw Error('Forbidden plugin backend import: ' + file + ' -> ' + specifier);
    };
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const target = node.arguments[0];
          if (!target || !ts.isStringLiteral(target)) throw Error('Dynamic plugin import: ' + file);
          add(target.text);
        }
        if (ts.isIdentifier(node.expression) && ['fetch', 'require', 'eval'].includes(node.expression.text)) {
          throw Error('Forbidden plugin backend call: ' + file);
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Worker') {
        const url = node.arguments?.[0];
        const target = url && ts.isNewExpression(url) ? url.arguments?.[0] : null;
        if (!target || !ts.isStringLiteral(target)) throw Error('Dynamic plugin worker path: ' + file);
        add(target.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  if (pending.size !== ALLOWED_BACKEND_MODULES.size) throw Error('Plugin dependency allowlist is stale');
  return [...pending].sort();
}

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const desktopRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(desktopRoot, '..');

export default defineConfig({
  root: desktopRoot,
  base: './',
  publicDir: false,
  plugins: [
    viteSingleFile({ removeViteModuleLoader: true }),
    {
      name: 'mcp-local-csp',
      enforce: 'post',
      generateBundle: {
        order: 'post',
        handler(_options, bundle) {
          const entry = bundle['mcp-app.html'];
          if (entry?.type !== 'asset' || typeof entry.source !== 'string') throw Error('Missing MCP HTML');
          const html = entry.source.replace(/\r\n?/g, '\n');
          const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
          if (scripts.length !== 1 || /\bsrc\s*=/i.test(scripts[0]![1]!) || !html.includes('<!-- GB_STATIC_CSP -->')) {
            throw Error('Expected one self-contained MCP script and CSP marker');
          }
          const hash = createHash('sha256').update(scripts[0]![2]!).digest('base64');
          const meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'sha256-" +
            hash + "'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'\">";
          entry.source = html.replace('<!-- GB_STATIC_CSP -->', meta);
        },
      },
    },
  ],
  server: {
    fs: {
      allow: [desktopRoot, repoRoot],
    },
  },
  build: {
    outDir: resolve(desktopRoot, 'dist-mcp'),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(desktopRoot, 'mcp-app.html'),
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

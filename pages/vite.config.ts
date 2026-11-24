import {defineConfig, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {devFixtures} from './scripts/dev-fixtures.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

// Public-safe local fixtures let `npm run dev` run without tokens, Rust, a
// server or a private snapshot. Real projection data replaces them in the
// built artifact.
function pagesDevFixtures(): Plugin {
  return {
    name: 'pages-dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url || '').split('?')[0] || '';
        const key = pathname.startsWith('/nession/') ? pathname.slice('/nession'.length) : pathname;
        if (!Object.hasOwn(devFixtures, key)) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-cache');
        response.end(JSON.stringify(devFixtures[key]));
      });
    },
  };
}

// Independent public Pages UI build. Inputs are only the two static HTML
// entrypoints and their local React/TypeScript sources. The public data
// projection and curated prototype publisher are separate trusted build
// inputs and are assembled afterwards; Vite must never own or empty them.
export default defineConfig({
  root,
  base: './',
  publicDir: resolve(root, 'public'),
  plugins: [react(), pagesDevFixtures()],
  build: {
    outDir: process.env.PAGES_UI_OUT_DIR || resolve(root, '.build/ui'),
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        workflows: resolve(root, 'workflows.html'),
      },
    },
  },
  server: {
    port: 4173,
  },
  preview: {
    port: 4174,
  },
});

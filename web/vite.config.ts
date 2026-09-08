/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

/** Override in web/.env.development.local, e.g. http://staging.nession.nhome.local */
function devWsProxyTarget(mode: string): string {
  const env = loadEnv(mode, __dirname, '')
  return env.NESSION_DEV_WS_PROXY ?? 'http://localhost:19090'
}

export default defineConfig(({ mode }) => {
  const devWsProxy = devWsProxyTarget(mode)

  return {
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 13000,
    proxy: {
      '/ws': {
        target: devWsProxy,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: devWsProxy,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  preview: {
    port: 4173,
    proxy: {
      '/ws': {
        target: devWsProxy,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: devWsProxy,
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    // Suppress jsdom warnings that aren't actionable (canvas, focus-lock internals).
    // Applies to all projects; integration is the only one that currently emits them.
    onConsoleLog(log: string): boolean | void {
      if (log.includes("HTMLCanvasElement's getContext")) { return false; }
      if (log.includes('Function components cannot be given refs')) { return false; }
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/__tests__/unit/**/*.test.{ts,tsx}'],
          environment: 'node',
          css: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/__tests__/integration/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: './src/test/setup.ts',
          css: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        lines: 80,
        functions: 72,
        branches: 65,
        statements: 78,
      },
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/components/ui/**',
        'src/test/**',
        'src/App.tsx',
        // Deep link restoration - requires react-router integration testing
        'src/app/useDeepLinkRestore.ts',
        // ── Browser-only terminal internals (xterm lifecycle, mouse) ──
        'src/core/terminal-runtime/MouseIntentResolver.ts',
        // ── WebSocket / interval integration (browser-only, covered by E2E) ──
        'src/app/useProbePolling.ts',
        'src/features/commands/hooks/useQuickCommands.ts',
        'src/app/useVisibilityReconnect.ts',
        // Browser-only PNG export (DOM manipulation, offscreen xterm)
        'src/lib/previewPng.ts',
        'src/features/env/components/EnvUploadDialog.tsx',
        'src/features/env/components/EnvInlineEditor.tsx',
        'src/features/env/hooks/useEnvManager.ts',
      ],
    },
  },
  }
})

/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import {
  TERMINAL_COLS_ENV,
  TERMINAL_WEB_FONT_SIZE_ENV,
  parseTerminalBuildConfig,
} from './src/platform/terminal-runtime/terminalConfig'

/** Override in web/.env.development.local, e.g. http://staging.nession.nhome.local */
function devWsProxyTarget(mode: string): string {
  const env = loadEnv(mode, __dirname, '')
  return env.NESSION_DEV_WS_PROXY ?? 'http://localhost:19090'
}

export default defineConfig(({ mode }) => {
  const devWsProxy = devWsProxyTarget(mode)

  // #2487 SC-07: validate the optional fixed-cols / Web-max-font build inputs
  // before producing a bundle. The same parser runs in the app, so the build
  // and the artifact cannot disagree about what an input means. Values come
  // from .env files and the process environment, with the explicit process
  // value winning (CI passes them there).
  const env = { ...loadEnv(mode, __dirname, 'VITE_'), ...process.env }
  const terminal = parseTerminalBuildConfig({
    [TERMINAL_COLS_ENV]: env[TERMINAL_COLS_ENV],
    [TERMINAL_WEB_FONT_SIZE_ENV]: env[TERMINAL_WEB_FONT_SIZE_ENV],
  })
  if (terminal.errors.length > 0) {
    throw new Error(
      'Invalid terminal build configuration:\n  ' + terminal.errors.join('\n  '),
    )
  }
  console.log('WEB_TERMINAL_CONFIG_V1 ' + JSON.stringify({
    schema_version: 1,
    cols: terminal.config.cols,
    web_max_font_size: terminal.config.webMaxFontSize,
    cols_source: terminal.sources.cols,
    web_font_source: terminal.sources.webMaxFontSize,
  }))

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
      reporter: ['text', 'html', 'json-summary'],
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
        // ── WebSocket / interval integration (browser-only, covered by E2E) ──
        'src/app/useVisibilityReconnect.ts',
        'src/capabilities/env/components/EnvUploadDialog.tsx',
        'src/capabilities/env/components/EnvInlineEditor.tsx',
        'src/capabilities/env/hooks/useEnvManager.ts',
      ],
    },
  },
  }
})

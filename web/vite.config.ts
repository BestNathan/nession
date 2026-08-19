/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
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
        target: 'ws://localhost:19090',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:19090',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
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
        functions: 80,
        branches: 65,
        statements: 80,
      },
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/components/ui/**',
        'src/test/**',
        'src/App.tsx',
        // Glue / orchestration components (covered by integration)
        'src/components/TerminalView.tsx',
        'src/terminal/components/TerminalWorkspace.tsx',
        // Complex UI component with WebSocket integration - covered by E2E
        'src/components/env/EnvPanel.tsx',
        // Deep link restoration - requires react-router integration testing
        'src/hooks/useDeepLinkRestore.ts',
        // ── Browser-only terminal internals (xterm lifecycle, mouse) ──
        'src/terminal/MouseIntentResolver.ts',
        'src/hooks/useSwipeGesture.ts',
        'src/components/SwipeableViewport.tsx',
        // ── Layout / chrome components (covered by integration) ──
        'src/components/TerminalLayout.tsx',
        'src/components/DashboardHeader.tsx',
        'src/components/ModeBar.tsx',
        'src/components/SessionsSection.tsx',
        'src/components/RenderTerminal.tsx',
        'src/components/TerminalBanner.tsx',
        'src/terminal/components/TerminalTabs.tsx',
        'src/terminal/components/TerminalBanner.tsx',
        // ── WebSocket / interval integration (browser-only, covered by E2E) ──
        'src/hooks/useProbePolling.ts',
        'src/hooks/useQuickCommands.ts',
        'src/hooks/useVisibilityReconnect.ts',
        'src/components/env/EnvUploadDialog.tsx',
        'src/components/env/EnvInlineEditor.tsx',
        'src/components/env/useEnvManager.ts',
      ],
    },
  },
})

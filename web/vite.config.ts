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
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
    // Suppress jsdom warnings that aren't actionable (canvas, focus-lock internals).
    onConsoleLog(log: string): boolean | void {
      if (log.includes("HTMLCanvasElement's getContext")) { return false; }
      if (log.includes('Function components cannot be given refs')) { return false; }
    },
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
        // Require browser-only APIs (xterm.js canvas/WebGL, full DOM integration)
        'src/components/Dashboard.tsx',
        'src/components/FileBrowser.tsx',
        'src/components/FileTabs.tsx',
        'src/components/FileViewer.tsx',
        'src/App.tsx',
        // Glue / orchestration components (covered by integration)
        'src/components/TerminalView.tsx',
        'src/terminal/components/TerminalWorkspace.tsx',
        // WebGL/Canvas rendering - requires GPU context, hard to unit test
        'src/terminal/Renderer.ts',
        // Complex UI component with WebSocket integration - covered by E2E
        'src/components/env/EnvPanel.tsx',
        // Deep link restoration - requires react-router integration testing
        'src/hooks/useDeepLinkRestore.ts',
        // ── Browser-only terminal internals (xterm lifecycle, touch/IME, mouse) ──
        'src/terminal/MobileInput.ts',
        'src/terminal/MouseIntentResolver.ts',
        'src/terminal/hooks/useTerminalStateMachine.ts',
        'src/hooks/useSwipeGesture.ts',
        'src/components/SwipeableViewport.tsx',
        // ── Layout / chrome components (covered by integration) ──
        'src/components/TerminalLayout.tsx',
        'src/components/DashboardHeader.tsx',
        'src/components/ModeBar.tsx',
        'src/components/SessionsSection.tsx',
        'src/components/QuickCommandsPanel.tsx',
        'src/components/InputPanel.tsx',
        'src/components/RenderTerminal.tsx',
        'src/components/TerminalBanner.tsx',
        'src/terminal/components/TerminalTabs.tsx',
        'src/terminal/components/TerminalBanner.tsx',
        // ── WebSocket / interval integration (browser-only, covered by E2E) ──
        'src/hooks/useProbePolling.ts',
        'src/hooks/useQuickCommands.ts',
        'src/hooks/useVisibilityReconnect.ts',
        'src/components/env/EnvManager.tsx',
        'src/components/env/EnvUploadDialog.tsx',
        'src/components/env/EnvInlineEditor.tsx',
        'src/components/env/useEnvManager.ts',
        // ── Claude Code extension UI (WebSocket integration, covered by E2E) ──
        'src/extensions/**',
      ],
    },
  },
})

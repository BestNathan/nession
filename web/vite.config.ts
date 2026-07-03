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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      lines: 80,
      functions: 80,
      branches: 65,
      statements: 80,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/components/ui/**',
        'src/test/**',
        // Require browser-only APIs (xterm.js canvas/WebGL, full DOM integration)
        'src/components/Terminal.tsx',
        'src/components/Dashboard.tsx',
        'src/components/FileBrowser.tsx',
        'src/components/FileTabs.tsx',
        'src/components/FileViewer.tsx',
        'src/App.tsx',
        // Glue / orchestration components (covered by integration)
        'src/components/TerminalView.tsx',
        'src/components/useDashboardHandlers.ts',
      ],
    },
  },
})

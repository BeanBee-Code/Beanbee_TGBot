import { defineConfig } from 'vitest/config';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';
import path from 'path';

export default defineConfig({
  plugins: [viteTsconfigPaths(), swc.vite()],
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData.ts',
        'src/scripts/**',
        'src/tests/**'
      ]
    },
    setupFiles: ['./src/tests/setup.ts']
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
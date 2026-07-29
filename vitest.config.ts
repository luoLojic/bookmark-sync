import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/ui/**', 'src/background.ts'],
      reporter: ['text', 'json-summary'],
      // 技术规划方案 7.1：domain 层行覆盖 ≥ 95%、分支 ≥ 90%
      thresholds: {
        'src/domain/**/*.ts': {
          lines: 95,
          branches: 90,
          functions: 95,
          statements: 95,
        },
      },
    },
  },
});

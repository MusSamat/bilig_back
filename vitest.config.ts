import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bilig/permissions': r('./packages/permissions/src/index.ts'),
      '@bilig/content-model/fixtures/animal-cell': r(
        './packages/content-model/src/fixtures/animal-cell.ts',
      ),
      '@bilig/content-model/api': r('./packages/content-model/src/api/index.ts'),
      '@bilig/content-model': r('./packages/content-model/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['packages/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'src/**/*.ts'],
      exclude: [
        '**/*.{test,spec}.ts',
        'packages/**/fixtures/**',
        'src/main.ts',
        'src/test/**',
        'src/repo/prisma.ts',
      ],
    },
  },
});

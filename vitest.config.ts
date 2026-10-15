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
      '@bilig/content-model/schema': r('./packages/content-model/src/schema.ts'),
      '@bilig/content-model': r('./packages/content-model/src/index.ts'),
      '@bilig/scene-core': r('./packages/scene-core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['packages/**/*.{test,spec}.ts'],
    coverage: {
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.{test,spec}.ts', 'packages/**/fixtures/**'],
    },
  },
});

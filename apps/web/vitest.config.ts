import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors the "@/*" path in tsconfig.json. Without it a test importing any
  // module that uses the alias fails to resolve, which silently limits what is
  // testable to files that happen to avoid it.
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});

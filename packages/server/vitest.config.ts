import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Argon2 uses a native unguarded addon that misbehaves inside vitest's
    // worker threads; run suites in fork mode (separate processes).
    pool: 'forks',
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
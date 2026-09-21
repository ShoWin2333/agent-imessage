import { defineConfig } from 'vitest/config'

/** Gateway tests only. The DSH plugin track has its own package and CI job. */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/lib/**', 'apps/**'],
  },
})

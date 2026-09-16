import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { 'agent-imessage': 'src/codex/cli.ts' },
  outDir: 'packages/codex/dist',
  format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false,
  dts: false, clean: true,
  external: ['@spectrum-ts/core', '@spectrum-ts/imessage', 'zod'],
})

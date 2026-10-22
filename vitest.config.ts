import { defineConfig } from 'vitest/config'
import ts from 'typescript'
export default defineConfig({
  plugins: [{
    name: 'compile-native-remote-decorators', enforce: 'pre',
    transform(source, id) {
      if (!id.includes('/src/') || !id.endsWith('.ts') || !source.includes('@Remote')) return
      return { code: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, map: null }
    },
  }],
  test: { include: ['tests/**/*.test.{ts,tsx}'], setupFiles: ['tests/offline-network.ts'] },
})

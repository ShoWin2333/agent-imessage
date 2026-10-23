import { build } from 'esbuild'
await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', sourcemap: true, jsx: 'automatic', tsconfig: 'tsconfig.client.json',
  external: ['react', 'react/jsx-runtime'],
  banner: { js: 'window.__ModuleLoader__.load({id:"@showin2333/dsh-plugin-channels",factory(require){var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
})

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { WorkspaceAnalyzer, WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const projectRoot = resolve(import.meta.dirname, '..')
const workspace = mkdtempSync(join(projectRoot, '.typert-workspace-'))
const packageRoot = join(workspace, 'packages', 'dsh-imessage')
const protocolRoot = join(workspace, 'packages', 'dsh-typert-protocol')

try {
  mkdirSync(packageRoot, { recursive: true })
  cpSync(join(projectRoot, 'src'), join(packageRoot, 'src'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), readFileSync(join(projectRoot, 'package.json')))
  symlinkSync(
    join(projectRoot, 'node_modules'),
    join(workspace, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  mkdirSync(join(protocolRoot, 'src'), { recursive: true })
  writeFileSync(join(protocolRoot, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-typert-protocol',
    type: 'module',
    exports: { '.': './src/index.ts' },
  }, null, 2)}\n`)
  writeFileSync(join(protocolRoot, 'src', 'index.ts'), `
import { Service, type Context } from '@deepseek-ai/cordis'
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  protected constructor(ctx: Context, key: string, _options?: { namespace?: string }) { super(ctx, key) }
}
export interface TypertLookup<Host, Wire> { readonly __host?: Host; readonly __wire?: Wire }
export interface TypertContext<Wire> { readonly __wire?: Wire }
export interface TypertLookupMap {}
export interface TypertContextMap {}
type RemoteDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void
export declare function Remote<This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void
export declare function Remote(exportName: string): RemoteDecorator
`)

  const compilerOptions = {
    target: 'ES2024',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noImplicitOverride: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    experimentalDecorators: false,
    lib: ['ES2024', 'DOM', 'DOM.Iterable'],
  }
  writeFileSync(join(packageRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: { ...compilerOptions, composite: true, noEmit: true },
    include: ['src/**/*.ts'],
    exclude: ['src/client/**'],
  }, null, 2)}\n`)
  writeFileSync(join(protocolRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: { ...compilerOptions, composite: true, noEmit: true },
    include: ['src/**/*.ts'],
  }, null, 2)}\n`)
  writeFileSync(join(workspace, 'tsconfig.host.json'), `${JSON.stringify({
    compilerOptions: {
      ...compilerOptions,
      baseUrl: '.',
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['packages/dsh-typert-protocol/src/index.ts'],
      },
    },
    files: [],
    references: [
      { path: './packages/dsh-imessage/tsconfig.json' },
      { path: './packages/dsh-typert-protocol/tsconfig.json' },
    ],
  }, null, 2)}\n`)

  const generator = new WorkspaceTypertGenerator(workspace)
  const discovered = generator.discover(['host'])
  const artifacts = generator.generate(['dsh-imessage'], ['host'])
  const artifact = artifacts.find(candidate => candidate.package === 'dsh-imessage' && candidate.face === 'host')
  if (artifact === undefined) {
    const model = new WorkspaceAnalyzer({
      root: workspace,
      packages: ['dsh-imessage'],
      faces: ['host'],
    }).analyze()
    throw new Error(`Typert did not emit dsh-imessage host exports: ${JSON.stringify({
      discovered,
      artifacts,
      faces: model.faces.map(face => ({
        face: face.face,
        packages: face.packages.map(pkg => ({
          name: pkg.name,
          exports: pkg.exports.length,
          services: pkg.services.length,
          invocations: pkg.invocations.length,
        })),
      })),
    })}`)
  }

  const output = join(projectRoot, 'lib')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'typert.host.js'), artifact.js)
  writeFileSync(join(output, 'typert.host.d.ts'), artifact.dts)
  if (artifact.remote === undefined) throw new Error('Typert did not emit the expected Remote contribution')
  writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
  writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
  writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

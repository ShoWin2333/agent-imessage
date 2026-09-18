import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, stat, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importConfig, loadAppConfig, loadSecrets, validateConfig, atomicJson } from '../src/app/config.js'
const dirs:string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p,{recursive:true,force:true}))) })
async function directory() { const dir=await mkdtemp(join(tmpdir(),'gateway-config-')); dirs.push(dir); return dir }
const base={id:'one',projectId:'p',projectSecretEnv:'SECRET',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
it('accepts a legacy bridge without overwriting it, preserves state root and rejects duplicate routing',async()=>{
  const dir=await directory(),file=join(dir,'old.json')
  const raw={cursorBinary:'agent',stateDir:dir,routes:[{...base,cwd:dir}]}
  await writeFile(file,JSON.stringify(raw)); const config=await loadAppConfig(file)
  expect(config.stateDir).toBe(dir);expect(JSON.parse(await readFile(file,'utf8'))).toEqual(raw)
  await expect(validateConfig({...config,routes:[config.routes[0],{...config.routes[0],id:'two'}]})).rejects.toThrow('unique')
  await expect(validateConfig({...config,routes:[{...config.routes[0],backend:'cursor',effort:'high'}]})).rejects.toThrow('Specify a Cursor model')
  await writeFile(file,JSON.stringify({...raw,routes:[{...base,cwd:join(dir,'missing')}]})); await expect(loadAppConfig(file)).resolves.toMatchObject({routes:[{cwd:join(dir,'missing')}]})
  await writeFile(file,'broken'); await expect(loadAppConfig(file)).rejects.toThrow()
})
it('migrates every Cursor SDK route and dedicated secret without overwriting the source',async()=>{
  const dir=await directory(),source=join(dir,'old.json'),dest=join(dir,'new.json')
  await mkdir(join(dir,'route-secrets'))
  const routes=['one','two'].map((id,i)=>({id,cwd:dir,projectId:`p${i}`,senderPhoneNumber:base.senderPhoneNumber,assignedPhoneNumber:`+1555765432${i}`,model:'model',effort:'high',speed:'fast'}))
  await writeFile(source,JSON.stringify({port:0,stateDir:join(dir,'state'),routes}))
  for(const route of routes)await writeFile(join(dir,'route-secrets',route.id+'.photon'),'secret-'+route.id)
  await writeFile(join(dir,'cursor.api-key'),'cursor-fixture')
  await importConfig(source,dest)
  const config=await loadAppConfig(dest),secrets=await loadSecrets(dest+'.secrets.json')
  expect(config.routes.map(r=>r.backend)).toEqual(['cursor','cursor'])
  expect(secrets).toEqual({cursorApiKey:'cursor-fixture',photon:{one:'secret-one',two:'secret-two'}})
  expect((await stat(dest+'.secrets.json')).mode&0o777).toBe(0o600)
  await expect(importConfig(source,dest)).rejects.toThrow('exists')
})
it('migrates DSH settings plus project credential exports atomically, failing incomplete exports',async()=>{
  const dir=await directory(),source=join(dir,'old.json'),creds=join(dir,'credentials.json'),dest=join(dir,'new.json')
  await writeFile(source,JSON.stringify({routes:[{id:'dsh',workspaceCwd:dir,photonProjectName:'my-project',phoneNumber:base.senderPhoneNumber,assignedPhoneNumber:base.assignedPhoneNumber}]}))
  await writeFile(creds,JSON.stringify({version:2,apiOrigin:'https://app.photon.codes',accessToken:'management-token',accessTokenExpiresAt:2000000000000,account:{id:'me',email:'fixture@example.test'},projects:[{id:'photon-project',name:'my-project',secret:'secret'}]}))
  await expect(importConfig(source,dest)).rejects.toThrow()
  await importConfig(source,dest,creds)
  expect((await loadAppConfig(dest)).routes[0]).toMatchObject({backend:'dsh',cwd:await realpath(dir),projectId:'photon-project'})
  expect((await loadSecrets(dest+'.secrets.json')).photon.dsh).toBe('secret')
})
it('atomic config writes enforce a private parent directory',async()=>{
  const dir=await directory(); await mkdir(join(dir,'public'),{mode:0o755})
  await expect(atomicJson(join(dir,'public','config.json'),{})).rejects.toThrow('private')
})

it('accepts bounded inline JPEG workspace avatars and rejects remote or active image formats',async()=>{
  const route={id:'avatar',cwd:'/workspace',enabled:false,channels:[],avatar:'data:image/jpeg;base64,/9j/2Q=='}
  expect((await validateConfig({routes:[route]},false)).routes[0]!.avatar).toBe(route.avatar)
  for(const avatar of ['https://example.com/a.jpg','data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,/9j/'+ 'A'.repeat(16000)]) {
    await expect(validateConfig({routes:[{...route,avatar}]},false)).rejects.toThrow()
  }
})

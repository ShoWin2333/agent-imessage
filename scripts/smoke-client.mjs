import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const require = createRequire(import.meta.url)
let entry, registration
vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'), {
  window:{__ModuleLoader__:{load(value){entry=value.factory(require)}}}, console,TextEncoder,TextDecoder,URL,Set,Map,Symbol,Promise,Error,TypeError,Uint8Array,structuredClone,
})
const snapshot={status:'ready',value:{bindings:[]},revision:1,writable:true}
const form={getSnapshot:()=>snapshot,subscribe:()=>()=>{},mutate:async()=>{throw new Error('Smoke rendering must not save')}}
const ctx={
  remote:{$mount:async()=>async()=>{},session:{modelCatalog:async()=>{throw new Error('Smoke rendering must not fetch models')}}},
  configForms:{get:()=>form,whileServed:(_ids,callback)=>callback()},
  slots:{inject:(_slot,callback)=>callback(),register:(options,component)=>{registration={options,component};return ()=>{}}},
}
const dispose=await entry.apply(ctx)
assert.ok(registration)
assert.equal(registration.options.name,'settings.section')
assert.equal(registration.options.id,'dsh-channels')
const markup=renderToStaticMarkup(React.createElement(registration.component,{...registration.options.inject(),view:'page',form:undefined}))
for(const word of ['iMessage','Telegram','Discord','微信','保存配置','尚未配置渠道'])assert.ok(markup.includes(word),`Missing rendered control ${word}`)
await dispose()
console.log('Built browser module renders the real management controls without globals, network or writes.')

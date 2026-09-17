import {expect,it} from 'vitest'
import {modelChoices} from '../src/backends/catalog.js'
it('normalizes Cursor, Codex and grouped DSH models while retaining exact identifiers',()=>{
  expect(modelChoices([{id:'cursor',displayName:'Cursor model'},{model:'codex',displayName:'Codex model'}])).toEqual([{id:'cursor',name:'Cursor model'},{id:'codex',name:'Codex model'}])
  expect(modelChoices([{group:'provider',name:'Provider',options:[{value:'["provider","model"]',name:'Model'}]}])).toEqual([{id:'["provider","model"]',name:'Provider / Model'}])
  expect(modelChoices([{},null])).toEqual([])
})

import {withCapabilities} from '../src/backends/catalog.js'
it('uses advertised per-model effort and speed capabilities',()=>{
  const cursor=withCapabilities([{id:'composer',parameters:[{id:'fast',values:[{value:'false'},{value:'true'}]}]}],'cursor')[0]!
  expect(cursor.efforts).toEqual([])
  expect(cursor.speeds?.map(v=>v.value)).toEqual(['standard','fast'])
  const codex=withCapabilities([{model:'model',supportedReasoningEfforts:[{reasoningEffort:'ultra'}],serviceTiers:[{id:'priority',name:'Fast'}]}],'codex')[0]!
  expect(codex.efforts).toEqual([{value:'ultra',label:'ultra'}])
  expect(codex.speeds?.[0]?.value).toBe('fast')
})

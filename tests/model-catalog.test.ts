import {expect,it} from 'vitest'
import {modelChoices} from '../src/backends/catalog.js'
it('normalizes Cursor, Codex and grouped DSH models while retaining exact identifiers',()=>{
  expect(modelChoices([{id:'cursor',displayName:'Cursor model'},{model:'codex',displayName:'Codex model'}])).toEqual([{id:'cursor',name:'Cursor model'},{id:'codex',name:'Codex model'}])
  expect(modelChoices([{group:'provider',name:'Provider',options:[{value:'["provider","model"]',name:'Model'}]}])).toEqual([{id:'["provider","model"]',name:'Provider / Model'}])
  expect(modelChoices([{},null])).toEqual([])
})

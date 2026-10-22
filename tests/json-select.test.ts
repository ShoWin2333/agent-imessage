import {expect,it} from 'vitest'
import {selectJson} from '../src/plugin/json-select.js'
import {legacyCheckpoint} from '../src/plugin/legacy-checkpoint.js'
async function* chunks(value:string,size=1){const b=new TextEncoder().encode(value);for(let i=0;i<b.length;i+=size)yield b.slice(i,i+size)}
it('projects only named credential slots without retaining other secrets or history',async()=>{
 const source=JSON.stringify({photon:{unrelated:'DO_NOT_KEEP',alice:'SYNTHETIC_A'},telegram:{'123':'SYNTHETIC_B'},discord:{'456':'SYNTHETIC_C'},tasks:[{text:'PRIVATE_HISTORY',nested:{secret:'UNRELATED'}}]})
 const selected=await selectJson(chunks(source),[['photon','alice'],['telegram','123'],['discord','456']]);expect([...selected.values()]).toEqual(['SYNTHETIC_A','SYNTHETIC_B','SYNTHETIC_C']);expect(JSON.stringify([...selected])).not.toMatch(/PRIVATE_HISTORY|DO_NOT_KEEP|UNRELATED/)
})
it('preserves UTF8, escaped delimiters and metadata types across chunk boundaries',async()=>{
 const source=JSON.stringify({skip:'escape \\" ] }',routes:[{id:'alice',channels:[{phase:'stopped',tasks:[{text:'skip'}]}]}],seen:['中文','escaped \\" }'],channelCursor:'234'})
 const selected=await selectJson(chunks(source,3),[['routes','0','channels','0','phase'],['seen'],['channelCursor']]);expect([...selected.values()]).toEqual(['stopped',['中文','escaped \\" }'],'234'])
})
it('rejects truncation, malformed selected JSON, excess input and duplicate selected keys',async()=>{
 await expect(selectJson(chunks('{"seen":[],"seen":[]}'),[['seen']])).rejects.toThrow()
 await expect(selectJson(chunks('{"seen":['),[['seen']])).rejects.toThrow()
 await expect(selectJson(chunks('{"seen":nope}'),[['seen']])).rejects.toThrow()
 await expect(selectJson(chunks('{"seen":[]}'),[['seen']],2)).rejects.toThrow()
})

it('reports only credential field presence without decoding selected values',async()=>{
 const value=JSON.stringify({photon:{jane:'SYNTHETIC_SECRET'},discord:{bot:'OTHER_SECRET'},weixin:{account:{token:'SENSITIVE_TOKEN',ownerUserId:'metadata'}}})
 const selected=await selectJson(chunks(value),[['photon','jane'],['discord','bot'],['weixin','account','token'],['missing']],undefined,true)
 expect([...selected.values()]).toEqual([true,true,true]);expect(selected.has('["missing"]')).toBe(false);expect(JSON.stringify([...selected])).not.toMatch(/SYNTHETIC_SECRET|OTHER_SECRET|SENSITIVE_TOKEN/)
})

it('imports only Weixin seen IDs and the exact opaque cursor from a mixed legacy file',async()=>{
 const cursor='000+/=游标\nopaque',source=JSON.stringify({seen:['already-handled'],channelCursor:cursor,weixinContext:'PRIVATE_REPLY_CONTEXT',tasks:[{input:'PRIVATE_TASK',result:'PRIVATE_RESULT'}]})
 const selected=await selectJson(chunks(source,2),[['seen'],['channelCursor']])
 const extracted=Object.fromEntries([...selected].map(([path,value])=>[JSON.parse(path)[0],value]))
 const checkpoint=legacyCheckpoint(extracted,'weixin')
 expect(checkpoint).toEqual({seen:['already-handled'],legacySeen:['already-handled'],channelCursor:cursor})
 expect(JSON.stringify(checkpoint)).not.toMatch(/PRIVATE_REPLY_CONTEXT|PRIVATE_TASK|PRIVATE_RESULT/)
})

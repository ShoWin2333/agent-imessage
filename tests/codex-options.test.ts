import {it,expect,vi} from 'vitest'
import {CodexBackend} from '../src/backends/codex.js'
it('passes reasoning and priority tier on both new and resumed threads',async()=>{
 const rpc={onClose:()=>{},onNotification:()=>{},onRequest:async()=>({}),close:()=>{},request:vi.fn(async()=>({thread:{id:'s',cwd:'/workspace'}}))}
 const backend=new CodexBackend(rpc)
 for(const id of [undefined,'s']) {
  await backend.openSession({...(id?{id}:{}),cwd:'/workspace',tools:[],effort:'ultra',speed:'fast'})
  expect(rpc.request).toHaveBeenLastCalledWith(id?'thread/resume':'thread/start',expect.objectContaining({serviceTier:'priority',config:{model_reasoning_effort:'ultra'}}))
 }
})
it('routes approvals explicitly and keeps the workspace sandbox for new and resumed sessions',async()=>{
 const rpc={onClose:()=>{},onNotification:()=>{},onRequest:async()=>({}),close:()=>{},request:vi.fn(async()=>({thread:{id:'s',cwd:'/workspace'}}))}
 const backend=new CodexBackend(rpc)
 for(const id of [undefined,'s']) for(const policy of ['default','on-request','auto-review','never']) {
  await backend.openSession({...(id?{id}:{}),cwd:'/workspace',tools:[],approvalPolicy:policy})
  expect(rpc.request).toHaveBeenLastCalledWith(id?'thread/resume':'thread/start',expect.objectContaining({sandbox:'workspace-write',approvalPolicy:policy==='never'?'never':'on-request',approvalsReviewer:policy==='auto-review'?'auto_review':'user'}))
 }
})

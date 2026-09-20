import {randomBytes} from 'node:crypto'
export function requestId(pending: {has(id:string):boolean}, random = () => randomBytes(5).toString('hex')): string {
  for (let attempt=0;attempt<100;attempt++) { const id=random(); if (!pending.has(id)) return id }
  throw new Error('Cannot allocate request ID')
}
const object=(value:unknown):Record<string,unknown> => value && typeof value==='object' ? value as Record<string,unknown> : {}
const text=(value:unknown) => typeof value==='string' ? value : ''
export function interactionPresentation(agent:string, method:string, params:Record<string,unknown>, changes:unknown) {
  if (method==='bridge/requestApproval') { const details=object(params.details); params={...object(details.rawInput),...params,reason:text(details.title) || text(params.reason)} }
  const questions=Array.isArray(params.questions) ? params.questions.map(object).map(q=>({id:text(q.id),prompt:text(q.question),options:Array.isArray(q.options) ? q.options.map(object).map(o=>({label:text(o.label),description:text(o.description)})).filter(o=>o.label) : []})) : []
  const files=Array.isArray(changes) ? changes.map(object).map(c=>({path:text(c.path),kind:text(c.kind) || text(object(c.kind).type),diff:text(c.diff)})).filter(c=>c.path) : []
  return {title:`${agent} ${method==='item/tool/requestUserInput' ? '需要你回答' : method==='item/commandExecution/requestApproval' ? '请求运行命令' : method==='item/fileChange/requestApproval' ? '请求修改文件' : '请求授权'}`,command:Array.isArray(params.command) ? params.command.map(String).join(' ') : text(params.command),cwd:text(params.cwd),reason:text(params.reason),files,questions,extraPermissions:params.networkApprovalContext!=null || params.additionalPermissions!=null,generic:method==='bridge/requestApproval'}
}

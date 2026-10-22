import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ChannelMessage } from '../channels/types.js'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalInteraction, QuestionInteraction, InteractionScope } from './interaction-types.js'
import { bounded } from './delivery.js'

const MAX_PROMPT = 12000
const option = z.object({label:z.string().min(1),description:z.string().optional()}).strict()
const questionsSchema = z.array(z.object({
  id:z.string().min(1),question:z.string().min(1),detail:z.string().optional(),header:z.string().optional(),
  options:z.array(option).max(32).optional(),multiSelect:z.boolean().optional(),
  intent:z.object({kind:z.literal('plan-review'),approve:z.string().min(1)}).strict().optional(),
}).strict()).min(1).max(16).superRefine((questions,ctx)=>{
  if(new Set(questions.map(q=>q.id)).size!==questions.length) ctx.addIssue({code:'custom',message:'Duplicate question id'})
  for(const q of questions) {
    const labels=q.options?.map(o=>o.label) ?? []
    if(new Set(labels).size!==labels.length || q.intent && (!q.detail || q.multiSelect || !labels.includes(q.intent.approve))) ctx.addIssue({code:'custom',message:'Ambiguous question'})
  }
})
const answerSchema = z.object({answers:z.array(z.object({
  id:z.string().min(1),selected:z.array(z.string()).max(32),custom:z.string().trim().min(1).max(MAX_PROMPT).optional(),
}).strict()).max(16)}).strict()
interface Pending {
  kind:'approval'|'question'
  scope:InteractionScope
  expires:number
  ready:boolean
  questions?:AskUserQuestionItem[]
  complete(value:ApprovalOutcome|AskUserQuestionAnswer):void
  cancel(unavailable?:boolean):void
}
function current(scope:InteractionScope):boolean {try{return scope.current()}catch{return false}}
const invalid = () => new Error('请求已失效、尚未送达或不属于本渠道；没有执行任何授权。')

/** Ephemeral reply capabilities only; native DSH retains policy, audit and execution. */
export class ChannelInteractions {
  private readonly pending = new Map<string,Pending>()
  constructor(private readonly healthy:()=>boolean,private readonly timeoutMs=120000) {}
  async approval(scope:ApprovalInteraction,message:ChannelMessage):Promise<ApprovalOutcome> {
    if(!scope.reason?.trim()) return 'unavailable' // Never ask for an uninformed grant.
    const token=`a-${randomUUID()}`
    const prompt=`DSH 单次审批\n会话：${scope.sessionId}\n轮次：${scope.turn}\n工具：${scope.toolName}\n${scope.callId ? `调用：${scope.callId}\n` : ''}原因：${scope.reason}\n\n仅批准这一次请求，不改变宿主权限。\n/approve ${token}\n/deny ${token}\n有效期 ${Math.ceil(this.timeoutMs/1000)} 秒。`
    if(prompt.length>MAX_PROMPT) return 'unavailable'
    const result=await this.wait(token,'approval',scope,message,prompt)
    return typeof result==='string' ? result : 'unavailable'
  }
  async question(scope:QuestionInteraction,message:ChannelMessage):Promise<AskUserQuestionAnswer> {
    const parsed=questionsSchema.safeParse(scope.questions)
    if(!parsed.success) throw new UserQuestionError('渠道无法完整且明确地显示该问答。','CHANNEL_UNAVAILABLE')
    const questions=structuredClone(parsed.data) as AskUserQuestionItem[],token=`q-${randomUUID()}`
    const body=questions.map((q,index)=>`${index+1}. [${q.id}] ${q.header ? `${q.header}：` : ''}${q.question}${q.detail===undefined?'':`\n详情：\n${q.detail}`}${q.options?.map((o,i)=>`\n  ${i+1}. ${o.label}${o.description===undefined?'':` — ${o.description}`}`).join('') ?? ''}${q.multiSelect?'\n可多选。':''}${q.intent ? `\n计划审批：仅选择「${q.intent.approve}」表示同意。` : ''}`).join('\n\n')
    const sample={answers:questions.map(q=>({id:q.id,selected:[],custom:'填写回答'}))}
    const prompt=`DSH 问答\n会话：${scope.sessionId}\n轮次：${scope.turn}\n\n${body}\n\n/answer ${token} ${JSON.stringify(sample)}\n${questions.length===1?'单题也可用选项数字（多选用逗号）或 text:自由文本；计划审批必须明确选择一个选项。\n':''}答案包含所有题目 ID，selected 填原选项标签；示例不是默认答案。\n有效期 ${Math.ceil(this.timeoutMs/1000)} 秒；/cancel 取消本渠道工作。`
    if(prompt.length>MAX_PROMPT) throw new UserQuestionError('问答内容过长，渠道未展示、未作答；请使用 DSH 宿主。','CHANNEL_UNAVAILABLE')
    const result=await this.wait(token,'question',scope,message,prompt,questions)
    if(typeof result==='string') throw new UserQuestionError('渠道问答已取消或不可用。','ASK_ABORTED')
    return result
  }
  private wait(token:string,kind:Pending['kind'],scope:InteractionScope,message:ChannelMessage,prompt:string,questions?:AskUserQuestionItem[]):Promise<ApprovalOutcome|AskUserQuestionAnswer> {
    if(!this.healthy() || !current(scope) || scope.signal.aborted) return kind==='approval' ? Promise.resolve('unavailable') : Promise.reject(new UserQuestionError('渠道问答不可用。','ASK_ABORTED'))
    return new Promise((resolve,reject)=>{
      const sending=new AbortController()
      let finished=false,timer:ReturnType<typeof setTimeout>
      const cleanup=()=>{finished=true;this.pending.delete(token);clearTimeout(timer);scope.signal.removeEventListener('abort',abort);sending.abort()}
      const cancel=(unavailable=false)=>{
        if(finished) return
        cleanup()
        if(kind==='approval') resolve(unavailable?'unavailable':'cancelled')
        else reject(new UserQuestionError('渠道问答已取消、过期或投递未确认。','ASK_ABORTED'))
      }
      const abort=()=>cancel()
      const pending:Pending={kind,scope,expires:Date.now()+this.timeoutMs,ready:false,...(questions?{questions}:{}),
        complete:value=>{if(finished)return;cleanup();resolve(value)},cancel}
      timer=setTimeout(()=>cancel(true),this.timeoutMs)
      this.pending.set(token,pending)
      scope.signal.addEventListener('abort',abort,{once:true})
      void bounded(Promise.resolve().then(()=>message.send(prompt)),30000,sending.signal).then(()=>{
        if(!finished) {
          if(!this.healthy() || !current(scope) || scope.signal.aborted || Date.now()>=pending.expires) cancel()
          else pending.ready=true
        }
      },()=>cancel(true))
    })
  }
  /** Must be called only after durable command admission in this binding's bridge. */
  reply(command:string):string {
    const match=/^\/(approve|deny|answer)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(command.trim())
    if(!match) throw new Error('用法：/approve <请求凭据>、/deny <请求凭据> 或 /answer <请求凭据> <答案>。')
    const [,verb,token,raw]=match,pending=this.pending.get(token!)
    if(!pending) throw invalid()
    if(!this.healthy() || !current(pending.scope) || pending.scope.signal.aborted || Date.now()>=pending.expires) {pending.cancel();throw invalid()}
    if(!pending.ready) throw invalid()
    if(verb==='answer') {
      if(pending.kind!=='question' || !raw) throw invalid()
      const answer=parseAnswer(pending.questions!,raw)
      pending.complete(answer)
      return '问答已提交给 DSH。'
    }
    if(pending.kind!=='approval' || raw) throw invalid()
    pending.complete(verb==='approve'?'allowed-once':'rejected')
    return verb==='approve'?'已向 DSH 提交仅限本次操作的批准。':'已向 DSH 提交拒绝。'
  }
  cancel():void {for(const entry of [...this.pending.values()]) entry.cancel()}
}

export function parseAnswer(questions:AskUserQuestionItem[],raw:string):AskUserQuestionAnswer {
  let candidate:unknown
  if(raw.trim().startsWith('{')) {
    try {candidate=JSON.parse(raw)} catch {throw new Error('答案 JSON 无效；请求仍在等待。')}
  } else {
    if(questions.length!==1) throw new Error('多题请使用包含全部题目 ID 的 answers JSON。')
    const q=questions[0]!,text=raw.trim()
    if(text.startsWith('text:')) candidate={answers:[{id:q.id,selected:[],custom:text.slice(5).trim()}]}
    else if(!q.options?.length) candidate={answers:[{id:q.id,selected:[],custom:text}]}
    else {
      const tokens=text.split(',').map(s=>s.trim())
      const labels=tokens.map(token=>/^\d+$/.test(token)?q.options?.[Number(token)-1]?.label:q.options?.find(o=>o.label===token)?.label)
      if(labels.some(label=>label===undefined)) throw new Error('选项无效；自由文本请明确使用 text:。')
      candidate={answers:[{id:q.id,selected:labels}]}
    }
  }
  const parsed=answerSchema.safeParse(candidate)
  if(!parsed.success || parsed.data.answers.length!==questions.length || new Set(parsed.data.answers.map(a=>a.id)).size!==questions.length) throw new Error('答案必须完整覆盖所有题目且不能重复或增加题目 ID。')
  for(const answer of parsed.data.answers) {
    const q=questions.find(q=>q.id===answer.id)
    if(!q || answer.selected.some(label=>!q.options?.some(o=>o.label===label)) || new Set(answer.selected).size!==answer.selected.length) throw new Error('题目或选项无效；请求仍在等待。')
    const count=answer.selected.length+(answer.custom===undefined?0:1)
    if(!count || !q.multiSelect && count!==1 || q.intent && (answer.custom!==undefined || answer.selected.length!==1)) throw new Error('单选题只接受一个答案；计划审批必须明确选择一个原选项。')
  }
  return parsed.data as AskUserQuestionAnswer
}

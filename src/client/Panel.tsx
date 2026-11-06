import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import type {AgentGroup,Binding,Catalog,ClientContext,ConfigForm,FormSnapshot,PermissionCatalog,RuntimeStatus,StatusFrame} from './contracts.js'
import {bindingIssues,isChannelKind,type BindingIssue,type RuleBinding} from '../shared/rules.js'
import {agentGroupIssue,MAX_AGENTS,resolveAgentGroups} from '../shared/agents.js'
import {isPhase} from '../shared/phases.js'
import {QQBotSetup} from './QQBotSetup.js'
import {QQBotCredentials} from './QQBotCredentials.js'
import {styles} from './styles.js'
import {NS,fallbackTranslate} from './locale.js'

export type Translate=(key:string)=>string
const labels:Record<Binding['channel']['kind'],string>={
  imessage:'kind.imessage',telegram:'kind.telegram',weixin:'kind.weixin',qqbot:'kind.qqbot',
}
const channelFields:Record<Binding['channel']['kind'],Array<[string,string]>>={
  imessage:[['projectId','field.projectId'],['senderPhoneNumber','field.senderPhoneNumber'],['assignedPhoneNumber','field.assignedPhoneNumber']],
  telegram:[['botId','field.botId'],['ownerUserId','field.ownerUserId']],
  weixin:[['accountId','field.accountId']],
  qqbot:[['appId','field.qqAppId'],['ownerUserId','field.qqOwner'],['visionProvider','field.qqVisionProvider'],['visionModel','field.qqVisionModel']],
}
export function translate(ctx:ClientContext):Translate {
  const bound=ctx.locale?.bind(NS)
  return bound??fallbackTranslate
}
const phaseKey=(phase:string)=>`phase.${isPhase(phase)?phase:'unknown'}`
export function phaseLabel(phase:string|undefined,enabled:boolean,t:Translate=fallbackTranslate){
  return phase===undefined?(enabled?t('phase.pending'):t('phase.stopped')):t(phaseKey(phase))
}
const statusTone=(phase:string|undefined):'is-ok'|'is-warn'|'is-error'|'is-idle'=>
  phase==='listening'?'is-ok':
  phase==='starting'||phase==='retrying'||phase==='stopping'?'is-warn':
  phase==='failed'||phase==='error'?'is-error':'is-idle'
/** Keep long host identifiers out of the visual line; the full value stays in the tooltip. */
const shortId=(value:string)=>value.length>14?`${value.slice(0,8)}…${value.slice(-4)}`:value
function issueText(issue:BindingIssue,t:Translate):string{
  const field=issue.field?`${t('punct.fieldOpen')}${t(`field.${issue.field}`)}${t('punct.fieldClose')}`:''
  const body=`${t(`issue.${issue.code}`)}${field}`
  return issue.bindingId?`${issue.bindingId} · ${body}`:body
}
/** Shared semantic rules; the Host runs the same function before activation. */
export function validateBindings(bindings:Binding[],t:Translate=fallbackTranslate):string|undefined{
  const issue=bindingIssues(bindings as unknown as RuleBinding[])[0]
  return issue===undefined?undefined:issueText(issue,t)
}

export function ChannelPanel({ctx,channelForm,view,presets}:{ctx:ClientContext;channelForm:ConfigForm;view?:string;presets?:PermissionCatalog|undefined}){
  const [t,setT]=useState<Translate>(()=>translate(ctx))
  useEffect(()=>{
    setT(()=>translate(ctx))
    return ctx.locale?.subscribe(()=>setT(()=>translate(ctx)))
  },[ctx])
  if(view==='summary')return t('summary')
  return <ChannelEditor ctx={ctx} form={channelForm} t={t} presets={presets}/>
}
type Edit={value:Binding;base?:Binding;agentId?:string}
type Removal={kind:'agent'|'channel';agent:AgentGroup;rows:Binding[];draftIds:string[];label:string}
const canonical=(value:unknown):unknown=>{
 if(Array.isArray(value))return value.map(canonical)
 if(!value||typeof value!=='object')return value
 // Native Settings materializes declarative defaults when it accepts a QQ row.
 // They do not represent a conflicting edit or a failed save.
 const object='kind' in value&&value.kind==='qqbot'?{streaming:true,showToolResults:false,sendPresentedFiles:true,maxFiles:4,externalTurns:'c2c',...value}:value
 return Object.fromEntries(Object.entries(object).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]))
}
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b))
function ChannelEditor({ctx,form,t,presets}:{ctx:ClientContext;form:ConfigForm;t:Translate;presets?:PermissionCatalog|undefined}){
 const snapshot=useSyncExternalStore(listener=>form.subscribe(listener),()=>form.getSnapshot(),()=>form.getSnapshot())
 const persisted=snapshot.value?.bindings??[]
 const unsupported=persisted.some(b=>!isChannelKind(b.channel.kind))
 const [edits,setEdits]=useState<Record<string,Edit>>({}),[selectedId,setSelectedId]=useState(persisted[0]?.id??'')
 const [selectedAgentId,setSelectedAgentId]=useState(''),[newAgent,setNewAgent]=useState<{name:string;cwd:string}|null>(null)
 const [removal,setRemoval]=useState<Removal|null>(null)
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[failure,setFailure]=useState(false)
 const [confirmation,setConfirmation]=useState<{id:string;value:Binding;expected:Binding}|null>(null)
 const [catalog,setCatalog]=useState<Catalog>(),[modelsError,setModelsError]=useState('')
 const [runtime,setRuntime]=useState<RuntimeStatus[]>([]),[statusError,setStatusError]=useState('')
 const [projects,setProjects]=useState<Array<{id:string;title:string;cwd:string;bindingIds:string[]}>>([])
 const confirmRef=useRef<HTMLDivElement>(null),confirmButton=useRef<HTMLButtonElement>(null)
 const metadataIssue=agentGroupIssue(persisted,snapshot.value?.agents??[])
 const savedGroups=resolveAgentGroups(persisted,metadataIssue?[]:snapshot.value?.agents)
 const groups=savedGroups.map(agent=>({...agent,bindingIds:[...agent.bindingIds,...Object.values(edits).filter(e=>!e.base&&e.agentId===agent.id&&!persisted.some(b=>b.id===e.value.id)).map(e=>e.value.id)]}))
 const baseRows=[...persisted,...Object.values(edits).filter(e=>e.base===undefined&&savedGroups.some(g=>g.id===e.agentId)&&!persisted.some(b=>b.id===e.value.id)).map(e=>e.value)]
 const group=groups.find(g=>g.id===selectedAgentId)??groups[0]
 const id=group?.bindingIds.includes(selectedId)?selectedId:group?.bindingIds[0]??''
 const current=persisted.find(b=>b.id===id),edit=edits[id],binding=edit?.value??current
 const writable=snapshot.writable&&snapshot.status==='ready'&&snapshot.revision!==undefined&&!metadataIssue
 const dirty=Boolean(edit&&!same(edit.value,edit.base)),conflict=Boolean(edit&&!same(edit.base,current))
 const status=runtime.find(s=>s.id===id),selected=binding?.model?JSON.stringify([binding.model.provider,binding.model.model]):''
 const model=catalog?.groups.find(g=>g.id===binding?.model?.provider)?.models.find(m=>m.id===binding?.model?.model)
 const preset=presets?.options.find(option=>option.value===binding?.permissionPreset)
 const presetListed=presets===undefined||preset!==undefined||!binding?.permissionPreset
 // Host project membership is authoritative and may use a canonical path. Drafts and
 // the Agent default must not override the selected channel’s actual ownership.
 const project=current?projects.find(p=>p.bindingIds.includes(id)):undefined
 const statusMessage=(code:string)=>{const text=t(`status.${code}`);return text===`status.${code}`?code:text}
 useEffect(()=>{let live=true;void ctx.remote.session.modelCatalog().then(result=>{if(!live)return;if(result.ok)setCatalog(result.value);else setModelsError(t('error.models'))},()=>{if(live)setModelsError(t('error.modelsUnavailable'))});return()=>{live=false}},[ctx,t])
 // The current Host publishes lifecycle transitions through the native stream.
 useEffect(()=>{
  let live=true;const controller=new AbortController()
  const loadProjects=async()=>{const api=ctx.remote.channelProjects;if(!api)return;try{const result=await api.status();if(live&&result.ok)setProjects(result.value.projects)}catch{/* keep the previous grouping */}}
  const apply=(value:StatusFrame)=>{if(!live)return;setRuntime(value.bindings);setStatusError(value.configError?statusMessage(value.configError):'')}
  void (async()=>{
    const api=ctx.remote.channels
    if(!api){if(live)setStatusError(t('error.statusUnavailable'));return}
    try{for await(const frame of api.statusStream(controller.signal)){if(!live)break;apply(frame);void loadProjects()}}
    catch{if(live)setStatusError(t('error.statusFailed'))}
  })()
  return()=>{live=false;controller.abort()}
 },[ctx,t])
 useEffect(()=>{
  if(!confirmation&&!removal)return
  const previous=document.activeElement as HTMLElement|null
  confirmButton.current?.focus()
  const keyboard=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){setConfirmation(null);setRemoval(null)}
   if(event.key==='Tab'){
    const buttons=confirmRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    const first=buttons?.[0],last=buttons?.[buttons.length-1]
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
   }
  }
  window.addEventListener('keydown',keyboard)
  return()=>{window.removeEventListener('keydown',keyboard);previous?.isConnected&&previous.focus()}
 },[confirmation,removal])
 const update=(change:(b:Binding)=>Binding)=>{if(!binding)return;const target=id,original=current;setEdits(previous=>{const before=previous[target]??{value:structuredClone(binding),...(original?{base:structuredClone(original)}:{})},next={...before,value:change(before.value)};return {...previous,[target]:next}});setConfirmation(null);setRemoval(null)}
 const discard=()=>{setEdits(previous=>{const next={...previous};delete next[id];return next});setConfirmation(null);setNotice(t('notice.restored'));setFailure(false)}
 const fail=(text:string)=>{setNotice(text);setFailure(true)}
 const write=async(latest:FormSnapshot,rows:Binding[],agents:AgentGroup[]):Promise<boolean>=>{
  if(!latest.writable||latest.revision===undefined||latest.status!=='ready'){fail(t('error.notWritable'));return false}
  const invalid=validateBindings(rows,t),agentIssue=agentGroupIssue(rows,agents)
  if(invalid||agentIssue){fail(invalid??t(`issue.${agentIssue}`));return false}
  setBusy(true);setNotice('');setFailure(false)
  try{
   const accepted=await form.mutate([{op:'set',path:['bindings'],value:rows},{op:'set',path:['agents'],value:agents}],latest.revision)
   if(!accepted){fail(t('error.rejected'));return false}
   const acknowledged=form.getSnapshot().value
   if(!same(acknowledged?.bindings??[],rows)||!same(acknowledged?.agents??[],agents)){fail(t('error.mismatch'));return false}
   return true
  }catch{fail(t('error.saveFailed'));return false}finally{setBusy(false)}
 }
 const commit=async(target:string,value:Binding,expected:Binding|undefined,requiresDraft=false)=>{
  const latest=form.getSnapshot(),rows=latest.value?.bindings??[],actual=rows.find(b=>b.id===target)
  if(requiresDraft&&!same(edits[target]?.value??actual,value)){fail(t('notice.draftUpdated'));setConfirmation(null);return}
  if(!same(actual,expected)){fail(t('error.stale'));setConfirmation(null);return}
  const agents=resolveAgentGroups(rows,latest.value?.agents)
  if(!actual){
   const agent=agents.find(g=>g.id===edits[target]?.agentId)
   if(!agent){fail(t('error.agentStale'));return}
   agent.bindingIds.push(target)
  }
  const next=actual?rows.map(b=>b.id===target?value:b):[...rows,value]
  setConfirmation(null)
  if(await write(latest,next,agents)){
   setEdits(previous=>{const result={...previous};delete result[target];return result})
   setNotice(t('notice.saved'))
  }
 }
 const createAgent=async()=>{
  if(!newAgent)return
  const latest=form.getSnapshot(),rows=latest.value?.bindings??[],agents=resolveAgentGroups(rows,latest.value?.agents)
  const agent:AgentGroup={id:`agent-${crypto.randomUUID()}`,name:newAgent.name.trim(),cwd:newAgent.cwd,bindingIds:[]}
  if(await write(latest,rows,[...agents,agent])){setSelectedAgentId(agent.id);setSelectedId('');setNewAgent(null);setNotice(t('notice.agentSaved'))}
 }
 const requestRemoval=(kind:Removal['kind'])=>{
  if(!group)return
  const agent=savedGroups.find(g=>g.id===group.id)!
  const ids=kind==='agent'?group.bindingIds:[id]
  setConfirmation(null)
  setRemoval({kind,agent:structuredClone(agent),rows:structuredClone(persisted.filter(b=>ids.includes(b.id))),draftIds:ids.filter(key=>edits[key]!==undefined),label:kind==='agent'?group.name:`${group.name} / ${binding?t(labels[binding.channel.kind]):id}`})
 }
 const remove=async()=>{
  if(!removal)return
  const latest=form.getSnapshot(),rows=latest.value?.bindings??[],agents=resolveAgentGroups(rows,latest.value?.agents)
  const agent=agents.find(g=>g.id===removal.agent.id)
  const confirmedIds=new Set(removal.rows.map(row=>row.id))
  // A local-only draft may have become a saved channel in another Agent since
  // confirmation. It was never confirmed for Host removal: require a fresh review.
  const savedDraft=removal.draftIds.some(key=>!confirmedIds.has(key)&&rows.some(row=>row.id===key))
  if(savedDraft||!same(agent,removal.agent)||removal.rows.some(row=>!same(rows.find(b=>b.id===row.id),row))){setRemoval(null);fail(t('error.agentStale'));return}
  const nextAgents=removal.kind==='agent'?agents.filter(g=>g.id!==removal.agent.id):agents.map(g=>({...g,bindingIds:g.bindingIds.filter(key=>!confirmedIds.has(key))}))
  // Only explicitly confirmed saved rows affect Host configuration. Draft ids
  // participate solely in local cleanup, after the revision-checked save succeeds.
  if(await write(latest,rows.filter(b=>!confirmedIds.has(b.id)),nextAgents)){
   const localIds=new Set([...confirmedIds,...removal.draftIds])
   setEdits(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>!localIds.has(key))))
   setRemoval(null);setSelectedId('');setNotice(t('notice.removed'))
  }
 }
 const requestSave=()=>{if(!binding)return;const invalid=validateBindings([binding],t);if(invalid){fail(invalid);return}if(conflict){fail(t('error.stale'));return}if(current?.enabled&&!same(binding,current)){setConfirmation({id,value:structuredClone(binding),expected:structuredClone(current)});return}void commit(id,structuredClone(binding),edit?.base)}
 const choose=async()=>{const target=id,original=current;setConfirmation(null);try{const path=await ctx.uiWorkspace.pickDirectory();if(path!==null){setConfirmation(null);setEdits(previous=>{const row=previous[target]?.value??original;if(!row)return previous;const before=previous[target]??{value:row,...(original?{base:structuredClone(original)}:{})};return {...previous,[target]:{...before,value:{...before.value,cwd:path}}}})}}catch{fail(t('error.pickFailed'))}}
 const add=(kind:Binding['channel']['kind'])=>{
  if(!group)return
  const key=`${kind}-${crypto.randomUUID().slice(0,8)}`,value:Binding={id:key,enabled:false,cwd:group.cwd,credentialRef:'',permissionPreset:current?.permissionPreset??'',channel:{id:key,kind},...(kind==='weixin'?{weixin:{ownerUserId:'',baseUrl:''}}:{})}
  setEdits(previous=>({...previous,[key]:{value,agentId:group.id}}));setSelectedAgentId(group.id);setSelectedId(key);setNotice(t('notice.newDraft'))
 }
 const chooseAgentDirectory=async()=>{try{const path=await ctx.uiWorkspace.pickDirectory();if(path!==null)setNewAgent(previous=>previous?{...previous,cwd:path}:previous)}catch{fail(t('error.pickFailed'))}}
 if(unsupported)return <section className="dsh-channel-panel"><style>{styles}</style><h2>{t('heading')}</h2><p role="alert" className="dsh-channel-notice dsh-channel-error">{t('issue.channel-kind')}</p><p className="dsh-channel-muted">{t('config.unsupported')}</p></section>
 return <section className="dsh-channel-panel"><style>{styles}</style>
  <h2>{t('heading')}</h2><p className="dsh-channel-muted">{t('intro')}</p>
  <div className="dsh-channel-toolbar"><button className="dsh-channel-add" disabled={busy||!writable||groups.length>=MAX_AGENTS} onClick={()=>setNewAgent({name:'',cwd:''})}>{t('action.addAgent')}</button></div>
  {newAgent&&<form className="dsh-channel-card" aria-label={t('agent.create')} onSubmit={event=>{event.preventDefault();void createAgent()}}><fieldset disabled={busy} style={{border:0,padding:0,margin:0}}><div className="dsh-channel-grid"><Field label={t('agent.name')} value={newAgent.name} set={name=>setNewAgent(previous=>previous?{...previous,name}:previous)}/><label className="dsh-channel-field">{t('agent.cwd')}<div className="dsh-channel-path"><input aria-label={t('agent.cwd')} value={newAgent.cwd} onChange={event=>{const cwd=event.target.value;setNewAgent(previous=>previous?{...previous,cwd}:previous)}}/><button type="button" onClick={()=>void chooseAgentDirectory()}>{t('action.choose')}</button></div></label></div><p className="dsh-channel-muted">{t('agent.hint')}</p><div className="dsh-channel-actions"><button type="button" onClick={()=>setNewAgent(null)}>{t('action.cancel')}</button><button className="dsh-channel-primary" disabled={!writable}>{t('action.createAgent')}</button></div></fieldset></form>}
  <div className="dsh-agent-layout"><nav className="dsh-agent-tabs" aria-label={t('agentGroups')}>{groups.map(g=><button key={g.id} aria-pressed={g.id===group?.id} onClick={()=>{setSelectedAgentId(g.id);setSelectedId(g.bindingIds[0]??'');setConfirmation(null);setRemoval(null);setNotice('')}}><strong>{g.name}</strong><span>{g.bindingIds.length} {t('channelsUnit')}</span></button>)}</nav><div className="dsh-agent-detail">
  {group&&<header className="dsh-agent-header"><div className="dsh-channel-heading"><h3>{group.name}</h3><button className="dsh-channel-danger" disabled={busy||!writable} onClick={()=>requestRemoval('agent')}>{t('action.removeAgent')}</button></div><p className="dsh-channel-path-text">{t('agent.cwd')}{t('punct.colon')}{group.cwd||t('project.none')}</p><p className="dsh-channel-muted">{t('agent.cwdHint')}</p><p className="dsh-channel-muted">{t('model.inheritHint')}</p></header>}
  <div className="dsh-channel-toolbar"><div className="dsh-channel-actions">{Object.entries(labels).map(([kind,key])=><button className="dsh-channel-add" key={kind} disabled={busy||baseRows.length>=32||!writable||!group} onClick={()=>add(kind as Binding['channel']['kind'])}>＋ {t(key)}</button>)}</div><span className="dsh-channel-muted">{t('channels.saved')} {persisted.length} {t('channelsUnit')}{baseRows.length>persisted.length?` · ${baseRows.length-persisted.length} ${t('channels.drafts')}`:''}</span></div>
  {snapshot.status!=='ready'&&<p className="dsh-channel-notice">{snapshot.value?t('syncing'):t('reading')}</p>}
  {notice&&<p role={failure?'alert':'status'} className={`dsh-channel-notice ${failure?'dsh-channel-error':''}`}>{notice}</p>}
  {metadataIssue&&<p role="alert" className="dsh-channel-notice dsh-channel-error">{t(`issue.${metadataIssue}`)}</p>}
  {statusError&&<p className="dsh-channel-muted">{statusError}</p>}
  {!group&&<p className="dsh-channel-muted">{t('agent.empty')}</p>}
  {!binding&&group&&<div className="dsh-channel-card"><h3>{t('noBinding.title')}</h3><p className="dsh-channel-muted">{t('noBinding.body')}</p></div>}
  {group&&<nav className="dsh-channel-tabs" aria-label={t('agentChannels')}>{group.bindingIds.map(key=>{const b=baseRows.find(v=>v.id===key)!;return <button key={key} aria-pressed={key===id} onClick={()=>{setSelectedId(key);setConfirmation(null);setRemoval(null);setNotice('')}}>{t(labels[b.channel.kind])}{edits[key]&&!same(edits[key]!.value,edits[key]!.base)?t('notice.unsaved'):''}</button>})}</nav>}
  {binding&&<article className="dsh-channel-card" key={id}>
   <div className="dsh-channel-heading"><h3>{t(labels[binding.channel.kind])} <span className={`dsh-channel-badge dsh-channel-status ${statusTone(status?.phase)}`}>{phaseLabel(status?.phase,current?.enabled??false,t)}</span></h3><button disabled={busy||dirty||!current||!writable} onClick={()=>current&&void commit(id,{...current,enabled:!current.enabled},current)}>{current?.enabled?t('action.stop'):t('action.start')}</button></div>
   <p className="dsh-channel-muted">{current?.enabled?t('notice.running'):t('notice.stopped')} {t('notice.identity')}</p>
   <p className="dsh-channel-muted" title={project?`${project.id} · ${project.cwd}`:undefined}>{project?`${t('project.owned')}${project.title} · ${shortId(project.id)}`:t('project.pending')}</p>
   {conflict&&<p role="alert" className="dsh-channel-notice dsh-channel-error">{t('notice.conflict')}</p>}
   {status?.error&&<p role="alert" className="dsh-channel-notice dsh-channel-error">{statusMessage(status.error)}</p>}
   {binding.channel.kind==='qqbot'?<QQBotSetup ctx={ctx} t={t} disabled={busy||!writable||!!current?.enabled} onBound={value=>update(b=>({...b,credentialRef:value.credentialRef,channel:{...b.channel,appId:value.appId,ownerUserId:value.ownerUserId}}))}/>:null}
   {binding.channel.kind==='qqbot'?<QQBotCredentials ctx={ctx} t={t} reference={binding.credentialRef} disabled={busy||!writable||!!current?.enabled} onSaved={credentialRef=>update(b=>({...b,credentialRef}))}/>:null}
   <fieldset disabled={busy||!writable} style={{border:0,padding:0,margin:0}}><div className="dsh-channel-stack">
    <label className="dsh-channel-field">{t('model.label')}<select value={selected} onChange={e=>{const value=e.target.value;update(b=>{const {model:_,...rest}=b;return value?{...rest,model:{provider:JSON.parse(value)[0],model:JSON.parse(value)[1]}}:rest})}}><option value="">{t('model.inherit')}{catalog?` · ${catalog.default.model}`:''}</option>{binding.model&&!catalog?.groups.some(g=>g.id===binding.model?.provider&&g.models.some(m=>m.id===binding.model?.model))&&<option value={selected}>{t('model.current')} · {binding.model.provider}/{binding.model.model}{t('model.unknown')}</option>}{catalog?.groups.map(g=><optgroup key={g.id} label={g.name}>{g.models.map(m=><option key={m.id} value={JSON.stringify([g.id,m.id])}>{m.name}</option>)}</optgroup>)}</select></label>
    {model?.reasoning&&<label className="dsh-channel-field">{t('model.reasoning')}<select value={binding.model?.reasoningEffort??''} onChange={e=>{const value=e.target.value;update(b=>{if(!b.model)return b;const {reasoningEffort:_,...selection}=b.model;return {...b,model:{...selection,...(value?{reasoningEffort:value}:{})}}})}}><option value="">{t('model.default')}</option>{model.reasoning.efforts.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>}
   </div><p className="dsh-channel-muted">{t('model.note')}</p>
   {binding.channel.kind==='qqbot'?<details><summary>{t('qq.options')}</summary><div className="dsh-channel-options">{(['streaming','showToolResults','sendPresentedFiles'] as const).map(key=><label className="dsh-channel-option" key={key}><input type="checkbox" checked={binding.channel[key]===undefined?key!=='showToolResults':!!binding.channel[key]} onChange={e=>{const checked=e.target.checked;update(b=>({...b,channel:{...b.channel,[key]:checked}}))}}/><span>{t(`qq.option.${key}`)}</span></label>)}<label className="dsh-channel-option"><input type="checkbox" checked={binding.channel.externalTurns!=='off'} onChange={e=>{const value=e.target.checked?'c2c':'off';update(b=>({...b,channel:{...b.channel,externalTurns:value}}))}}/><span>{t('qq.option.externalTurns')}</span></label><label className="dsh-channel-inline"><span>{t('qq.maxFiles')}</span><input type="number" min={1} max={32} value={Number(binding.channel.maxFiles??4)} onChange={e=>{const value=e.target.valueAsNumber;if(Number.isInteger(value))update(b=>({...b,channel:{...b.channel,maxFiles:value}}))}}/></label></div><p className="dsh-channel-muted">{t('qq.deliveryHint')}</p></details>:null}
   <details><summary>{t('details.label')}</summary><div className="dsh-channel-grid">
    <label className="dsh-channel-field">{t('field.bindingId')}<input value={binding.id} readOnly/></label>
    <Field label={t('field.credential')} value={binding.credentialRef} set={value=>update(b=>({...b,credentialRef:value}))}/>
    <label className="dsh-channel-field dsh-channel-wide">{t('field.cwd')}<div className="dsh-channel-path"><input aria-label={t('field.cwd')} value={binding.cwd} placeholder={t('field.cwdPlaceholder')} onChange={e=>{const value=e.target.value;update(b=>({...b,cwd:value}))}}/><button onClick={()=>void choose()}>{t('action.choose')}</button></div></label>
    <p className="dsh-channel-muted dsh-channel-wide">{t('field.cwdHint')}</p>
    {presets?<label className="dsh-channel-field">{t('field.permission')}<select value={binding.permissionPreset} disabled={busy||!writable} onChange={e=>update(b=>({...b,permissionPreset:e.target.value}))}><option value="">{t('permission.choose')}</option>{!presetListed?<option value={binding.permissionPreset}>{binding.permissionPreset}{t('permission.unknown')}</option>:null}{presets.options.map(option=><option key={option.value} value={option.value}>{option.name}</option>)}</select>{preset?.description?<span className="dsh-channel-muted">{preset.description}</span>:null}</label>:<Field label={t('field.permission')} value={binding.permissionPreset} set={value=>update(b=>({...b,permissionPreset:value}))}/>}
    {channelFields[binding.channel.kind].map(([field,key])=><Field key={field} label={t(key)} value={String(binding.channel[field]??'')} set={value=>update(b=>{const channel={...b.channel};if(b.channel.kind==='qqbot'&&['visionProvider','visionModel'].includes(field)&&!value.trim())delete channel[field];else channel[field]=value;return {...b,channel}})}/>)}
    {binding.channel.kind==='weixin'&&<><Field label={t('field.weixinOwner')} value={binding.weixin?.ownerUserId??''} set={value=>update(b=>({...b,weixin:{ownerUserId:value,baseUrl:b.weixin?.baseUrl??''}}))}/><Field label={t('field.weixinBase')} value={binding.weixin?.baseUrl??''} set={value=>update(b=>({...b,weixin:{ownerUserId:b.weixin?.ownerUserId??'',baseUrl:value}}))}/></>}
   </div></details></fieldset>
   {confirmation?.id===id&&<div ref={confirmRef} role="dialog" aria-modal="true" aria-label={t('dialog.apply')} className="dsh-channel-notice" onKeyDown={event=>{if(event.key==='Escape')setConfirmation(null)}}><strong>{t('confirm.title')} {group?.name} / {t(labels[binding.channel.kind])}{t('punct.question')}</strong><p>{t('confirm.body')}</p><div className="dsh-channel-actions"><button className="dsh-channel-ghost" onClick={()=>setConfirmation(null)}>{t('action.continue')}</button><button ref={confirmButton} className="dsh-channel-primary" disabled={busy} onClick={()=>void commit(confirmation.id,confirmation.value,confirmation.expected,true)}>{t('action.apply')}</button></div></div>}
   <div className="dsh-channel-footer"><span className="dsh-channel-muted">{dirty?t('notice.dirty'):t('notice.clean')}</span><div className="dsh-channel-actions"><button className="dsh-channel-danger" disabled={busy||!writable} onClick={()=>requestRemoval('channel')}>{t('action.removeChannel')}</button><button className="dsh-channel-ghost" disabled={busy||!dirty} onClick={discard}>{t('action.discard')}</button><button className="dsh-channel-primary" disabled={busy||!dirty||!writable} onClick={requestSave}>{busy?t('action.saving'):t('action.save')}</button></div></div>
  </article>}
  {removal&&<div className="dsh-channel-modal"><div ref={confirmRef} role="dialog" aria-modal="true" aria-label={t('dialog.remove')} className="dsh-channel-notice"><strong>{t('remove.title')} {removal.label}</strong><p>{t('remove.body')}</p><p>{t('remove.channels')}</p><ul>{removal.rows.length?removal.rows.map(row=><li key={row.id}>{row.id} · {t(labels[row.channel.kind])} · {row.enabled?t('remove.enabled'):t('remove.disabled')}</li>):<li>{t('remove.none')}</li>}</ul>{removal.draftIds.length>0&&<p>{t('remove.drafts')}</p>}<div className="dsh-channel-actions"><button className="dsh-channel-ghost" ref={confirmButton} disabled={busy} onClick={()=>setRemoval(null)}>{t('action.cancel')}</button><button className="dsh-channel-danger" disabled={busy||!writable} onClick={()=>void remove()}>{t('action.confirmRemove')}</button></div></div></div>}
  {modelsError&&<p className="dsh-channel-muted">{modelsError}</p>}{catalog?.failures.length?<p className="dsh-channel-muted">{t('error.modelsUnavailable')}</p>:null}
 </div></div></section>
}
function Field({label,value,set}:{label:string;value:string;set:(value:string)=>void}){return <label className="dsh-channel-field">{label}<input value={value} autoComplete="off" spellCheck={false} onChange={e=>set(e.target.value)}/></label>}

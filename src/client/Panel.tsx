import {useEffect,useState,useSyncExternalStore} from 'react'
import type {Binding,Catalog,ClientContext,ConfigForm,RuntimeStatus} from './contracts.js'
import {pluginConfigSchema} from '../plugin/config.js'
import {absoluteWorkspacePattern} from '../plugin/workspace-path.js'
import {styles} from './styles.js'

const labels={imessage:'iMessage',telegram:'Telegram',weixin:'微信',discord:'Discord'}
const phases:Record<string,string>={stopped:'已停用 · 未连接',starting:'正在连接',listening:'已连接',reconnecting:'连接中断 · 重连中',failed:'连接失败',stopping:'正在停止',disabled:'已停用 · 未连接',idle:'未连接',error:'连接失败'}
export const phaseLabel=(phase:string|undefined,enabled:boolean)=>phase===undefined?(enabled?'等待宿主状态 · 未确认连接':'已停用 · 未连接'):(phases[phase]??'状态待确认 · 未确认连接')
const channelFields:Record<Binding['channel']['kind'],Array<[string,string]>>={
  imessage:[['projectId','项目 ID'],['senderPhoneNumber','允许的发送号码（国际格式）'],['assignedPhoneNumber','分配号码（国际格式）']],
  telegram:[['botId','Bot ID'],['ownerUserId','允许的用户 ID']],
  weixin:[['accountId','账号 ID']],
  discord:[['botId','Bot ID'],['ownerUserId','允许的用户 ID'],['guildId','服务器 ID（可选）'],['channelId','频道 ID（可选）']],
}
export function validateBindings(bindings:Binding[]):string|undefined {
  if(bindings.length>32)return '最多配置 32 个渠道。'
  const ids=new Set<string>()
  for(const b of bindings){
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(b.id)||ids.has(b.id))return '渠道标识须唯一，限 1–64 个字母、数字、下划线或短横线。'
    ids.add(b.id)
    if(!absoluteWorkspacePattern.test(b.cwd))return `${b.id}：请选择绝对项目路径。`
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.credentialRef))return `${b.id}：请填写宿主已配置的凭据引用名称。`
    if(!b.permissionPreset.trim())return `${b.id}：请指定宿主已有的权限预设。`
    for(const [field,label] of channelFields[b.channel.kind])if(!['guildId','channelId'].includes(field)&&!b.channel[field]?.trim())return `${b.id}：请填写${label}。`
    if(b.channel.kind==='discord'&&Boolean(b.channel.guildId)!==Boolean(b.channel.channelId))return `${b.id}：服务器 ID 与频道 ID 须同时填写或同时留空。`
    if(b.channel.kind==='weixin'&&(!b.weixin?.ownerUserId.trim()||!/^https?:\/\//.test(b.weixin.baseUrl)))return `${b.id}：请填写微信用户 ID 和有效的 API 地址。`
  }
  if(!pluginConfigSchema.safeParse({bindings}).success)return '渠道配置未通过校验：请检查身份、账号唯一性及字段格式。'
  return undefined
}

export function ChannelPanel({ctx,channelForm,view}:{ctx:ClientContext;channelForm:ConfigForm;view?:string}){
  if(view==='summary')return '管理 iMessage、Telegram、微信和 Discord，复用宿主模型与权限；新增渠道默认停用。'
  return <ChannelEditor ctx={ctx} form={channelForm}/>
}
type Edit={value:Binding;base?:Binding}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b))
export function agentGroups(bindings:Binding[]){
 const groups=new Map<string,{id:string;name:string;cwd:string;prefix:string;ids:string[]}>()
 for(const b of bindings){const prefix=/^(.+)-(?:imessage|telegram|weixin|discord)(?:-|$)/.exec(b.id)?.[1]??'',identity=prefix||b.id,id=JSON.stringify([identity,b.cwd]);let group=groups.get(id);if(!group){const name=prefix?prefix.replace(/^./,c=>c.toUpperCase()):(b.cwd.split('/').filter(Boolean).at(-1)||'新 Agent');group={id,name,cwd:b.cwd,prefix,ids:[]};groups.set(id,group)}group.ids.push(b.id)}
 return [...groups.values()]
}
function ChannelEditor({ctx,form}:{ctx:ClientContext;form:ConfigForm}){
 const snapshot=useSyncExternalStore(listener=>form.subscribe(listener),()=>form.getSnapshot(),()=>form.getSnapshot())
 const persisted=snapshot.value?.bindings??[]
 const [edits,setEdits]=useState<Record<string,Edit>>({}),[selectedId,setSelectedId]=useState(persisted[0]?.id??'')
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[failure,setFailure]=useState(false)
 const [confirmation,setConfirmation]=useState<{id:string;value:Binding;expected:Binding}|null>(null)
 const [catalog,setCatalog]=useState<Catalog>(),[modelsError,setModelsError]=useState('')
 const [runtime,setRuntime]=useState<RuntimeStatus[]>([]),[statusError,setStatusError]=useState('')
 const [projects,setProjects]=useState<Array<{id:string;title:string;cwd:string;bindingIds:string[]}>>([])
 const baseRows=[...persisted,...Object.values(edits).filter(e=>e.base===undefined&&!persisted.some(b=>b.id===e.value.id)).map(e=>e.value)]
 const groups=agentGroups(baseRows),id=baseRows.some(b=>b.id===selectedId)?selectedId:baseRows[0]?.id??''
 const current=persisted.find(b=>b.id===id),edit=edits[id],binding=edit?.value??current,group=groups.find(g=>g.ids.includes(id))
 const dirty=Boolean(edit&&!same(edit.value,edit.base)),conflict=Boolean(edit&&!same(edit.base,current))
 const status=runtime.find(s=>s.id===id),selected=binding?.model?JSON.stringify([binding.model.provider,binding.model.model]):''
 const model=catalog?.groups.find(g=>g.id===binding?.model?.provider)?.models.find(m=>m.id===binding?.model?.model)
 const project=projects.find(p=>p.bindingIds.includes(id)&&p.cwd===group?.cwd)
 useEffect(()=>{let live=true;void ctx.remote.session.modelCatalog().then(result=>{if(!live)return;if(result.ok)setCatalog(result.value);else setModelsError('宿主模型目录读取失败。')},()=>{if(live)setModelsError('宿主模型目录暂不可用；可以保留现有选择。')});return()=>{live=false}},[ctx])
 useEffect(()=>{let live=true,inflight=false;const refresh=async()=>{if(inflight)return;inflight=true;try{await Promise.all([
  (async()=>{const api=ctx.remote.channels;if(!api){if(live)setStatusError('运行状态接口尚不可用。');return}const result=await api.status();if(live){if(result.ok){setRuntime(result.value.bindings);setStatusError(result.value.configError??'')}else setStatusError('运行状态暂不可用。')}})(),
  (async()=>{const api=ctx.remote.channelProjects;if(!api)return;const result=await api.status();if(live&&result.ok)setProjects(result.value.projects)})(),
 ])}catch{if(live)setStatusError('运行状态暂不可用。')}finally{inflight=false}};void refresh();const timer=setInterval(()=>void refresh(),4000);return()=>{live=false;clearInterval(timer)}},[ctx])
 const update=(change:(b:Binding)=>Binding)=>{if(!binding)return;const target=id,original=current;setEdits(previous=>{const before=previous[target]??{value:structuredClone(binding),...(original?{base:structuredClone(original)}:{})},next={...before,value:change(before.value)};return {...previous,[target]:next}});setConfirmation(null)}
 const discard=()=>{setEdits(previous=>{const next={...previous};delete next[id];return next});setConfirmation(null);setNotice('已恢复此渠道的宿主当前配置。');setFailure(false)}
 const fail=(text:string)=>{setNotice(text);setFailure(true)}
 const commit=async(target:string,value:Binding,expected:Binding|undefined,requiresDraft=false)=>{
  const latest=form.getSnapshot(),rows=latest.value?.bindings??[],actual=rows.find(b=>b.id===target)
  if(requiresDraft&&!same(edits[target]?.value??actual,value)){fail('草稿已更新，请重新保存并确认。');setConfirmation(null);return}
  if(!latest.writable||latest.revision===undefined||latest.status!=='ready'){fail('宿主配置尚未就绪或不可写；草稿已保留。');return}
  if(!same(actual,expected)){fail('此渠道已被其他设置修改；草稿已保留。请取消编辑以载入当前配置。');setConfirmation(null);return}
  const next=actual?rows.map(b=>b.id===target?value:b):[...rows,value],invalid=validateBindings(next)
  if(invalid){fail(invalid);return}
  setBusy(true);setNotice('');setFailure(false);setConfirmation(null)
  try{const accepted=await form.mutate([{op:'set',path:['bindings'],value:next}],latest.revision)
   if(!accepted){fail('宿主未接受保存，草稿已保留。可能存在配置冲突或校验错误；请取消编辑以重新载入，或修正后重试。');return}
   const acknowledged=form.getSnapshot().value?.bindings?.find(b=>b.id===target)
   if(!acknowledged||!same(acknowledged,value)){fail('保存已提交，但宿主确认值与草稿不一致；草稿已保留，请重新读取后核对。');return}
   setEdits(previous=>{const result={...previous};delete result[target];return result})
   setNotice('配置已保存；实际连接状态以下方宿主状态为准。')
  }catch{fail('保存未确认，草稿已保留。请重新读取宿主配置后再决定是否重试。')}finally{setBusy(false)}
 }
 const requestSave=()=>{if(!binding)return;const invalid=validateBindings([binding]);if(invalid){fail(invalid);return}if(conflict){fail('此渠道已被其他设置修改；草稿已保留。请取消编辑以载入当前配置。');return}if(current?.enabled&&!same(binding,current)){setConfirmation({id,value:structuredClone(binding),expected:structuredClone(current)});return}void commit(id,structuredClone(binding),edit?.base)}
 const choose=async()=>{const target=id,original=current;setConfirmation(null);try{const path=await ctx.uiWorkspace.pickDirectory();if(path!==null){setConfirmation(null);setEdits(previous=>{const row=previous[target]?.value??original;if(!row)return previous;const before=previous[target]??{value:row,...(original?{base:structuredClone(original)}:{})};return {...previous,[target]:{...before,value:{...before.value,cwd:path}}}})}}catch{fail('目录选择未完成；当前路径未更改。')}}
 const add=(kind:Binding['channel']['kind'])=>{const key=`${group?.prefix?group.prefix+'-':''}${kind}-${crypto.randomUUID().slice(0,8)}`,value:Binding={id:key,enabled:false,cwd:group?.cwd??'',credentialRef:'',permissionPreset:current?.permissionPreset??'',channel:{id:key,kind},...(kind==='weixin'?{weixin:{ownerUserId:'',baseUrl:''}}:{})};setEdits(previous=>({...previous,[key]:{value}}));setSelectedId(key);setNotice('新渠道尚未保存，也未连接。')}
 return <section className="dsh-channel-panel"><style>{styles}</style>
  <h2>Agent 与消息渠道</h2><p className="dsh-channel-muted">先选择 Agent，再配置它的消息渠道。运行中也可编辑草稿；保存只影响当前渠道。</p>
  <div className="dsh-agent-layout"><nav className="dsh-agent-tabs" aria-label="Agent 分组">{groups.map(g=><button key={g.id} aria-pressed={g.id===group?.id} onClick={()=>{setSelectedId(g.ids[0]!);setConfirmation(null);setNotice('')}}><strong>{g.name}</strong><span>{g.ids.length} 个渠道</span></button>)}</nav><div className="dsh-agent-detail">
  {group&&<header className="dsh-agent-header"><h3>{group.name}</h3><p className="dsh-channel-path-text">{group.cwd||'尚未选择项目目录'}</p><p className="dsh-channel-muted">{project?`DSH 项目：${project.title} · ${project.id}`:'DSH 项目归属待宿主确认。'} 模型默认继承 DSH 设置；每条渠道可以单独覆盖。</p></header>}
  <div className="dsh-channel-toolbar"><div className="dsh-channel-actions">{Object.entries(labels).map(([kind,label])=><button key={kind} disabled={busy||baseRows.length>=32||!snapshot.writable} onClick={()=>add(kind as Binding['channel']['kind'])}>＋ {label}</button>)}</div><span className="dsh-channel-muted">{baseRows.length} / 32 个渠道</span></div>
  {snapshot.status!=='ready'&&<p className="dsh-channel-notice">{snapshot.value?'正在同步宿主配置…':'正在读取宿主配置；暂时不能保存。'}</p>}
  {notice&&<p role={failure?'alert':'status'} className={`dsh-channel-notice ${failure?'dsh-channel-error':''}`}>{notice}</p>}
  {statusError&&<p className="dsh-channel-muted">{statusError}</p>}
  {!binding&&<div className="dsh-channel-card"><h3>尚未配置渠道</h3><p className="dsh-channel-muted">选择上方渠道类型开始配置。保存配置后，再显式启动连接。</p><button disabled>保存配置</button></div>}
  {group&&<nav className="dsh-channel-tabs" aria-label="Agent 所属渠道">{group.ids.map(key=>{const b=baseRows.find(v=>v.id===key)!;return <button key={key} aria-pressed={key===id} onClick={()=>{setSelectedId(key);setConfirmation(null);setNotice('')}}>{labels[b.channel.kind]}{edits[key]&&!same(edits[key]!.value,edits[key]!.base)?' · 未保存':''}</button>})}</nav>}
  {binding&&<article className="dsh-channel-card" key={id}>
   <div className="dsh-channel-heading"><h3>{labels[binding.channel.kind]} <span className="dsh-channel-badge">{phaseLabel(status?.phase,current?.enabled??false)}</span></h3><button disabled={busy||dirty||!current||!snapshot.writable} onClick={()=>current&&void commit(id,{...current,enabled:!current.enabled},current)}>{current?.enabled?'停止':'启动'}</button></div>
   <p className="dsh-channel-muted">{current?.enabled?'连接保持运行；编辑草稿不会中断消息。':'新增或已停用渠道；保存后仍需显式启动。'} 渠道标识和已有数据保持不变。</p>
   {conflict&&<p role="alert" className="dsh-channel-notice dsh-channel-error">此渠道的宿主配置已变化，当前草稿尚未覆盖它。取消编辑后可载入最新值。</p>}
   {status?.error&&<p role="alert" className="dsh-channel-notice dsh-channel-error">{status.error}</p>}
   <fieldset disabled={busy||!snapshot.writable} style={{border:0,padding:0,margin:0}}><div className="dsh-channel-grid">
    <label className="dsh-channel-field">宿主模型<select value={selected} onChange={e=>{const value=e.target.value;update(b=>{const {model:_,...rest}=b;return value?{...rest,model:{provider:JSON.parse(value)[0],model:JSON.parse(value)[1]}}:rest})}}><option value="">继承 DSH 默认{catalog?` · ${catalog.default.model}`:''}</option>{binding.model&&!catalog?.groups.some(g=>g.id===binding.model?.provider&&g.models.some(m=>m.id===binding.model?.model))&&<option value={selected}>当前覆盖 · {binding.model.provider}/{binding.model.model}（目录未确认）</option>}{catalog?.groups.map(g=><optgroup key={g.id} label={g.name}>{g.models.map(m=><option key={m.id} value={JSON.stringify([g.id,m.id])}>{m.name}</option>)}</optgroup>)}</select></label>
    {model?.reasoning&&<label className="dsh-channel-field">推理强度<select value={binding.model?.reasoningEffort??''} onChange={e=>{const value=e.target.value;update(b=>{if(!b.model)return b;const {reasoningEffort:_,...selection}=b.model;return {...b,model:{...selection,...(value?{reasoningEffort:value}:{})}}})}}><option value="">模型默认</option>{model.reasoning.efforts.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>}
   </div><p className="dsh-channel-muted">选择具体模型仅覆盖此渠道；“继承 DSH 默认”会移除此渠道覆盖。Agent 内其他渠道不变。已有会话保留原会话的模型与权限。</p>
   <details><summary>项目目录、连接与身份设置</summary><div className="dsh-channel-grid">
    <label className="dsh-channel-field">渠道标识<input value={binding.id} readOnly/></label>
    <Field label="凭据引用（宿主已配置）" value={binding.credentialRef} set={value=>update(b=>({...b,credentialRef:value}))}/>
    <label className="dsh-channel-field dsh-channel-wide">项目目录 · 此渠道的当前配置路径<div className="dsh-channel-path"><input aria-label="项目目录" value={binding.cwd} placeholder="/Users/…/project" onChange={e=>{const value=e.target.value;update(b=>({...b,cwd:value}))}}/><button onClick={()=>void choose()}>选择目录…</button></div></label>
    <p className="dsh-channel-muted dsh-channel-wide">此处修改目录只移动当前渠道到对应的 Agent 项目分组，其他渠道目录不变。</p>
    <Field label="宿主权限预设" value={binding.permissionPreset} set={value=>update(b=>({...b,permissionPreset:value}))}/>
    {channelFields[binding.channel.kind].map(([field,label])=><Field key={field} label={label} value={binding.channel[field]??''} set={value=>update(b=>{const channel={...b.channel};if(value||!['guildId','channelId'].includes(field))channel[field]=value;else delete channel[field];return {...b,channel}})}/>)}
    {binding.channel.kind==='weixin'&&<><Field label="微信允许的用户 ID" value={binding.weixin?.ownerUserId??''} set={value=>update(b=>({...b,weixin:{ownerUserId:value,baseUrl:b.weixin?.baseUrl??''}}))}/><Field label="微信 API 地址" value={binding.weixin?.baseUrl??''} set={value=>update(b=>({...b,weixin:{ownerUserId:b.weixin?.ownerUserId??'',baseUrl:value}}))}/></>}
   </div></details></fieldset>
   {confirmation?.id===id&&<div role="dialog" aria-label="应用渠道更改" className="dsh-channel-notice"><strong>应用更改到 {group?.name} / {labels[binding.channel.kind]}？</strong><p>此渠道将重新连接，并使用新的渠道会话；原会话历史保留。其他渠道继续运行。</p><div className="dsh-channel-actions"><button onClick={()=>setConfirmation(null)}>继续编辑</button><button className="dsh-channel-primary" disabled={busy} onClick={()=>void commit(confirmation.id,confirmation.value,confirmation.expected,true)}>确认应用并重新连接此渠道</button></div></div>}
   <div className="dsh-channel-toolbar"><span className="dsh-channel-muted">{dirty?'此渠道有未保存更改；切换 Agent 或渠道会保留草稿。':'此渠道与宿主已保存配置一致。'}</span><div className="dsh-channel-actions"><button disabled={busy||!dirty} onClick={discard}>取消编辑</button><button className="dsh-channel-primary" disabled={busy||!dirty||!snapshot.writable||snapshot.revision===undefined} onClick={requestSave}>{busy?'保存中…':'保存配置'}</button></div></div>
  </article>}
  {modelsError&&<p className="dsh-channel-muted">{modelsError}</p>}{catalog?.failures.length?<p className="dsh-channel-muted">部分宿主模型提供方暂不可用；列表显示当前可用模型。</p>:null}
 </div></div></section>
}
function Field({label,value,set}:{label:string;value:string;set:(value:string)=>void}){return <label className="dsh-channel-field">{label}<input value={value} autoComplete="off" spellCheck={false} onChange={e=>set(e.target.value)}/></label>}

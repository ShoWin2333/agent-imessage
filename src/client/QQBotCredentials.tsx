import {useEffect,useMemo,useState} from 'react'
import type {ClientContext} from './contracts.js'
import type {Translate} from './Panel.js'
/** Host timestamps arrive as ISO strings; render local wall-clock time instead. */
const formatStamp=(iso:string):string=>{
  const date=new Date(iso)
  if(Number.isNaN(date.getTime()))return iso
  const pad=(value:number)=>String(value).padStart(2,'0')
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
export function QQBotCredentials({ctx,t,reference,disabled,onSaved}:{ctx:ClientContext;t:Translate;reference:string;disabled:boolean;onSaved:(ref:string)=>void}){
  const api=useMemo(()=>ctx.remote.qqBotSetup,[ctx]),[runtime,setRuntime]=useState(''),[status,setStatus]=useState(''),[secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[manual,setManual]=useState(false)
  useEffect(()=>{let live=true;void api?.runtime?.().then(r=>{if(live&&r.ok)setRuntime(`${r.value.version} · ${formatStamp(r.value.startedAt)}`)});return()=>{live=false}},[api])
  const check=async()=>{setBusy(true);try{const r=await api?.credentialStatus?.(reference);setStatus(r?.ok?`${t(r.value.configured?'qq.credentialReady':'qq.credentialMissing')}${r.value.source?` · ${r.value.source}`:''}`:t('qq.credentialFailed'))}catch{setStatus(t('qq.credentialFailed'))}finally{setBusy(false)}}
  const save=async()=>{setBusy(true);try{const ref=`QQBOT_${crypto.randomUUID().replaceAll('-','')}`,r=await api?.saveCredential?.(ref,secret);if(!r?.ok)throw new Error();setSecret('');setManual(false);onSaved(ref);setStatus(t('qq.credentialSaved'))}catch{setStatus(t('qq.credentialFailed'))}finally{setBusy(false)}}
  return <section aria-label={t('qq.credentials')} className="dsh-channel-notice">
    <p className="dsh-channel-muted">{t('qq.runtime')} {runtime||'…'}</p>
    <div className="dsh-channel-actions"><button disabled={busy||!reference||!api?.credentialStatus} onClick={()=>void check()}>{t('qq.checkCredential')}</button><button disabled={disabled||busy||!api?.saveCredential} onClick={()=>setManual(v=>!v)}>{t('qq.manual')}</button></div>
    {disabled?<p className="dsh-channel-muted">{t('qq.disabledHint')}</p>:null}
    {manual?<div><label className="dsh-channel-field">AppSecret<input type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)}/></label><p className="dsh-channel-muted">{t('qq.credentialHint')}</p><button className="dsh-channel-primary" disabled={busy||!secret.trim()||disabled} onClick={()=>void save()}>{t('qq.saveCredential')}</button></div>:null}
    {status?<p role="status" className="dsh-channel-muted">{status}</p>:null}
  </section>
}

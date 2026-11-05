import {useEffect,useMemo,useRef,useState} from 'react'
import type {Binding,ClientContext,QQSetupState} from './contracts.js'
import type {Translate} from './Panel.js'
export function QQBotSetup({ctx,t,disabled,onBound}:{ctx:ClientContext;t:Translate;disabled:boolean;onBound:(value:Pick<Binding,'credentialRef'>&{appId:string;ownerUserId:string})=>void}){
  const [state,setState]=useState<QQSetupState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false)
  const active=useRef<string>(),generation=useRef(0),bound=useRef(onBound);bound.current=onBound
  const api=useMemo(()=>ctx.remote.qqBotSetup,[ctx])
  useEffect(()=>()=>{generation.current++;if(active.current)void api?.cancel(active.current).catch(()=>{})},[api])
  useEffect(()=>{
    if(!api||!state?.id||!['waiting','saving'].includes(state.phase))return
    let live=true,timer:ReturnType<typeof setTimeout>|undefined
    const poll=async()=>{
      try{
        const result=await api.status(state.id)
        if(!live)return
        if(!result.ok)throw new Error('Failed')
        const next=result.value;setState(next)
        if(next.phase==='complete'&&next.appId&&next.ownerUserId&&next.credentialRef){active.current=undefined;bound.current({appId:next.appId,ownerUserId:next.ownerUserId,credentialRef:next.credentialRef});return}
        if(['waiting','saving'].includes(next.phase))timer=setTimeout(()=>void poll(),1000)
      }catch{if(live){setError(true);setState(null)}}
    }
    timer=setTimeout(()=>void poll(),1000)
    return()=>{live=false;clearTimeout(timer)}
  },[api,state?.id,state?.phase])
  const start=async()=>{
    if(!api)return
    const run=++generation.current
    setBusy(true);setError(false)
    try{
      const result=await api.start(`QQBOT_${crypto.randomUUID().replaceAll('-','')}`)
      if(run!==generation.current){if(result.ok)void api.cancel(result.value.id);return}
      if(!result.ok)throw new Error('Failed')
      active.current=result.value.id;setState(result.value)
    }catch{if(run===generation.current)setError(true)}finally{if(run===generation.current)setBusy(false)}
  }
  const cancel=async()=>{generation.current++;if(active.current)await api?.cancel(active.current);active.current=undefined;setState(null);setBusy(false)}
  return <section aria-label={t('qq.setup')} className="dsh-channel-notice">
    <p>{t('qq.hint')}</p>
    <div className="dsh-channel-actions"><button disabled={disabled||busy||!api||state?.phase==='saving'} onClick={()=>void start()}>{state?.phase==='waiting'?t('qq.refresh'):t('qq.connect')}</button>{state?.phase==='waiting'?<button onClick={()=>void cancel()}>{t('action.cancel')}</button>:null}</div>
    {busy?<p role="status">{t('qq.waiting')}</p>:null}
    {state?.phase==='waiting'?<div>{state.qrSvg?<img width="240" height="240" src={state.qrSvg} alt={t('qq.scan')}/>:<p>{t('qq.waiting')}</p>}{state.url?<p><a href={state.url} target="_blank" rel="noreferrer">{t('qq.open')}</a></p>:null}</div>:null}
    {state?.phase==='saving'?<p role="status">{t('qq.saving')}</p>:null}
    {state?.phase==='complete'?<p role="status">{t('qq.complete')}</p>:null}
    {error||state?.phase==='failed'?<p role="alert">{t('qq.failed')}</p>:null}
  </section>
}

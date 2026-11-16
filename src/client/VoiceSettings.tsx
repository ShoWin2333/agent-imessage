import {useEffect,useMemo,useState} from 'react'
import type {ClientContext,ConfigForm,FormSnapshot,VoiceConfig} from './contracts.js'
import type {Translate} from './Panel.js'

/** Defaults mirror the Host schema so a fresh profile opens with a usable form. */
export const VOICE_DEFAULTS: VoiceConfig = {
  enabled:false,
  credentialRef:'CHANNELS_OPENAI_API_KEY',
  baseURL:'https://api.openai.com/v1',
  model:'gpt-audio',
  voice:'alloy',
  instructions:'',
}

const same=(a:VoiceConfig,b:VoiceConfig)=>JSON.stringify(a)===JSON.stringify(b)

/**
 * Deployment-wide speech settings. The API key is write-only: it goes into the
 * Host credential store and only its presence is ever read back.
 */
export function VoiceSettings({ctx,t,form,snapshot}:{ctx:ClientContext;t:Translate;form:ConfigForm;snapshot:FormSnapshot}){
  const persisted=snapshot.value?.voice??VOICE_DEFAULTS
  const [draft,setDraft]=useState<VoiceConfig>(persisted)
  const [baseline,setBaseline]=useState<VoiceConfig>(persisted)
  const [secret,setSecret]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[failure,setFailure]=useState(false)
  const api=useMemo(()=>ctx.remote.channels,[ctx])
  const writable=snapshot.writable&&snapshot.status==='ready'&&snapshot.revision!==undefined
  useEffect(()=>{setDraft(persisted);setBaseline(persisted)},[JSON.stringify(persisted)])
  useEffect(()=>{
    let live=true
    const reference=draft.credentialRef.trim()
    if(!api?.voiceKeyStatus||!reference){setStatus('');return}
    void api.voiceKeyStatus(reference).then(result=>{if(live&&result.ok)setStatus(result.value.configured?t('voice.keyReady'):t('voice.keyMissing'))},()=>{})
    return()=>{live=false}
  },[api,draft.credentialRef,t])
  const update=(change:(value:VoiceConfig)=>VoiceConfig)=>setDraft(previous=>change(previous))
  const save=async()=>{
    const latest=form.getSnapshot()
    if(!latest.writable||latest.revision===undefined||latest.status!=='ready'){setStatus(t('error.notWritable'));setFailure(true);return}
    setBusy(true);setFailure(false)
    try{
      const accepted=await form.mutate([{op:'set',path:['voice'],value:draft}],latest.revision)
      if(!accepted){setStatus(t('error.rejected'));setFailure(true);return}
      setBaseline(draft);setStatus(t('notice.saved'))
    }catch{setStatus(t('error.saveFailed'));setFailure(true)}
    finally{setBusy(false)}
  }
  const saveKey=async()=>{
    const reference=draft.credentialRef.trim()
    if(!api?.voiceKey||!reference||!secret.trim())return
    setBusy(true);setFailure(false)
    try{
      const result=await api.voiceKey(reference,secret.trim())
      if(!result.ok)throw new Error(result.error?.message)
      setSecret('');setStatus(t('voice.keySaved'))
    }catch{setStatus(t('voice.keyFailed'));setFailure(true)}
    finally{setBusy(false)}
  }
  const dirty=!same(draft,baseline)
  const field=(label:string,key:'baseURL'|'credentialRef'|'model'|'voice',placeholder:string)=>(
    <label className="dsh-channel-field">{t(label)}
      <input value={draft[key]} placeholder={placeholder} autoComplete="off" spellCheck={false}
        onChange={event=>{const value=event.target.value;update(previous=>({...previous,[key]:value}))}}/>
    </label>
  )
  return <details className="dsh-channel-card" open={draft.enabled}>
    <summary>{t('voice.section')}</summary>
    <p className="dsh-channel-muted">{t('voice.hint')}</p>
    <fieldset disabled={busy||!writable} style={{border:0,padding:0,margin:0}}>
      <div className="dsh-channel-options">
        <label className="dsh-channel-option"><input type="checkbox" checked={draft.enabled} onChange={event=>{const value=event.target.checked;update(previous=>({...previous,enabled:value}))}}/><span>{t('voice.enabled')}</span></label>
      </div>
      <div className="dsh-channel-grid">
        {field('voice.model','model','gpt-audio')}
        {field('voice.voice','voice','alloy')}
        {field('voice.baseURL','baseURL','https://api.openai.com/v1')}
        {field('voice.credentialRef','credentialRef','CHANNELS_OPENAI_API_KEY')}
      </div>
      <p className="dsh-channel-muted">{t('voice.modelHint')}</p>
      <label className="dsh-channel-field">{t('voice.instructions')}
        <textarea rows={3} value={draft.instructions} placeholder={t('voice.instructionsPlaceholder')} onChange={event=>{const value=event.target.value;update(previous=>({...previous,instructions:value}))}}/>
      </label>
      <div className="dsh-channel-grid">
        <label className="dsh-channel-field dsh-channel-wide">{t('voice.apiKey')}
          <div className="dsh-channel-path">
            <input type="password" autoComplete="new-password" value={secret} placeholder={t('voice.apiKeyPlaceholder')} onChange={event=>setSecret(event.target.value)}/>
            <button type="button" disabled={busy||!secret.trim()||!api?.voiceKey} onClick={()=>void saveKey()}>{t('voice.saveKey')}</button>
          </div>
        </label>
      </div>
      <p className="dsh-channel-muted">{t('voice.keyHint')}</p>
    </fieldset>
    {status?<p role={failure?'alert':'status'} className={`dsh-channel-notice ${failure?'dsh-channel-error':''}`}>{status}</p>:null}
    <div className="dsh-channel-actions">
      <button className="dsh-channel-ghost" disabled={busy||!dirty} onClick={()=>setDraft(baseline)}>{t('voice.discardSettings')}</button>
      <button className="dsh-channel-primary" disabled={busy||!dirty||!writable} onClick={()=>void save()}>{busy?t('action.saving'):t('voice.saveSettings')}</button>
    </div>
    <p className="dsh-channel-muted">{t('voice.restartHint')}</p>
  </details>
}

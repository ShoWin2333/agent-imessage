import {ChannelPanel} from './Panel.js'
import {NS,dictionaries,fallbackTranslate} from './locale.js'
import type {ClientContext,PermissionCatalog} from './contracts.js'

/**
 * Read-only permission catalog for the preset select. Claimed as an optional
 * namespace: a Host without the catalog keeps the plain text field.
 */
const PERMISSION_CATALOG_TIMEOUT_MS=1500
type PermissionResult={dispose:()=>Promise<void>;presets?:PermissionCatalog}
async function readPermissionCatalog(ctx:ClientContext):Promise<PermissionResult>{
  let settle:(value:PermissionCatalog|undefined)=>void=()=>{}
  const catalog=new Promise<PermissionCatalog|undefined>(resolve=>{settle=resolve})
  const claim=ctx.inject(['remote.permissionPresets'],scoped=>{
    const api=scoped.remote.permissionPresets
    if(api)void api.catalog().then(result=>settle(result.ok?result.value:undefined),()=>settle(undefined))
    else settle(undefined)
    return ()=>settle(undefined)
  })
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    const timeout=new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),PERMISSION_CATALOG_TIMEOUT_MS)})
    const presets=await Promise.race([catalog,timeout])
    return {dispose:async()=>{await claim?.dispose?.()},...(presets===undefined?{}:{presets})}
  } catch(error) {await claim?.dispose?.();throw error}
  finally {if(timer!==undefined)clearTimeout(timer)}
}

/** Mount generated Host metadata before exposing a page that calls its namespace. */
export async function installPanel(ctx:ClientContext,contribution:unknown):Promise<()=>Promise<void>> {
  // This namespace is outside the static LocaleNamespaceMap, so register each locale
  // with the single-locale form; the active language then falls back through `en`.
  const releases=[ctx.locale?.register(NS,'en',dictionaries.en),ctx.locale?.register(NS,'zh',dictionaries.zh)].filter((release):release is()=>void=>release!==undefined)
  const releaseLocale=()=>{for(const release of releases.splice(0).reverse())release()}
  const unmount=await ctx.remote.$mount(contribution).catch(error=>{releaseLocale();throw error})
  const permission=await readPermissionCatalog(ctx).catch(():PermissionResult=>({dispose:async()=>{}}))
  let pageScope:ReturnType<ClientContext['inject']>|undefined
  try {
    // $mount publishes these namespaces. A child scope must explicitly claim
    // them before the rendered view can access them through Cordis's guard.
    pageScope=ctx.inject(['remote.channels','remote.channelProjects','remote.qqBotSetup'],scoped=>{
      const form=scoped.configForms.get('dsh-channels')
      return scoped.configForms.whileServed(['dsh-channels'],()=>scoped.slots.inject('settings.section',()=>scoped.slots.register({
        name:'settings.section',id:'dsh-channels',order:55,
        // A thunk is re-read on every projection, so the navigation label follows the active locale.
        label:()=>(scoped.locale?.bind(NS)??fallbackTranslate)('nav.title'),
        inject:()=>({ctx:scoped,channelForm:form,presets:permission.presets}),
      },ChannelPanel)))
    })
    await pageScope
  } catch(error) {try{await pageScope?.dispose()}finally{await permission.dispose();releaseLocale();await unmount?.()}throw error}
  let disposal:Promise<void>|undefined
  return ()=>disposal??=(async()=>{try{await pageScope?.dispose()}finally{await permission.dispose();releaseLocale();await unmount?.()}})()
}

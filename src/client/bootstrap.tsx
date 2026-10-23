import {ChannelPanel} from './Panel.js'
import {NS,dictionaries,fallbackTranslate} from './locale.js'
import type {ClientContext} from './contracts.js'

/** Mount generated Host metadata before exposing a page that calls its namespace. */
export async function installPanel(ctx:ClientContext,contribution:unknown):Promise<()=>Promise<void>> {
  // This namespace is outside the static LocaleNamespaceMap, so register each locale
  // with the single-locale form; the active language then falls back through `en`.
  const releases=[ctx.locale?.register(NS,'en',dictionaries.en),ctx.locale?.register(NS,'zh',dictionaries.zh)].filter((release):release is()=>void=>release!==undefined)
  const releaseLocale=()=>{for(const release of releases.splice(0).reverse())release()}
  const unmount=await ctx.remote.$mount(contribution).catch(error=>{releaseLocale();throw error})
  let pageScope:ReturnType<ClientContext['inject']>|undefined
  try {
    // $mount publishes these namespaces. A child scope must explicitly claim
    // them before the rendered view can access them through Cordis's guard.
    pageScope=ctx.inject(['remote.channels','remote.channelProjects'],scoped=>{
      const form=scoped.configForms.get('dsh-channels')
      return scoped.configForms.whileServed(['dsh-channels'],()=>scoped.slots.inject('settings.section',()=>scoped.slots.register({
        name:'settings.section',id:'dsh-channels',order:55,
        // A thunk is re-read on every projection, so the navigation label follows the active locale.
        label:()=>(scoped.locale?.bind(NS)??fallbackTranslate)('nav.title'),
        inject:()=>({ctx:scoped,channelForm:form}),
      },ChannelPanel)))
    })
    await pageScope
  } catch(error) {try{await pageScope?.dispose()}finally{releaseLocale();await unmount?.()}throw error}
  let disposal:Promise<void>|undefined
  return ()=>disposal??=(async()=>{try{await pageScope?.dispose()}finally{releaseLocale();await unmount?.()}})()
}

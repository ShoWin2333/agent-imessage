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
  let releasePage:(()=>void)|undefined
  try {
    const form=ctx.configForms.get('agent-imessage-dsh-channels')
    releasePage=ctx.configForms.whileServed(['agent-imessage-dsh-channels'],()=>ctx.slots.inject('settings.section',()=>ctx.slots.register({
      name:'settings.section',id:'agent-imessage-channels',order:55,
      // A thunk is re-read on every projection, so the navigation label follows the active locale.
      label:()=>(ctx.locale?.bind(NS)??fallbackTranslate)('nav.title'),
      inject:()=>({ctx,channelForm:form}),
    },ChannelPanel)))
  } catch(error) {releasePage?.();releaseLocale();await unmount?.();throw error}
  let disposal:Promise<void>|undefined
  return ()=>disposal??=(async()=>{try{releasePage?.()}finally{releaseLocale();await unmount?.()}})()
}

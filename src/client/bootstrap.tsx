import {ChannelPanel} from './Panel.js'
import type {ClientContext} from './contracts.js'

/** Mount generated Host metadata before exposing a page that calls its namespace. */
export async function installPanel(ctx:ClientContext,contribution:unknown):Promise<()=>Promise<void>> {
  const unmount=await ctx.remote.$mount(contribution)
  let releasePage:(()=>void)|undefined
  try {
    const form=ctx.configForms.get('agent-imessage-dsh-channels')
    releasePage=ctx.configForms.whileServed(['agent-imessage-dsh-channels'],()=>ctx.slots.inject('settings.section',()=>ctx.slots.register({
      name:'settings.section',id:'agent-imessage-channels',order:55,label:()=> '消息渠道',inject:()=>({ctx,channelForm:form}),
    },ChannelPanel)))
  } catch(error) {await unmount?.();throw error}
  let disposal:Promise<void>|undefined
  return ()=>disposal??=(async()=>{try{releasePage?.()}finally{await unmount?.()}})()
}

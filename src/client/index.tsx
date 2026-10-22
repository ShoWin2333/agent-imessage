import type {Context} from '@deepseek-ai/cordis'
import {TYPERT_REMOTE} from '@showin2333/agent-imessage/remote'
import {installPanel} from './bootstrap.js'
import type {ClientContext} from './contracts.js'

export const inject=['slots','configForms','uiWorkspace','remote','remote.session']
export async function apply(context:Context):Promise<()=>Promise<void>> {
  return installPanel(context as unknown as ClientContext,TYPERT_REMOTE)
}

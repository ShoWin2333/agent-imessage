import { expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({create:vi.fn(),send:vi.fn(async()=>{}),provider:vi.fn(()=>({})),spectrum:vi.fn()}))
vi.mock('@spectrum-ts/core',()=>({Spectrum:mocks.spectrum,attachment:vi.fn(),voice:vi.fn()}))
vi.mock('@spectrum-ts/imessage',()=>({imessage:Object.assign(()=>({space:{create:mocks.create}}),{config:mocks.provider})}))
import { createSpectrumConnection } from '../src/spectrum-runtime.js'
it('creates proactive iMessage only for the configured authorized DM and assigned line',async()=>{
  mocks.spectrum.mockResolvedValue({messages:(async function*(){})(),stop:async()=>{}})
  mocks.create.mockResolvedValue({type:'dm',phone:'shared',send:mocks.send,responding:async(fn:()=>Promise<void>)=>fn()})
  const config={projectId:'p',projectSecret:'private',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
  const connection=await createSpectrumConnection(config)
  const message=await connection.scheduledMessage!('cron:daily:1','check')
  expect(mocks.create).toHaveBeenCalledWith(config.senderPhoneNumber,{phone:config.assignedPhoneNumber})
  expect(mocks.send).not.toHaveBeenCalled()
  await message.send('result');expect(mocks.send).toHaveBeenCalledExactlyOnceWith('result')
  mocks.create.mockResolvedValue({type:'group',phone:config.assignedPhoneNumber})
  await expect(connection.scheduledMessage!('bad','check')).rejects.toThrow('scope')
  mocks.create.mockResolvedValue({type:'dm',phone:'+15550000000'})
  await expect(connection.scheduledMessage!('bad','check')).rejects.toThrow('scope')
})

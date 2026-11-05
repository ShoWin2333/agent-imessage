// @vitest-environment jsdom
import {it,expect,vi} from 'vitest'
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react'
import {QQBotSetup} from '../src/client/QQBotSetup.js'
import {fallbackTranslate} from '../src/client/locale.js'
import {QQBotCredentials} from '../src/client/QQBotCredentials.js'
it('shows official QR state, saves only public identifiers into the draft, and releases a waiting scan',async()=>{
  const start=vi.fn(async()=>({ok:true,value:{id:'scan-1',phase:'waiting',url:'https://q.qq.com/qqbot/connect.html',qrSvg:'data:image/svg+xml;base64,PHN2Zy8+'}}))
  const status=vi.fn(async()=>({ok:true,value:{id:'scan-1',phase:'complete',appId:'12345678',ownerUserId:'owner_openid',credentialRef:'QQBOT_TEST'}})),cancel=vi.fn(async()=>({ok:true})),onBound=vi.fn()
  // Native remote namespaces are accessors and need not preserve object identity.
  const ctx={remote:{get qqBotSetup(){return {start,status,cancel}}}} as any
  render(<QQBotSetup ctx={ctx} t={fallbackTranslate} disabled={false} onBound={onBound}/>)
  fireEvent.click(screen.getByText('扫码连接 QQ Bot'))
  await screen.findByAltText('使用手机 QQ 扫码')
  expect(screen.getByText('打开官方绑定页').getAttribute('href')).toBe('https://q.qq.com/qqbot/connect.html')
  await waitFor(()=>expect(onBound).toHaveBeenCalledWith({appId:'12345678',ownerUserId:'owner_openid',credentialRef:'QQBOT_TEST'}),{timeout:2000})
  expect(document.body.textContent).not.toContain('appSecret')
  fireEvent.click(screen.getByText('扫码连接 QQ Bot'));await waitFor(()=>expect(start).toHaveBeenCalledTimes(2))
  cleanup();expect(cancel).toHaveBeenCalledWith('scan-1')
})
it('shows the loaded version, checks metadata and saves a new credential reference without echoing the secret',async()=>{
  const saveCredential=vi.fn(async()=>({ok:true})),credentialStatus=vi.fn(async()=>({ok:true,value:{configured:true,writable:true,source:'file'}})),onSaved=vi.fn()
  const ctx={remote:{qqBotSetup:{runtime:async()=>({ok:true,value:{version:'test-build',startedAt:'test-time'}}),credentialStatus,saveCredential}}} as any
  render(<QQBotCredentials ctx={ctx} t={fallbackTranslate} reference="QQBOT_EXISTING" disabled={false} onSaved={onSaved}/>)
  await screen.findByText('当前接入版本： test-build · test-time')
  fireEvent.click(screen.getByText('检查凭据状态'));await screen.findByText('凭据已配置 · file')
  fireEvent.click(screen.getByText('手动配置 AppSecret'));fireEvent.change(screen.getByLabelText('AppSecret'),{target:{value:'synthetic-secret'}})
  fireEvent.click(screen.getByText('保存新凭据'));await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce())
  expect(saveCredential).toHaveBeenCalledWith(expect.stringMatching(/^QQBOT_/),'synthetic-secret')
  expect(document.body.textContent).not.toContain('synthetic-secret');expect(screen.queryByLabelText('AppSecret')).toBeNull();cleanup()
})

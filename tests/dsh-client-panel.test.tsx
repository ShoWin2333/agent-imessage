// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor,within,act} from '@testing-library/react'
import {ChannelPanel,phaseLabel} from '../src/client/Panel.js'
import type {Binding,ClientContext,ConfigForm,FormSnapshot} from '../src/client/contracts.js'
import {installPanel} from '../src/client/bootstrap.js'

afterEach(cleanup)
const binding=():Binding=>({id:'telegram-one',enabled:false,cwd:'/tmp/project',credentialRef:'TELEGRAM_TOKEN',permissionPreset:'existing',channel:{id:'telegram-one',kind:'telegram',botId:'123',ownerUserId:'456'}})
function fixture(initial:Binding[]=[binding()]){
  let snapshot:FormSnapshot={status:'ready',revision:7,writable:true,value:{bindings:structuredClone(initial)}}
  const listeners=new Set<()=>void>()
  const replace=(bindings:Binding[],revision:number)=>{snapshot={...snapshot,revision,value:{bindings:structuredClone(bindings)}};for(const fn of listeners)fn()}
  const mutate=vi.fn<ConfigForm['mutate']>(async(ops,revision)=>{if(revision!==snapshot.revision)return false;replace(ops[0]!.value,snapshot.revision!+1);return true})
  const form:ConfigForm={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},mutate}
  const picker=vi.fn(async():Promise<string|null>=>null)
  const models=vi.fn(async()=>({ok:true as const,value:{default:{provider:'host',model:'default'},groups:[{id:'host',name:'宿主',models:[{id:'default',name:'默认模型'},{id:'configured',name:'已配置模型',reasoning:{efforts:[{id:'high',name:'高'}]}}]}],failures:[]}}))
  const status=vi.fn(async()=>({ok:true as const,value:{bindings:initial.map(b=>({id:b.id,phase:'stopped'}))}}))
  const ctx={remote:{session:{modelCatalog:models},channels:{status}},uiWorkspace:{pickDirectory:picker}} as unknown as ClientContext
  const show=()=>render(<ChannelPanel ctx={ctx} channelForm={form}/>)
  return {form,ctx,mutate,picker,models,status,replace,show,snapshot:()=>snapshot}
}
describe('native channel settings panel',()=>{
  it('creates a disabled binding; never starts on mount or editing',async()=>{
    const f=fixture([]);f.show();fireEvent.click(screen.getByRole('button',{name:'＋ Telegram'}))
    expect(screen.getByText('已停用 · 未连接')).toBeTruthy()
    expect((screen.getByRole('button',{name:'启动'}) as HTMLButtonElement).disabled).toBe(true)
    expect(f.mutate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('渠道标识').getAttribute('value')).toMatch(/^telegram-/)
    expect(screen.queryByRole('textbox',{name:/密钥/})).toBeNull()
    await waitFor(()=>expect(f.models).toHaveBeenCalledTimes(1))
  })
  it('saves the complete binding array with its read revision, then enables only explicitly',async()=>{
    const f=fixture();f.show();fireEvent.change(screen.getByLabelText('项目目录'),{target:{value:'/tmp/changed'}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}))
    await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(1))
    expect(f.mutate.mock.calls[0]![1]).toBe(7)
    expect(f.mutate.mock.calls[0]![0][0]!.value[0]).toMatchObject({cwd:'/tmp/changed',enabled:false})
    await screen.findByText('配置已保存；实际连接状态以下方宿主状态为准。')
    fireEvent.click(screen.getByRole('button',{name:'启动'}))
    await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(2))
    expect(f.mutate.mock.calls[1]![1]).toBe(8)
    expect(f.mutate.mock.calls[1]![0][0]!.value[0]!.enabled).toBe(true)
  })
  it('preserves failed/conflicting drafts and cancel reloads current host values',async()=>{
    const f=fixture();f.mutate.mockImplementation(async()=>{f.replace([{...binding(),cwd:'/tmp/host-latest'}],8);return false});f.show()
    fireEvent.change(screen.getByLabelText('项目目录'),{target:{value:'/tmp/draft'}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}))
    await screen.findByRole('alert')
    expect((screen.getByLabelText('项目目录') as HTMLInputElement).value).toBe('/tmp/draft')
    expect(f.mutate.mock.calls[0]![1]).toBe(7)
    fireEvent.click(screen.getByRole('button',{name:'取消编辑'}))
    expect((screen.getByLabelText('项目目录') as HTMLInputElement).value).toBe('/tmp/host-latest')
    expect((screen.getByRole('button',{name:'保存配置'}) as HTMLButtonElement).disabled).toBe(true)
  })
  it('preserves draft when transport throws and does not retry writes',async()=>{
    const f=fixture();f.mutate.mockRejectedValue(new Error('transport'));f.show()
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'NEW_REFERENCE'}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await screen.findByRole('alert')
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('NEW_REFERENCE')
    expect(f.mutate).toHaveBeenCalledTimes(1)
  })
  it('uses native directory picker; cancel and failure leave the path unchanged',async()=>{
    const f=fixture();f.show();fireEvent.click(screen.getByRole('button',{name:'选择目录…'}))
    await waitFor(()=>expect(f.picker).toHaveBeenCalledTimes(1))
    expect((screen.getByLabelText('项目目录') as HTMLInputElement).value).toBe('/tmp/project')
    f.picker.mockRejectedValueOnce(new Error('cancelled'));fireEvent.click(screen.getByRole('button',{name:'选择目录…'}));await screen.findByRole('alert')
    expect((screen.getByLabelText('项目目录') as HTMLInputElement).value).toBe('/tmp/project')
    f.picker.mockResolvedValueOnce('/tmp/picked');fireEvent.click(screen.getByRole('button',{name:'选择目录…'}))
    await waitFor(()=>expect((screen.getByLabelText('项目目录') as HTMLInputElement).value).toBe('/tmp/picked'))
    expect(f.mutate).not.toHaveBeenCalled()
  })
  it('selects configured host model/effort locally, saves choice, never creates a session',async()=>{
    const f=fixture();f.show();await screen.findByRole('option',{name:'已配置模型'})
    fireEvent.change(screen.getByLabelText('宿主模型'),{target:{value:JSON.stringify(['host','configured'])}})
    fireEvent.change(screen.getByLabelText('推理强度'),{target:{value:'high'}})
    expect(f.models).toHaveBeenCalledTimes(1);expect(f.models).toHaveBeenCalledWith();expect(f.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(1))
    expect(f.mutate.mock.calls[0]![0][0]!.value[0]!.model).toEqual({provider:'host',model:'configured',reasoningEffort:'high'})
    expect(Object.keys(f.ctx.remote.session)).toEqual(['modelCatalog'])
  })
  it('summary is inert and unknown phases never claim a connection',()=>{
    const f=fixture();render(<ChannelPanel ctx={f.ctx} channelForm={f.form} view="summary"/>)
    expect(f.models).not.toHaveBeenCalled();expect(f.status).not.toHaveBeenCalled()
    expect(phaseLabel('listening',true)).toBe('已连接');expect(phaseLabel('stopped',false)).toBe('已停用 · 未连接')
    expect(phaseLabel('unexpected',true)).toContain('未确认连接')
  })
  it('allows a running channel draft and requires explicit reconnect confirmation before save',async()=>{
    const original={...binding(),id:'alice-telegram',enabled:true,channel:{...binding().channel,id:'alice-telegram'}}
    const f=fixture([original]);f.show();await screen.findByRole('option',{name:'已配置模型'})
    expect((screen.getByLabelText('宿主模型') as HTMLSelectElement).disabled).toBe(false)
    expect((screen.getByLabelText('渠道标识') as HTMLInputElement).readOnly).toBe(true)
    fireEvent.change(screen.getByLabelText('宿主模型'),{target:{value:JSON.stringify(['host','configured'])}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));expect(f.mutate).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog',{name:'应用渠道更改'}).textContent).toContain('原会话历史保留')
    fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));expect(f.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));fireEvent.click(screen.getByRole('button',{name:'确认应用并重新连接此渠道'}))
    await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(1))
    expect(f.snapshot().value!.bindings![0]).toMatchObject({id:'alice-telegram',enabled:true,model:{provider:'host',model:'configured'}})
  })
  it('keeps Agent/channel drafts separate and preserves only the saved channel across reopen',async()=>{
    const a={...binding(),id:'alice-telegram',cwd:'/tmp/alice',channel:{...binding().channel,id:'alice-telegram'}}
    const d={...binding(),id:'alice-discord',cwd:'/tmp/alice',channel:{id:'alice-discord',kind:'discord' as const,botId:'1234',ownerUserId:'5678'}}
    const j={...binding(),id:'jane-telegram',cwd:'/tmp/jane',channel:{...binding().channel,id:'jane-telegram',botId:'999'}}
    const f=fixture([a,d,j]);f.show();await screen.findByRole('option',{name:'已配置模型'})
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'ALICE_UNSAVED'}})
    fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 所属渠道'})).getByRole('button',{name:'Discord'}))
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'DISCORD_SAVED'}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(1))
    const payload=f.mutate.mock.calls[0]![0][0]!.value
    expect(payload.find(b=>b.id===a.id)).toEqual(a);expect(payload.find(b=>b.id===j.id)).toEqual(j)
    expect(payload.find(b=>b.id===d.id)!.credentialRef).toBe('DISCORD_SAVED')
    fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 分组'})).getByRole('button',{name:/Jane/}))
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe(j.credentialRef)
    fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 分组'})).getByRole('button',{name:/Alice/}))
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('ALICE_UNSAVED')
    fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe(a.credentialRef)
    cleanup();f.show();fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 所属渠道'})).getByRole('button',{name:'Discord'}))
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('DISCORD_SAVED')
  })
  it('checks the selected binding again after confirmation and never overwrites concurrent changes',async()=>{
    const original={...binding(),id:'alice-telegram',enabled:true,channel:{...binding().channel,id:'alice-telegram'}},f=fixture([original]);f.show()
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'DRAFT_REF'}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}))
    act(()=>f.replace([{...original,credentialRef:'EXTERNAL_REF'}],8))
    fireEvent.click(screen.getByRole('button',{name:'确认应用并重新连接此渠道'}));await screen.findByText(/此渠道已被其他设置修改/)
    expect(f.mutate).not.toHaveBeenCalled();expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('DRAFT_REF')
    fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('EXTERNAL_REF')
  })
  it('directory picking invalidates a stale reconnect confirmation and retains the updated draft',async()=>{
    const original={...binding(),enabled:true},f=fixture([original]);let resolve!:(path:string)=>void
    f.picker.mockImplementation(()=>new Promise(r=>{resolve=r}));f.show()
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'DRAFT_REF'}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'选择目录…'}));expect(screen.queryByRole('dialog')).toBeNull()
    await act(async()=>resolve('/tmp/after-confirmation'))
    expect((screen.getByLabelText('项目目录') as HTMLInputElement).value).toBe('/tmp/after-confirmation')
    expect(f.mutate).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('accepts semantically identical host normalization without retaining a false dirty draft',async()=>{
    const f=fixture();f.mutate.mockImplementation(async(ops,revision)=>{
      const normalized=ops[0]!.value.map(b=>Object.fromEntries(Object.entries(b).reverse()) as unknown as Binding)
      f.replace(normalized,revision!+1);return true
    });f.show();fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'SAVED_REF'}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await screen.findByText('配置已保存；实际连接状态以下方宿主状态为准。')
    expect((screen.getByRole('button',{name:'保存配置'}) as HTMLButtonElement).disabled).toBe(true)
  })
  it('removes only the selected channel model override when inheriting the host default',async()=>{
    const first={...binding(),id:'alice-telegram',model:{provider:'host',model:'configured',reasoningEffort:'high'},channel:{...binding().channel,id:'alice-telegram'}},other={...binding(),id:'jane-telegram',cwd:'/tmp/jane',channel:{...binding().channel,id:'jane-telegram',botId:'999'}},f=fixture([first,other]);f.show()
    await screen.findByRole('option',{name:'已配置模型'});fireEvent.change(screen.getByLabelText('宿主模型'),{target:{value:''}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(1))
    expect(f.snapshot().value!.bindings![0]!.model).toBeUndefined();expect(f.snapshot().value!.bindings![1]).toEqual(other)
  })
  it('merges an unrelated host update while saving only the selected channel',async()=>{
    const first={...binding(),id:'alice-telegram',channel:{...binding().channel,id:'alice-telegram'}},other={...binding(),id:'jane-telegram',cwd:'/tmp/jane',channel:{...binding().channel,id:'jane-telegram',botId:'999'}},f=fixture([first,other]);f.show()
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'SELECTED_DRAFT'}})
    act(()=>f.replace([first,{...other,credentialRef:'UNRELATED_NEW_REF'}],8))
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(1))
    expect(f.mutate.mock.calls[0]![1]).toBe(8);expect(f.snapshot().value!.bindings![1]!.credentialRef).toBe('UNRELATED_NEW_REF')
  })
  it('registers one independent Settings sidebar section, with no built-in plugin entry',async()=>{
    const f=fixture(),registrations:Array<Record<string,unknown>>=[],slots:string[]=[]
    const ctx={...f.ctx,remote:{...f.ctx.remote,$mount:async()=>async()=>{}},configForms:{get:()=>f.form,whileServed:(_ids:string[],register:()=>()=>void)=>register()},slots:{inject:(name:string,register:()=>()=>void)=>{slots.push(name);return register()},register:(options:Record<string,unknown>)=>{registrations.push(options);return()=>{}}}} as unknown as ClientContext
    const dispose=await installPanel(ctx,{})
    expect(slots).toEqual(['settings.section']);expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({name:'settings.section',id:'agent-imessage-channels'})
    expect((registrations[0]!.label as ()=>string)()).toBe('消息渠道')
    await dispose()
  })
  it('awaits generated remote mount before registering the page and releases in order once',async()=>{
    const f=fixture(),order:string[]=[],metadata={generated:true}
    let mounted!:(dispose:()=>Promise<void>)=>void
    const release=vi.fn(()=>{order.push('page')})
    const mount=vi.fn(()=>new Promise<()=>Promise<void>>(resolve=>{mounted=resolve}))
    const get=vi.fn(()=>f.form),served=vi.fn(()=>release)
    const ctx={...f.ctx,remote:{...f.ctx.remote,$mount:mount},configForms:{get,whileServed:served}} as unknown as ClientContext
    const pending=installPanel(ctx,metadata)
    expect(mount).toHaveBeenCalledWith(metadata);expect(get).not.toHaveBeenCalled()
    const unmount=vi.fn(async()=>{order.push('remote')});mounted(unmount)
    const dispose=await pending;expect(get).toHaveBeenCalledWith('agent-imessage-dsh-channels')
    await Promise.all([dispose(),dispose()]);expect(order).toEqual(['page','remote']);expect(unmount).toHaveBeenCalledTimes(1)
  })
  it('releases mounted remote metadata if page registration fails',async()=>{
    const f=fixture(),unmount=vi.fn(async()=>{})
    const ctx={...f.ctx,remote:{...f.ctx.remote,$mount:vi.fn(async()=>unmount)},configForms:{get:()=>{throw new Error('page failed')}}} as unknown as ClientContext
    await expect(installPanel(ctx,{})).rejects.toThrow('page failed');expect(unmount).toHaveBeenCalledTimes(1)
  })
})

// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor,within,act} from '@testing-library/react'
import {ChannelPanel,phaseLabel,validateBindings} from '../src/client/Panel.js'
import type {AgentGroup,Binding,ClientContext,ConfigForm,FormSnapshot} from '../src/client/contracts.js'
import {installPanel} from '../src/client/bootstrap.js'

afterEach(cleanup)
const binding=():Binding=>({id:'telegram-one',enabled:false,cwd:'/tmp/project',credentialRef:'TELEGRAM_TOKEN',permissionPreset:'existing',channel:{id:'telegram-one',kind:'telegram',botId:'123',ownerUserId:'456'}})
const emptyAgent:AgentGroup={id:'agent-empty',name:'Empty',cwd:'/tmp/project',bindingIds:[]}
function fixture(initial:Binding[]=[binding()],agents?:AgentGroup[]){
  let snapshot:FormSnapshot={status:'ready',revision:7,writable:true,value:{bindings:structuredClone(initial),...(agents?{agents:structuredClone(agents)}:{})}}
  const listeners=new Set<()=>void>()
  const replace=(bindings:Binding[],revision:number,agents=snapshot.value?.agents)=>{snapshot={...snapshot,revision,value:{bindings:structuredClone(bindings),...(agents?{agents:structuredClone(agents)}:{})}};for(const fn of listeners)fn()}
  const mutate=vi.fn<ConfigForm['mutate']>(async(ops,revision)=>{if(revision!==snapshot.revision)return false;const next={...snapshot.value};for(const op of ops)Object.assign(next,{[op.path[0]]:structuredClone(op.value)});replace(next.bindings??[],snapshot.revision!+1,next.agents);return true})
  const form:ConfigForm={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},mutate}
  const picker=vi.fn(async():Promise<string|null>=>null)
  const models=vi.fn(async()=>({ok:true as const,value:{default:{provider:'host',model:'default'},groups:[{id:'host',name:'宿主',models:[{id:'default',name:'默认模型'},{id:'configured',name:'已配置模型',reasoning:{efforts:[{id:'high',name:'高'}]}}]}],failures:[]}}))
  const status=vi.fn(async()=>({ok:true as const,value:{bindings:initial.map(b=>({id:b.id,phase:'stopped'}))}}))
  const ctx={remote:{session:{modelCatalog:models},channels:{status,async *statusStream(signal:AbortSignal){yield (await status()).value;if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))}}},uiWorkspace:{pickDirectory:picker},inject(this:ClientContext,_dependencies:string[],mount:(ctx:ClientContext)=>()=>void){const release=mount(this);return Object.assign(Promise.resolve(),{dispose:async()=>{release()}})}} as unknown as ClientContext
  const show=()=>render(<ChannelPanel ctx={ctx} channelForm={form}/>)
  return {form,ctx,mutate,picker,models,status,replace,show,snapshot:()=>snapshot}
}
describe('native channel settings panel',()=>{
  it('creates a disabled binding; never starts on mount or editing',async()=>{
    const f=fixture([],[emptyAgent]);f.show();fireEvent.click(screen.getByRole('button',{name:'＋ Telegram'}))
    expect(screen.getByText('已停用 · 未连接')).toBeTruthy()
    expect((screen.getByRole('button',{name:'启动'}) as HTMLButtonElement).disabled).toBe(true)
    expect(f.mutate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('渠道标识').getAttribute('value')).toMatch(/^telegram-/)
    expect(screen.queryByRole('textbox',{name:/密钥/})).toBeNull()
    await waitFor(()=>expect(f.models).toHaveBeenCalledTimes(1))
  })
  it('edits and saves an inert Weixin binding with identity fields and a credential reference',async()=>{
    const f=fixture([],[emptyAgent]);f.show();fireEvent.click(screen.getByRole('button',{name:'＋ 微信'}))
    const fields=[['项目目录','/tmp/project'],['宿主权限预设','workspace-write'],['凭据引用（宿主已配置）','WEIXIN_TOKEN'],
      ['账号 ID','bot@synthetic'],['微信允许的用户 ID','owner'],['微信 API 地址','https://ilinkai.weixin.qq.com']]
    for(const [name,value] of fields)fireEvent.change(screen.getByLabelText(name!),{target:{value}})
    expect(f.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await waitFor(()=>expect(f.mutate).toHaveBeenCalledOnce())
    expect(f.snapshot().value?.bindings[0]).toMatchObject({enabled:false,credentialRef:'WEIXIN_TOKEN',channel:{kind:'weixin',accountId:'bot@synthetic'},weixin:{ownerUserId:'owner',baseUrl:'https://ilinkai.weixin.qq.com'}})
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
    const d={...binding(),id:'alice-imessage',cwd:'/tmp/alice',channel:{id:'alice-imessage',kind:'imessage' as const,projectId:'synthetic',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}}
    const j={...binding(),id:'jane-telegram',cwd:'/tmp/jane',channel:{...binding().channel,id:'jane-telegram',botId:'999'}}
    const f=fixture([a,d,j]);f.show();await screen.findByRole('option',{name:'已配置模型'})
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'ALICE_UNSAVED'}})
    fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 所属渠道'})).getByRole('button',{name:'iMessage'}))
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'IMESSAGE_SAVED'}})
    fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(1))
    const payload=f.mutate.mock.calls[0]![0][0]!.value
    expect(payload.find(b=>b.id===a.id)).toEqual(a);expect(payload.find(b=>b.id===j.id)).toEqual(j)
    expect(payload.find(b=>b.id===d.id)!.credentialRef).toBe('IMESSAGE_SAVED')
    fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 分组'})).getByRole('button',{name:/Jane/}))
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe(j.credentialRef)
    fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 分组'})).getByRole('button',{name:/Alice/}))
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('ALICE_UNSAVED')
    fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe(a.credentialRef)
    cleanup();f.show();fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 所属渠道'})).getByRole('button',{name:'iMessage'}))
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('IMESSAGE_SAVED')
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
      f.replace(normalized,revision!+1,ops.find(op=>op.path[0]==='agents')?.value as AgentGroup[]);return true
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
  it('creates and reopens an empty Agent without creating a session or a connection',async()=>{
    const f=fixture([]);f.show()
    expect((screen.getByRole('button',{name:'＋ Telegram'}) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button',{name:'＋ 新增 Agent'}))
    fireEvent.change(screen.getByLabelText('Agent 名称'),{target:{value:'Research'}})
    fireEvent.change(screen.getByLabelText('默认项目目录'),{target:{value:'/tmp/research'}})
    fireEvent.click(screen.getByRole('button',{name:'创建 Agent'}))
    await screen.findByText('Agent 已保存，可以添加渠道。')
    expect(f.snapshot().value).toEqual({bindings:[],agents:[{id:expect.stringMatching(/^agent-/),name:'Research',cwd:'/tmp/research',bindingIds:[]}]})
    expect(f.mutate.mock.calls[0]![1]).toBe(7)
    cleanup();f.show();expect(screen.getByRole('button',{name:'Research 0 个渠道'})).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'＋ Telegram'}))
    expect((screen.getByLabelText('项目目录') as HTMLInputElement).value).toBe('/tmp/research')
    expect((screen.getByRole('button',{name:'启动'}) as HTMLButtonElement).disabled).toBe(true)
  })
  it('validates new Agent name and path and keeps the form on rejection',async()=>{
    const f=fixture([]);f.show();fireEvent.click(screen.getByRole('button',{name:'＋ 新增 Agent'}))
    fireEvent.click(screen.getByRole('button',{name:'创建 Agent'}));await screen.findByText('请填写 1–80 个字符的 Agent 名称。')
    expect(f.mutate).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Agent 名称'),{target:{value:'Research'}})
    fireEvent.change(screen.getByLabelText('默认项目目录'),{target:{value:'relative'}})
    fireEvent.click(screen.getByRole('button',{name:'创建 Agent'}));await screen.findByText('请选择 Agent 的绝对默认项目路径。')
    f.mutate.mockResolvedValue(false)
    fireEvent.change(screen.getByLabelText('默认项目目录'),{target:{value:'/tmp/research'}})
    fireEvent.click(screen.getByRole('button',{name:'创建 Agent'}));await screen.findByRole('alert')
    expect((screen.getByLabelText('Agent 名称') as HTMLInputElement).value).toBe('Research')
    expect(f.snapshot().value?.agents).toBeUndefined()
  })
  it('removes the last channel while retaining its empty Agent across reopen',async()=>{
    const original=binding(),f=fixture([original]);f.show()
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'UNSAVED_REF'}})
    fireEvent.click(screen.getByRole('button',{name:'移除渠道'}))
    const dialog=screen.getByRole('dialog',{name:'移除配置'})
    expect(dialog.textContent).toContain(original.id);expect(dialog.textContent).toContain('会话历史、宿主凭据和项目文件保留')
    expect(f.mutate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button',{name:'确认移除配置'}))
    await screen.findByText('尚未配置渠道')
    expect(f.snapshot().value?.bindings).toEqual([]);expect(f.snapshot().value?.agents).toHaveLength(1)
    expect(f.snapshot().value?.agents?.[0]?.bindingIds).toEqual([])
    cleanup();f.show();expect(screen.getByRole('button',{name:'project 0 个渠道'})).toBeTruthy()
  })
  it('lists and removes exactly one Agent’s saved channels, retaining other configuration and drafts',async()=>{
    const a={...binding(),id:'alice-telegram',enabled:true,channel:{...binding().channel,id:'alice-telegram'}}
    const d={...binding(),id:'alice-imessage',channel:{id:'alice-imessage',kind:'imessage' as const,projectId:'synthetic',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}}
    const j={...binding(),id:'jane-telegram',cwd:'/tmp/jane',channel:{...binding().channel,id:'jane-telegram',botId:'999'}}
    const f=fixture([a,d,j]);f.show()
    fireEvent.click(screen.getByRole('button',{name:/Jane 1/}))
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'JANE_DRAFT'}})
    fireEvent.click(screen.getByRole('button',{name:/Alice 2/}))
    fireEvent.click(screen.getByRole('button',{name:'＋ 微信'}))
    fireEvent.click(screen.getByRole('button',{name:'移除 Agent'}))
    const dialog=screen.getByRole('dialog');expect(dialog.textContent).toContain('alice-telegram · Telegram · 将停止并移除配置')
    expect(dialog.textContent).toContain('alice-imessage · iMessage · 已停用，将移除配置')
    expect(dialog.textContent).not.toContain(j.id);expect(dialog.textContent).toContain('未保存渠道草稿')
    fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));expect(f.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'移除 Agent'}));fireEvent.click(screen.getByRole('button',{name:'确认移除配置'}))
    await screen.findByText('配置已移除；宿主将停止相应渠道。会话历史、凭据与项目文件保留。')
    expect(f.snapshot().value?.bindings).toEqual([j]);expect(f.snapshot().value?.agents).toHaveLength(1)
    expect(screen.queryByRole('button',{name:/Alice 2/})).toBeNull()
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('JANE_DRAFT')
  })
  it('revalidates confirmed removal after a concurrent member change, without writing',async()=>{
    const f=fixture([{...binding(),enabled:true}]);f.show();fireEvent.click(screen.getByRole('button',{name:'移除 Agent'}))
    act(()=>f.replace([{...binding(),enabled:true,credentialRef:'CHANGED'}],8))
    fireEvent.click(screen.getByRole('button',{name:'确认移除配置'}));await screen.findByText('Agent 或渠道配置已变化。请核对当前配置后重新操作。')
    expect(f.mutate).not.toHaveBeenCalled();expect(f.snapshot().value?.bindings?.[0]?.credentialRef).toBe('CHANGED')
  })
  it('rejects removal if a new member was added since confirmation',async()=>{
    const f=fixture();f.show();fireEvent.click(screen.getByRole('button',{name:'移除 Agent'}))
    const existing={id:'explicit',name:'Agent',cwd:'/tmp/project',bindingIds:[binding().id]}
    act(()=>f.replace([binding(),{...binding(),id:'new-channel',channel:{...binding().channel,id:'new-channel',botId:'999'}}],8,[{...existing,bindingIds:[binding().id,'new-channel']}]))
    fireEvent.click(screen.getByRole('button',{name:'确认移除配置'}));await screen.findByRole('alert')
    expect(f.mutate).not.toHaveBeenCalled()
  })
  it.each(['移除渠道','移除 Agent'])('rejects %s when another Agent saved a formerly local draft id after confirmation',async action=>{
    const other={...emptyAgent,id:'agent-other',name:'Other',cwd:'/tmp/other'}
    const f=fixture([],[emptyAgent,other]);f.show()
    fireEvent.click(screen.getByRole('button',{name:'＋ 微信'}))
    const draftId=(screen.getByLabelText('渠道标识') as HTMLInputElement).value
    fireEvent.click(screen.getByRole('button',{name:action}))
    expect(screen.getByRole('dialog').textContent).toContain('没有连接需要停止')
    const external={...binding(),id:draftId,cwd:'/tmp/other',enabled:true,channel:{...binding().channel,id:draftId}}
    // The confirmed Agent and its saved rows remain unchanged; only the other Agent gains this id.
    act(()=>f.replace([external],8,[emptyAgent,{...other,bindingIds:[draftId]}]))
    fireEvent.click(screen.getByRole('button',{name:'确认移除配置'}))
    await screen.findByText('Agent 或渠道配置已变化。请核对当前配置后重新操作。')
    expect(f.mutate).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.snapshot().value).toEqual({bindings:[external],agents:[emptyAgent,{...other,bindingIds:[draftId]}]})
  })
  it('shows the selected channel’s Host project independently of the Agent default or an unsaved directory draft',async()=>{
    const a={...binding(),id:'channel-a',enabled:true,cwd:'/tmp/channel-a',channel:{...binding().channel,id:'channel-a'}}
    const b={...binding(),id:'channel-b',enabled:true,cwd:'/tmp/channel-b',channel:{id:'channel-b',kind:'imessage' as const,projectId:'synthetic',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}}
    const f=fixture([a,b],[{...emptyAgent,cwd:'/tmp/default',bindingIds:[a.id,b.id]}])
    f.ctx.remote.channelProjects={status:async()=>({ok:true,value:{projects:[
      {id:'project-a',title:'Channel A',cwd:'/canonical/channel-a',bindingIds:[a.id]},
      {id:'project-b',title:'Channel B',cwd:'/canonical/channel-b',bindingIds:[b.id]},
    ],pending:[],errors:[]}})}
    f.show()
    await screen.findByText('DSH 项目：Channel A · project-a · /canonical/channel-a')
    expect(screen.getByText('默认项目目录：/tmp/default')).toBeTruthy()
    expect(screen.getByText('仅供新增渠道预填；已有渠道保留各自目录。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('项目目录'),{target:{value:'/tmp/unsaved'}})
    expect(screen.getByText('DSH 项目：Channel A · project-a · /canonical/channel-a')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('navigation',{name:'Agent 所属渠道'})).getByRole('button',{name:'iMessage'}))
    expect(screen.getByText('DSH 项目：Channel B · project-b · /canonical/channel-b')).toBeTruthy()
    expect(screen.queryByText('DSH 项目：Channel A · project-a · /canonical/channel-a')).toBeNull()
    expect(f.mutate).not.toHaveBeenCalled()
  })
  it('merges unrelated updates during removal and preserves unrelated draft values',async()=>{
    const first={...binding(),id:'alice-telegram',channel:{...binding().channel,id:'alice-telegram'}},other={...binding(),id:'jane-telegram',cwd:'/tmp/jane',channel:{...binding().channel,id:'jane-telegram',botId:'999'}}
    const f=fixture([first,other]);f.show();fireEvent.click(screen.getByRole('button',{name:'移除 Agent'}))
    act(()=>f.replace([first,{...other,credentialRef:'NEW_REF'}],8))
    fireEvent.click(screen.getByRole('button',{name:'确认移除配置'}));await waitFor(()=>expect(f.mutate).toHaveBeenCalledOnce())
    expect(f.mutate.mock.calls[0]![1]).toBe(8);expect(f.snapshot().value?.bindings).toEqual([{...other,credentialRef:'NEW_REF'}])
  })
  it('retains configuration and draft on a rejected or uncertain removal, and does not retry',async()=>{
    const f=fixture();f.mutate.mockRejectedValue(new Error('unknown'));f.show()
    fireEvent.change(screen.getByLabelText('凭据引用（宿主已配置）'),{target:{value:'DRAFT_REF'}})
    fireEvent.click(screen.getByRole('button',{name:'移除渠道'}));fireEvent.click(screen.getByRole('button',{name:'确认移除配置'}))
    await screen.findByRole('alert');expect(f.mutate).toHaveBeenCalledOnce();expect(f.snapshot().value?.bindings).toEqual([binding()])
    fireEvent.click(screen.getByRole('button',{name:'取消'}))
    expect((screen.getByLabelText('凭据引用（宿主已配置）') as HTMLInputElement).value).toBe('DRAFT_REF')
  })
  it('removes an empty Agent and a draft-only channel without inventing a running connection',async()=>{
    const f=fixture([],[emptyAgent]);f.show();fireEvent.click(screen.getByRole('button',{name:'＋ 微信'}))
    fireEvent.click(screen.getByRole('button',{name:'移除渠道'}));expect(screen.getByRole('dialog').textContent).toContain('没有连接需要停止')
    fireEvent.click(screen.getByRole('button',{name:'确认移除配置'}));await screen.findByText('尚未配置渠道')
    fireEvent.click(screen.getByRole('button',{name:'移除 Agent'}));fireEvent.click(screen.getByRole('button',{name:'确认移除配置'}))
    await screen.findByText('先新增 Agent，再为它添加渠道。');expect(f.snapshot().value).toEqual({bindings:[],agents:[]})
  })
  it.each(['discord','feishu'])('shows a read-only error for retired %s configuration without deleting or rewriting it',kind=>{
    const retired={...binding(),id:'retired',channel:{id:'retired',kind}} as Binding
    const f=fixture([binding(),retired]);f.show()
    expect(screen.getByRole('alert').textContent).toContain('仅支持 iMessage、Telegram 和微信')
    expect(screen.getByText('请先核对宿主配置。此页面不会自动删除绑定、Agent 分组、凭据或会话。')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull();expect(f.mutate).not.toHaveBeenCalled()
    expect(f.snapshot().value?.bindings).toEqual([binding(),retired])
  })
  it('renders malformed external membership safely and blocks writes until repaired',()=>{
    const f=fixture([binding()],[{...emptyAgent,bindingIds:['missing']}]);f.show()
    expect(screen.getByRole('alert').textContent).toContain('每个渠道只能属于一个 Agent')
    expect((screen.getByRole('button',{name:'移除 Agent'}) as HTMLButtonElement).disabled).toBe(true)
    expect(f.mutate).not.toHaveBeenCalled()
  })
  it('focuses the safe action, traps Tab and permits Escape to cancel removal',()=>{
    const f=fixture();f.show();fireEvent.click(screen.getByRole('button',{name:'移除 Agent'}))
    expect(document.activeElement).toBe(screen.getByRole('button',{name:'取消'}))
    fireEvent.keyDown(window,{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(screen.getByRole('button',{name:'确认移除配置'}))
    fireEvent.keyDown(window,{key:'Tab'});expect(document.activeElement).toBe(screen.getByRole('button',{name:'取消'}))
    fireEvent.keyDown(window,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();expect(f.mutate).not.toHaveBeenCalled()
  })
  it('registers one independent Settings sidebar section, with no built-in plugin entry',async()=>{
    const f=fixture(),registrations:Array<Record<string,unknown>>=[],slots:string[]=[]
    const ctx={...f.ctx,remote:{...f.ctx.remote,$mount:async()=>async()=>{}},configForms:{get:()=>f.form,whileServed:(_ids:string[],register:()=>()=>void)=>register()},slots:{inject:(name:string,register:()=>()=>void)=>{slots.push(name);return register()},register:(options:Record<string,unknown>)=>{registrations.push(options);return()=>{}}}} as unknown as ClientContext
    const dispose=await installPanel(ctx,{})
    expect(slots).toEqual(['settings.section']);expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({name:'settings.section',id:'dsh-channels'})
    expect((registrations[0]!.label as ()=>string)()).toBe('Messaging Channels')
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
    const dispose=await pending;expect(get).toHaveBeenCalledWith('dsh-channels')
    await Promise.all([dispose(),dispose()]);expect(order).toEqual(['page','remote']);expect(unmount).toHaveBeenCalledTimes(1)
  })
  it('releases mounted remote metadata if page registration fails',async()=>{
    const f=fixture(),unmount=vi.fn(async()=>{})
    const ctx={...f.ctx,remote:{...f.ctx.remote,$mount:vi.fn(async()=>unmount)},configForms:{get:()=>{throw new Error('page failed')}}} as unknown as ClientContext
    await expect(installPanel(ctx,{})).rejects.toThrow('page failed');expect(unmount).toHaveBeenCalledTimes(1)
  })
})
it.each(['C:\\workspace\\project','\\\\server\\share\\project'])('saves a Windows directory picker result %s through the actual panel',async cwd=>{
 const f=fixture();f.picker.mockResolvedValue(cwd);f.show();fireEvent.click(screen.getByRole('button',{name:'选择目录…'}));await waitFor(()=>expect((screen.getByLabelText('项目目录')as HTMLInputElement).value).toBe(cwd));fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await waitFor(()=>expect(f.mutate).toHaveBeenCalledTimes(1));expect(f.mutate.mock.calls[0]![0][0]!.value[0]!.cwd).toBe(cwd)
})
it.each(['C:relative','\\relative','\\\\server'])('rejects incomplete or relative Windows path %s in the panel',cwd=>{
 expect(validateBindings([{...binding(),cwd}])).toContain('绝对项目路径')
})


it('accepts QQ schema defaults from the real Host contract and preserves every existing binding',async()=>{
 const original=binding(),qq:Binding={id:'alice-qqbot',enabled:false,cwd:'/tmp/project',credentialRef:'QQ_SECRET',permissionPreset:'existing',channel:{id:'alice-qqbot',kind:'qqbot',appId:'12345678',ownerUserId:'owner_openid'}}
 const group={...emptyAgent,bindingIds:[original.id,qq.id]},f=fixture([original,qq],[group])
 f.mutate.mockImplementation(async(ops,revision)=>{
  const values=(ops.find(op=>op.path[0]==='bindings')!.value as Binding[]).map(b=>b.channel.kind==='qqbot'?{...b,channel:{streaming:true,showToolResults:false,sendPresentedFiles:true,maxFiles:4,externalTurns:'c2c',...b.channel}}:b)
  f.replace(values,revision!+1,ops.find(op=>op.path[0]==='agents')!.value as AgentGroup[]);return true
 })
 f.show();fireEvent.click(screen.getByRole('button',{name:'QQ Bot'}));fireEvent.change(screen.getByLabelText('项目目录'),{target:{value:'/tmp/qq-updated'}});fireEvent.click(screen.getByRole('button',{name:'保存配置'}))
 await screen.findByText('配置已保存；实际连接状态以下方宿主状态为准。')
 expect(screen.queryByRole('alert')).toBeNull();expect(f.snapshot().value!.bindings![0]).toEqual(original)
 expect(f.snapshot().value!.bindings).toHaveLength(2);expect((screen.getByRole('button',{name:'保存配置'}) as HTMLButtonElement).disabled).toBe(true)
})

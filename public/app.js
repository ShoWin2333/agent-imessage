let state, csrf, formRevision, busy = false
const $ = id => document.getElementById(id)
const fields = [
  ['label','项目名称'], ['backend','Agent',['cursor','codex','dsh']], ['id','路由 ID'],
  ['cwd','工作目录（绝对路径）'], ['approvalPolicy','审批权限',['default']], ['cursorSettings','项目规则',['project','project-user','none']], ['model','模型'], ['effort','推理强度',['default','none','off','minimal','low','medium','high','xhigh','max','ultra']],
  ['speed','速度',['default','fast','standard']], ['projectId','Photon 项目 ID'], ['projectSecretEnv','Photon 环境变量（可选）'],
  ['senderPhoneNumber','你的 iMessage 号码'], ['assignedPhoneNumber','Photon 分配的号码'], ['photonSecret','Photon Project Secret'],
]
let selectedProject, activeView = 'project'
function showView(view = 'project', id = selectedProject) {
  activeView = view; selectedProject = id
  for (const name of ['project','channels','preferences','help']) $(name+'-view').hidden = name !== view
  for (const section of $('routes').children) section.hidden = view !== 'project' || section.dataset.id !== id
  const selected = [...$('routes').children].find(s=>s.dataset.id === id)
  $('page-title').textContent = view === 'project' ? selected?.querySelector('[name=label]').value || id || '项目' : ({channels:'消息渠道',preferences:'设置',help:'使用说明'}[view])
  $('page-caption').textContent = view === 'project' ? '工作空间 / 项目' : 'AGENT GATEWAY'
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.view === view)))
  document.querySelectorAll('[data-project]').forEach(b=>b.setAttribute('aria-current',String(view === 'project' && b.dataset.project === id)))
}
function navigation() {
  const sections = [...$('routes').children]
  if (!sections.some(s=>s.dataset.id === selectedProject)) selectedProject = sections[0]?.dataset.id
  $('project-nav').replaceChildren(...sections.map(section=>{
    const b=document.createElement('button'); b.type='button'; b.dataset.project=section.dataset.id
    const icon=document.createElement('span'); icon.className='project-icon'; icon.textContent='▱'
    const label=document.createElement('span'); label.textContent=section.querySelector('[name=label]').value || section.dataset.id
    b.append(icon,label); b.onclick=()=>showView('project',section.dataset.id); return b
  }))
  $('empty-state').hidden=sections.length>0
  showView(activeView)
}
function revealInvalid(input) {
  const section=input.closest('.route'); if(section) showView('project',section.dataset.id)
  for(let p=input.parentElement;p;p=p.parentElement) if(p.tagName==='DETAILS') p.open=true
}
$('settings').addEventListener('invalid',event=>revealInvalid(event.target),true)
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>showView(b.dataset.view))
function notice(message) { $('notice').textContent = message }
function renderRoute(route) {
  const initialIMessage = route.channels?.find(c => c.kind === 'imessage')
  if (initialIMessage) route = {...route,...Object.fromEntries(Object.entries(initialIMessage).filter(([key]) => !['id','kind'].includes(key)))}
  const section = document.createElement('section'); section.className = 'route'; section.dataset.id = route.id
  const heading = document.createElement('div'); heading.className = 'route-head'
  const title = document.createElement('h2'); title.textContent = route.label || route.id
  const badge = document.createElement('span'); badge.className = 'badge'; badge.dataset.role = 'status'
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.onclick = () => { section.remove(); navigation(); notice('项目已从草稿移除。到设置中保存全部配置后生效。') }
  heading.append(title,badge,remove); section.append(heading)
  const grid = document.createElement('div'); grid.className = 'grid'
  section.addEventListener('input', event => { if (event.target.name === 'label') { title.textContent=event.target.value || section.dataset.id; navigation() } })
  let modelCatalog = []
  const updateParameters = (reset = false) => {
    const backend = grid.querySelector('[name=backend]').value
    const model = modelCatalog.find(m => m.id === grid.querySelector('[name=model]').value)
    for (const [field, choices] of [['effort',model?.efforts],['speed',backend === 'dsh' ? [] : model?.speeds]]) {
      const input = grid.querySelector('[name='+field+']'), current = reset ? 'default' : input.value || 'default'
      input.replaceChildren(new Option(choices === undefined ? '默认（刷新模型列表查看可选参数）' : choices.length ? '默认' : '默认（此模型不提供该选项）','default'))
      for (const choice of choices || []) input.append(new Option(choice.label,choice.value))
      const valid = current === 'default' || choices?.some(c=>c.value === current)
      if (!valid) input.append(new Option(current + (choices === undefined ? '（尚未核实）' : '（此模型不支持，请修改）'),current))
      input.value = current
      input.disabled = choices?.length === 0 && current === 'default'
      input.setCustomValidity(!valid && choices !== undefined ? '此模型不支持当前参数，请选择默认或支持的选项。' : '')
      input.onchange = () => input.setCustomValidity('')
    }
  }
  for (const [key,label,options] of fields) {
    const wrap = document.createElement('label'); wrap.textContent = label
    const input = document.createElement(options ? 'select' : 'input'); input.name = key
    if (options) for (const value of options) { const option = document.createElement('option'); option.value = value; option.textContent = value; input.append(option) }
    if (key === 'photonSecret') { input.type = 'password'; input.autocomplete = 'new-password'; input.placeholder = state.hasPhotonSecret[route.id] ? '已保存；留空保留' : '或使用环境变量' }
    else input.value = route[key] || (key === 'backend' ? 'codex' : options ? options[0] : '')
    if (['id','cwd','projectId','senderPhoneNumber','assignedPhoneNumber'].includes(key)) input.required = true
    if (key.endsWith('PhoneNumber')) input.placeholder = '+8613800000000'
    wrap.append(input)
    if (key === 'model') {
      const select = document.createElement('select'); select.dataset.role = 'models'
      select.append(new Option('使用 Agent 默认模型', ''), new Option('手动输入模型 ID…', '__custom__'))
      if (input.value) { select.append(new Option(input.value, input.value)); select.value = input.value }
      input.hidden = true; input.placeholder = '输入模型 ID'
      select.onchange = () => { input.hidden = select.value !== '__custom__'; if (select.value !== '__custom__') input.value = select.value; updateParameters(true); if (grid.querySelector('[name=backend]').value === 'dsh' && input.value) load.click() }
      const load = document.createElement('button'); load.type = 'button'; load.textContent = '刷新模型列表'
      load.onclick = async () => {
        const backend = section.querySelector('[name=backend]').value, requestedModel = input.value
        const result = await post('/api/models', {backend, id:section.querySelector('[name=id]').value, cwd:section.querySelector('[name=cwd]').value, model:input.value})
        if (!result || section.querySelector('[name=backend]').value !== backend || input.value !== requestedModel) return
        modelCatalog = result.models
        const current = input.value
        select.replaceChildren(new Option('使用 Agent 默认模型', ''))
        for (const model of result.models) select.append(new Option(model.name, model.id))
        if (current && !result.models.some(m => m.id === current)) select.append(new Option(current + '（当前配置）', current))
        select.append(new Option('手动输入模型 ID…', '__custom__')); select.value = current
        updateParameters()
        if (!result.models.length) notice('此 backend 未返回可选模型，可使用默认模型或手动输入。')
      }
      input.onchange = () => updateParameters(true)
      wrap.insertBefore(select, input); wrap.append(load)
    }
    grid.append(wrap)
  }
  const rules = document.createElement('p'); rules.className = 'runtime'; rules.dataset.role = 'rules'
  const updatePermissions = (reset = false) => {
    const backend = grid.querySelector('[name=backend]').value, policy = grid.querySelector('[name=approvalPolicy]')
    const current = reset ? 'default' : route.approvalPolicy || 'default'
    const choices = backend === 'cursor' ? [['default','沙箱内执行（默认）'],['auto-review','沙箱 + Cursor 自动审核'],['unrestricted','完全访问（关闭沙箱，不请求审批）']]
      : backend === 'dsh' ? [['default','需要权限时通过原对话审批'],['deny','拒绝所有额外权限请求']]
      : [['default','沙箱内自动执行，额外权限人工审批（默认）'],['on-request','按需人工审批'],['auto-review','沙箱 + Codex 自动审核'],['never','不请求审批，超出沙箱则拒绝']]
    policy.replaceChildren(...choices.map(([value,label])=>new Option(label,value))); policy.value = choices.some(([value])=>value===current) ? current : 'default'
    const settings = grid.querySelector('[name=cursorSettings]')
    if (!settings.disabled) settings.dataset.cursorValue = settings.value || 'project'
    settings.parentElement.hidden = false
    settings.disabled = backend !== 'cursor'
    if (backend === 'cursor') {
      settings.replaceChildren(...[['project','加载项目规则（AGENTS.md / .cursor）'],['project-user','加载项目和用户规则'],['none','不加载本地规则']].map(([value,label])=>new Option(label,value)))
      settings.value = settings.dataset.cursorValue || route.cursorSettings || 'project'
    } else {
      settings.replaceChildren(new Option(`${backend === 'codex' ? 'Codex' : 'DSH'} 原生加载（此处不可切换）`, ''))
    }
    rules.textContent = backend === 'cursor' ? '项目规则：按上方选择由 Cursor SDK 加载 AGENTS.md、.cursor 配置。'
      : backend === 'codex' ? '项目规则：Codex 原生加载用户及项目路径上的 AGENTS.md / AGENTS.override.md；子目录规则按作用域生效。Gateway 不覆盖原生加载策略。'
      : '项目规则：DSH 原生加载 $DSH_HOME/AGENTS.md（通常为 ~/.dsh/AGENTS.md）及项目 AGENTS.md / CLAUDE.md 和对应 .local.md；按 DSH 配置及目录作用域生效。'

  }
  updatePermissions()
  updateParameters()
  grid.querySelector('[name=backend]').onchange = () => {
    updatePermissions(true)
    modelCatalog = []
    const input = section.querySelector('[name=model]'), select = section.querySelector('[data-role=models]')
    input.value = ''; input.hidden = true
    select.replaceChildren(new Option('使用 Agent 默认模型', ''), new Option('手动输入模型 ID…', '__custom__'))
    section.querySelector('[name=effort]').value = 'default'
    section.querySelector('[name=speed]').value = 'default'
    updateParameters(true)
    select.parentElement.querySelector('button').click()
  }
  const enabled = document.createElement('label'); enabled.textContent = '自动启动'
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'enabled'; checkbox.checked = route.enabled !== false; enabled.append(checkbox); grid.append(enabled)
  const provision = document.createElement('button'); provision.type = 'button'; provision.textContent = '通过 Photon 创建 / 获取号码'
  const provisionStatus = document.createElement('p'); provisionStatus.className = 'provision-status'; provisionStatus.setAttribute('role','status'); provisionStatus.setAttribute('aria-live','polite')
  const provisionNotice = message => { provisionStatus.textContent = message; notice(message) }
  provision.onclick = async () => {
    const id = section.querySelector('[name=id]').value.trim(), sender = section.querySelector('[name=senderPhoneNumber]').value.trim()
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) { provisionNotice('请填写有效的路由 ID（字母、数字、下划线或短横线）。'); section.querySelector('[name=id]').focus(); return }
    if (!/^\+[1-9]\d{6,14}$/.test(sender)) { provisionNotice('请先填写你的 iMessage 号码，包含国家区号，例如 +8613800000000。'); section.querySelector('[name=senderPhoneNumber]').focus(); return }
    if (state.authorization.phase !== 'authorized') { provisionNotice('请先在“消息渠道”中完成 Photon 项目管理授权。'); return }
    const name = id
    const label = provision.textContent; provision.textContent = '正在获取 Photon 号码…'
    let result
    try { result = await post('/api/photon/provision', {id, sender, name}, provisionNotice) }
    finally { provision.textContent = label }
    if (result) { section.querySelector('[name=projectId]').value = result.projectId; section.querySelector('[name=assignedPhoneNumber]').value = result.assignedPhoneNumber; section.querySelector('[name=photonSecret]').value = ''; section.querySelector('[name=photonSecret]').placeholder = '已获取；保存项目后生效'; provisionNotice('已获取号码：' + result.assignedPhoneNumber + '。请点击“保存并应用此项目”。') }
  }
  const photonBox = document.createElement('div'); photonBox.className = 'photon-picker'
  const photonLabel = document.createElement('label'); photonLabel.textContent = '选择已有 Photon 项目'
  const projectSelect = document.createElement('select'); projectSelect.append(new Option('先加载已有项目', ''))
  photonLabel.append(projectSelect)
  const loadProjects = document.createElement('button'); loadProjects.type = 'button'; loadProjects.textContent = '加载已有项目'
  loadProjects.onclick = async () => {
    const result = await post('/api/photon/projects')
    if (!result) return
    projectSelect.replaceChildren(new Option('请选择 Photon 项目', ''))
    for (const project of result.projects) projectSelect.append(new Option(project.name + ' · ' + project.id, project.id))
    projectSelect.value = section.querySelector('[name=projectId]').value
    if (!result.projects.length) notice('当前 Photon 账户没有项目，可以创建新项目。')
  }
  const useProject = document.createElement('button'); useProject.type = 'button'; useProject.textContent = '使用所选项目 / 获取号码'
  useProject.onclick = async () => {
    const selectedProjectId = projectSelect.value
    const id = section.querySelector('[name=id]').value.trim(), sender = section.querySelector('[name=senderPhoneNumber]').value.trim()
    if (!projectSelect.value || !sender) { notice('请先选择 Photon 项目并填写你的 iMessage 号码。'); return }
    const result = await post('/api/photon/select', {id, name:id, sender, projectId:selectedProjectId})
    if (result && projectSelect.value === selectedProjectId && section.querySelector('[name=senderPhoneNumber]').value.trim() === sender) {
      section.querySelector('[name=projectId]').value = result.projectId
      section.querySelector('[name=assignedPhoneNumber]').value = result.assignedPhoneNumber
      section.querySelector('[name=photonSecret]').value = ''
      section.querySelector('[name=photonSecret]').placeholder = '已获取；保存项目后生效'
      notice('已选择 Photon 项目并获取号码，请点击保存。')
    }
  }
  projectSelect.onchange = () => {
    const projectId = section.querySelector('[name=projectId]')
    projectId.readOnly = Boolean(projectSelect.value)
    if (!projectSelect.value) return
    const changed = projectId.value !== projectSelect.value
    projectId.value = projectSelect.value
    if (changed) {
      section.querySelector('[name=assignedPhoneNumber]').value = ''
      section.querySelector('[name=photonSecret]').value = ''
      section.querySelector('[name=photonSecret]').placeholder = '选择项目后自动获取'
    }
    if (section.querySelector('[name=senderPhoneNumber]').value.trim()) void useProject.onclick()
    else notice('已选择 Photon 项目。填写你的 iMessage 号码后，将自动获取线路号码和凭证。')
  }
  grid.querySelector('[name=senderPhoneNumber]').addEventListener('change', () => {
    if (projectSelect.value) void useProject.onclick()
  })
  photonBox.append(photonLabel,loadProjects,useProject)
  const channelsBox = document.createElement('div'); channelsBox.className = 'channels'
  const channelsTitle = document.createElement('h3'); channelsTitle.textContent = '消息入口'
  const channelsHelp = document.createElement('p'); channelsHelp.textContent = '同一项目可绑定多个入口。每个入口的会话、任务和审批独立。微信仅响应扫码绑定者。'
  const iMessageLabel = document.createElement('label'); iMessageLabel.className = 'channel-toggle'
  const iMessageEnabled = document.createElement('input'); iMessageEnabled.type='checkbox'; iMessageEnabled.dataset.role='imessage-enabled'
  iMessageEnabled.checked = !route.channels || Boolean(initialIMessage)
  iMessageLabel.append(iMessageEnabled,document.createTextNode('启用 iMessage'))
  const weixinRows = document.createElement('div'); weixinRows.dataset.role='weixin-bindings'
  const addBinding = (binding = {}) => {
    const row = document.createElement('div'); row.className='channel-binding'; row.dataset.bindingId=binding.id || 'weixin-'+crypto.randomUUID().slice(0,8)
    const label = document.createElement('label'); label.textContent='微信机器人'
    const select = document.createElement('select'); select.dataset.role='weixin-account'; select.required=true
    select.append(new Option('选择已扫码绑定的机器人',''))
    for (const account of state.weixinAccounts || []) select.append(new Option(account.accountId,account.accountId))
    if (binding.accountId && ![...select.options].some(o=>o.value===binding.accountId)) select.append(new Option(binding.accountId+'（需重新扫码）',binding.accountId))
    select.value=binding.accountId || ''
    const remove = document.createElement('button'); remove.type='button'; remove.textContent='移除此入口'; remove.onclick=()=>row.remove()
    label.append(select); row.append(label,remove); weixinRows.append(row)
  }
  for (const binding of route.channels || []) if (binding.kind==='weixin') addBinding(binding)
  section.readBindings = () => [...weixinRows.children].map(row=>({kind:'weixin',id:row.dataset.bindingId,accountId:row.querySelector('select').value}))
  // Preserve additional iMessage bindings authored in the config file.
  section.extraBindings = (route.channels || []).filter(c=>c.kind==='imessage' && c !== initialIMessage)
  section.iMessageId = initialIMessage?.id || 'imessage'
  const addWeixin = document.createElement('button'); addWeixin.type='button'; addWeixin.textContent='＋ 添加微信入口'; addWeixin.onclick=()=>addBinding()
  const updateChannels = () => {
    for (const key of ['projectId','projectSecretEnv','senderPhoneNumber','assignedPhoneNumber','photonSecret']) {
      const input=grid.querySelector('[name='+key+']'); input.parentElement.hidden=!iMessageEnabled.checked; input.disabled=!iMessageEnabled.checked
      input.required=iMessageEnabled.checked && ['projectId','senderPhoneNumber','assignedPhoneNumber'].includes(key)
    }
    photonBox.hidden=provision.hidden=provisionStatus.hidden=!iMessageEnabled.checked
  }
  iMessageEnabled.onchange=updateChannels
  channelsBox.append(channelsTitle,channelsHelp,iMessageLabel,weixinRows,addWeixin)
  section.append(grid,channelsBox,rules,photonBox,provision,provisionStatus)
  updateChannels()
  const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存并应用此项目'
  save.onclick = async () => {
    for (const input of section.querySelectorAll('input,select')) if (!input.reportValidity()) return
    const value = readRoute(section)
    if (state.config.routes.some(r => r.id === section.dataset.id) && value.id !== section.dataset.id) { notice('单独保存时不能修改路由 ID，请使用全局保存。'); return }
    const result = await post('/api/save-route', {revision:formRevision, id:value.id, route:value, photon:{[value.id]:section.querySelector('[name=photonSecret]').value.trim()}})
    if (result) {
      formRevision = state.revision; section.dataset.id = value.id
      section.querySelector('[name=photonSecret]').value = ''
      section.querySelector('[name=photonSecret]').placeholder = state.hasPhotonSecret[value.id] ? '已保存；留空保留' : '或使用环境变量'
      navigation(); statuses(); notice('此项目已保存并应用，其他项目未重启。')
    }
  }
  save.className='primary project-save'
  section.append(save)
  const runtime = document.createElement('p'); runtime.className = 'runtime'; runtime.dataset.role = 'runtime'; section.append(runtime)
  const advanced=document.createElement('details'); advanced.className='advanced'
  const summary=document.createElement('summary'); summary.textContent='高级配置'; advanced.append(summary)
  const advancedGrid=document.createElement('div'); advancedGrid.className='grid'; advanced.append(advancedGrid)
  for(const key of ['id','approvalPolicy','cursorSettings','effort','speed']) advancedGrid.append(grid.querySelector('[name='+key+']').parentElement)
  grid.append(advanced); advanced.append(rules)
  const imessage=document.createElement('details'); imessage.className='imessage-config'
  const imessageTitle=document.createElement('summary'); imessageTitle.textContent='iMessage 号码与连接配置'; imessage.append(imessageTitle)
  const imessageGrid=document.createElement('div'); imessageGrid.className='grid'; imessage.append(imessageGrid)
  for(const key of ['projectId','projectSecretEnv','senderPhoneNumber','assignedPhoneNumber','photonSecret']) imessageGrid.append(grid.querySelector('[name='+key+']').parentElement)
  grid.append(imessage); imessage.append(photonBox,provision,provisionStatus)
  const originalChannelChange=iMessageEnabled.onchange
  iMessageEnabled.onchange=()=>{originalChannelChange();imessage.hidden=!iMessageEnabled.checked}
  imessage.hidden=!iMessageEnabled.checked
  const manage=document.createElement('button');manage.type='button';manage.className='text-button';manage.textContent='管理消息账号 →';manage.onclick=()=>showView('channels');channelsBox.append(manage)
  $('routes').append(section)
  navigation()
}
const phaseLabel = phase => ({listening:'运行中',stopped:'已停止',starting:'启动中',connecting:'连接中',error:'连接异常',failed:'连接失败',reconnecting:'重新连接中'}[phase] || phase)
function statuses() {
  for (const section of $('routes').children) {
    const status = state.routes.find(r => r.id === section.dataset.id)
    const badge = section.querySelector('[data-role=status]'); badge.textContent = status ? phaseLabel(status.phase) : '未保存'; badge.classList.toggle('live', status?.phase === 'listening')
    section.querySelector('[data-role=runtime]').textContent = status?.channels?.map(c=>`${c.kind === 'weixin' ? '微信' : 'iMessage'} · ${phaseLabel(c.phase)} · ${c.error || (c.busy ? '任务运行中' : '空闲')} · 待处理 ${c.pending || 0} · 已接收 ${c.receivedCount || 0}`).join('\n') || status?.error || (status ? `${status.busy ? '任务运行中' : '空闲'} · 会话 ${status.sessionId || '尚未开始'} · 待处理 ${status.pending || 0} · 已接收 ${status.receivedCount || 0} · 最近结果 ${status.lastTurnStatus || '—'}` : '')
  }
}
async function refresh(initial = false) {
  const response = await fetch('/api/state'); if (!response.ok) throw new Error('无法连接本地 Gateway')
  state = await response.json(); csrf = state.csrf
  $('connection').textContent = '● 本机服务已连接'
  $('key-state').textContent = state.hasCursorKey ? '已配置 Cursor API Key' : '尚未配置；也可以使用 CURSOR_API_KEY 环境变量'
  if (initial) { formRevision = state.revision; $('routes').replaceChildren(); state.config.routes.forEach(renderRoute); navigation() }
  const auth = state.authorization
  $('photon-state').textContent = auth.phase === 'pending' ? `输入验证码 ${auth.userCode}` : ({ authorized:'已授权，可以创建项目和获取号码。', disconnected:'尚未授权项目管理；不影响已配置线路的消息收发。', 'reauthorization-required':'管理授权已过期；已有线路继续运行。', failed:'管理授权失败，请重试。' }[auth.phase] || auth.phase)
  const link = $('photon-link'); link.textContent = ''; link.removeAttribute('href')
  if (auth.phase === 'pending') {
    const url = new URL(auth.verificationUriComplete || auth.verificationUri)
    if (url.protocol === 'https:') { link.href = url.href; link.textContent = '打开 Photon 授权页面' }
  }
  renderWeixinState()
  statuses()
}
function renderWeixinState() {
  const login=state.weixinLogin || {phase:'idle'}
  $('weixin-state').textContent=login.error || ({idle:'用个人微信扫码绑定，然后在项目中添加微信入口。',pending:'请用微信扫描二维码。',scanned:'已扫码，请在微信确认。',needs_verification:'请填写微信显示的配对码。',connected:'绑定成功，请在项目中选择机器人并保存。',expired:'二维码已过期，请重新生成。',failed:'绑定失败，请重试。',cancelled:'已取消绑定。'}[login.phase] || login.phase)
  const qr=$('weixin-qr'); qr.hidden=!login.qr
  if (login.qr && qr.getAttribute('src')!==login.qr) qr.src=login.qr
  if (!login.qr) qr.removeAttribute('src')
  $('weixin-verification').hidden=login.phase!=='needs_verification'
  for (const select of document.querySelectorAll('[data-role=weixin-account]')) {
    for (const account of state.weixinAccounts || []) if (![...select.options].some(o=>o.value===account.accountId)) select.append(new Option(account.accountId,account.accountId))
  }
}
async function post(path, value = {}, report = notice) {
  if (busy) { report('另一项操作正在进行，请稍后重试。'); return }
  busy = true; report('正在处理，请稍候…'); document.querySelectorAll('button').forEach(b => b.disabled = true)
  try {
    const response = await fetch(path, { method:'POST', headers:{'content-type':'application/json','x-agent-token':csrf}, body:JSON.stringify(value), signal:AbortSignal.timeout(90_000) })
    const data = await response.json(); if (!response.ok) throw new Error(data.error)
    await refresh(path === '/api/save'); if (path === '/api/save') $('cursor-key').value = ''; report('已应用。'); return data
  } catch(error) { report(error.name === 'TimeoutError' ? '请求超时，服务器可能仍在处理。请先检查当前绑定或项目状态，避免重复操作。' : error.message) }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false) }
}
function readRoute(section) {
  const original = state.config.routes.find(r => r.id === section.dataset.id)
  const route = { ...(original || {}) }
  for (const input of section.querySelectorAll('input,select')) {
    if (!input.name || input.name === 'photonSecret') continue
    if (input.name === 'cursorSettings' && input.disabled) { delete route.cursorSettings; continue }
    if (input.name === 'enabled') route.enabled = input.checked
    else if (input.value.trim()) route[input.name] = input.value.trim()
    else delete route[input.name]
  }
  route.projectSecretEnv ||= 'AGENT_PHOTON_' + route.id.replaceAll('-', '_')
  const bindings = [...section.extraBindings,...section.readBindings()]
  const imessage = section.querySelector('[data-role=imessage-enabled]').checked
  // Keep untouched legacy routes unchanged; explicit channels are needed only for new bindings.
  if (bindings.length || original?.channels || !imessage) {
    route.channels = [...(imessage ? [{kind:'imessage',id:section.iMessageId,projectId:route.projectId,projectSecretEnv:route.projectSecretEnv,senderPhoneNumber:route.senderPhoneNumber,assignedPhoneNumber:route.assignedPhoneNumber}] : []),...bindings]
  }
  if (!imessage) for (const key of ['projectId','projectSecretEnv','senderPhoneNumber','assignedPhoneNumber']) delete route[key]
  return route
}
$('settings').onsubmit = event => {
  event.preventDefault()
  for(const input of $('settings').querySelectorAll('input,select')) if(!input.reportValidity()) return
  const photon = {}, routes = []
  for (const section of $('routes').children) {
    const route = readRoute(section)
    photon[route.id] = section.querySelector('[name=photonSecret]').value.trim()
    routes.push(route)
  }
  void post('/api/save', { revision:formRevision, config:{...state.config,routes}, photon, cursorApiKey:$('cursor-key').value })
}
$('add').onclick = () => { const id='project-'+crypto.randomUUID().slice(0,8); renderRoute({id,backend:'codex'}); showView('project',id); statuses(); $('routes').lastElementChild.querySelector('[name=label]').focus() }
$('start').onclick = () => post('/api/start')
$('stop').onclick = () => post('/api/stop')
refresh(true).catch(error => notice(error.message))
setInterval(() => { if (!busy) refresh().catch(() => { $('connection').textContent = '服务连接中断' }) }, 3000)

$('authorize').onclick = () => post('/api/photon/authorize')
$('cancel-auth').onclick = () => post('/api/photon/cancel')

$('weixin-begin').onclick=()=>post('/api/weixin/begin')
$('weixin-cancel').onclick=()=>post('/api/weixin/cancel')
$('weixin-verify').onclick=()=>post('/api/weixin/verify',{id:state.weixinLogin.id,code:$('weixin-code').value.trim()})

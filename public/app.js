let state, csrf, formRevision, busy = false
const $ = id => document.getElementById(id)
const fields = [
  ['label','项目名称'], ['backend','Agent backend',['cursor','codex','dsh']], ['id','路由 ID'],
  ['cwd','工作目录（绝对路径）'], ['approvalPolicy','审批权限',['default']], ['cursorSettings','项目规则',['project','project-user','none']], ['model','模型'], ['effort','推理强度',['default','none','off','minimal','low','medium','high','xhigh','max','ultra']],
  ['speed','速度',['default','fast','standard']], ['projectId','Photon 项目 ID'], ['projectSecretEnv','Photon 环境变量（可选）'],
  ['senderPhoneNumber','你的 iMessage 号码'], ['assignedPhoneNumber','Photon 分配的号码'], ['photonSecret','Photon Project Secret'],
]
function notice(message) { $('notice').textContent = message }
function renderRoute(route) {
  const section = document.createElement('section'); section.className = 'route'; section.dataset.id = route.id
  const heading = document.createElement('div'); heading.className = 'route-head'
  const title = document.createElement('h2'); title.textContent = route.label || route.id
  const badge = document.createElement('span'); badge.className = 'badge'; badge.dataset.role = 'status'
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.onclick = () => section.remove()
  heading.append(title,badge,remove); section.append(heading)
  const grid = document.createElement('div'); grid.className = 'grid'
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
      select.append(new Option('使用 backend 默认模型', ''), new Option('手动输入模型 ID…', '__custom__'))
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
        select.replaceChildren(new Option('使用 backend 默认模型', ''))
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
      : backend === 'dsh' ? [['default','需要权限时通过 iMessage 审批'],['deny','拒绝所有额外权限请求']]
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
    select.replaceChildren(new Option('使用 backend 默认模型', ''), new Option('手动输入模型 ID…', '__custom__'))
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
    if (state.authorization.phase !== 'authorized') { provisionNotice('请先在页面上方完成 Photon 项目管理授权。'); return }
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
  section.append(grid,rules,photonBox,provision,provisionStatus)
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
      statuses(); notice('此项目已保存并应用，其他项目未重启。')
    }
  }
  section.append(save)
  const runtime = document.createElement('p'); runtime.className = 'runtime'; runtime.dataset.role = 'runtime'; section.append(runtime)
  $('routes').append(section)
}
function statuses() {
  for (const section of $('routes').children) {
    const status = state.routes.find(r => r.id === section.dataset.id)
    const badge = section.querySelector('[data-role=status]'); badge.textContent = status?.phase || '未保存'; badge.classList.toggle('live', status?.phase === 'listening')
    section.querySelector('[data-role=runtime]').textContent = status?.error || (status ? `${status.busy ? '任务运行中' : '空闲'} · 会话 ${status.sessionId || '尚未开始'} · 待处理 ${status.pending || 0} · 已接收 ${status.receivedCount || 0} · 最近结果 ${status.lastTurnStatus || '—'}` : '')
  }
}
async function refresh(initial = false) {
  const response = await fetch('/api/state'); if (!response.ok) throw new Error('无法连接本地 Gateway')
  state = await response.json(); csrf = state.csrf
  $('connection').textContent = '● 本机服务已连接'
  $('key-state').textContent = state.hasCursorKey ? '已配置 Cursor API Key' : '尚未配置；也可以使用 CURSOR_API_KEY 环境变量'
  if (initial) { formRevision = state.revision; $('routes').replaceChildren(); state.config.routes.forEach(renderRoute) }
  const auth = state.authorization
  $('photon-state').textContent = auth.phase === 'pending' ? `输入验证码 ${auth.userCode}` : ({ authorized:'已授权，可以创建项目和获取号码。', disconnected:'尚未授权项目管理；不影响已配置线路的消息收发。', 'reauthorization-required':'管理授权已过期；已有线路继续运行。', failed:'管理授权失败，请重试。' }[auth.phase] || auth.phase)
  const link = $('photon-link'); link.textContent = ''; link.removeAttribute('href')
  if (auth.phase === 'pending') {
    const url = new URL(auth.verificationUriComplete || auth.verificationUri)
    if (url.protocol === 'https:') { link.href = url.href; link.textContent = '打开 Photon 授权页面' }
  }
  statuses()
}
async function post(path, value = {}, report = notice) {
  if (busy) { report('另一项操作正在进行，请稍后重试。'); return }
  busy = true; report('正在处理，请稍候…'); document.querySelectorAll('button').forEach(b => b.disabled = true)
  try {
    const response = await fetch(path, { method:'POST', headers:{'content-type':'application/json','x-agent-token':csrf}, body:JSON.stringify(value), signal:AbortSignal.timeout(90_000) })
    const data = await response.json(); if (!response.ok) throw new Error(data.error)
    await refresh(path === '/api/save'); if (path === '/api/save') $('cursor-key').value = ''; report('已应用。'); return data
  } catch(error) { report(error.name === 'TimeoutError' ? '请求超时，服务器可能仍在处理。请先加载已有 Photon 项目确认结果，避免重复创建。' : error.message) }
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
  return route
}
$('settings').onsubmit = event => {
  event.preventDefault()
  const photon = {}, routes = []
  for (const section of $('routes').children) {
    const route = readRoute(section)
    photon[route.id] = section.querySelector('[name=photonSecret]').value.trim()
    routes.push(route)
  }
  void post('/api/save', { revision:formRevision, config:{...state.config,routes}, photon, cursorApiKey:$('cursor-key').value })
}
$('add').onclick = () => { renderRoute({id:'project-'+crypto.randomUUID().slice(0,8),backend:'cursor'}); statuses() }
$('start').onclick = () => post('/api/start')
$('stop').onclick = () => post('/api/stop')
refresh(true).catch(error => notice(error.message))
setInterval(() => { if (!busy) refresh().catch(() => { $('connection').textContent = '服务连接中断' }) }, 3000)

$('authorize').onclick = () => post('/api/photon/authorize')
$('cancel-auth').onclick = () => post('/api/photon/cancel')

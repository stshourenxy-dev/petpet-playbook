// PetPet 桌宠查看器 - 主进程
// Electron 主进程：透明窗口、托盘、IPC 文件读取
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')

const PETS_ROOT = path.join(app.getPath('home'), '.petpet', 'pets')
let mainWindow = null
let tray = null
let currentPetId = null
let currentPetActions = null
let currentPetName = '宠物'  // P0-3：菜单文案不再硬编码红苕

// 动作名 → 中文标签
const ACTION_LABELS = {
  idle: '待机', sleep: '睡觉', sniff: '嗅闻', wiggle: '撒娇',
  run: '奔跑', belly: '露肚躺', poop: '拉粑粑', stretch: '伸懒腰'
}

// ---------- 窗口 ----------
// P2-8: 窗口位置/缩放持久化到 ~/.petpet/ui-state.json
const UI_STATE_FILE = path.join(PETS_ROOT, '..', 'ui-state.json')

function loadUiState() {
  try {
    return JSON.parse(fs.readFileSync(UI_STATE_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

function saveUiState(patch) {
  try {
    const state = { ...loadUiState(), ...patch }
    fs.mkdirSync(path.dirname(UI_STATE_FILE), { recursive: true })
    fs.writeFileSync(UI_STATE_FILE, JSON.stringify(state))
  } catch (e) {
    console.error('[PetPet] UI 状态保存失败', e)
  }
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const saved = loadUiState()

  mainWindow = new BrowserWindow({
    width: 320,
    height: 320,
    x: saved.x ?? Math.round(width - 380),
    y: saved.y ?? Math.round(height - 420),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false // 动画不节流（借鉴 bitnp）
    }
  })

  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // 窗口移动/关闭时保存位置
  mainWindow.on('moved', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveUiState({ x: mainWindow.getPosition()[0], y: mainWindow.getPosition()[1] })
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// ---------- 托盘 ----------
// ⚠️ 已知坑（历史第 4 次）：macOS 菜单栏图标必须用有效图片 + setTemplateImage(true)
// 模板模式 = 黑色形状带 alpha，系统自动适配深浅色菜单栏；否则图标透明不可见
function createTray() {
  try {
    console.log('[PetPet] createTray 开始')
    // 借鉴 BITNP/bitnp-desktop-pet：内嵌 base64 图标，不依赖文件路径（打包后 asar 也 100% 有效）
    // 彩色爪印，任何菜单栏背景下都可见（不用模板图，避免系统反色导致透明）
    const icon = nativeImage.createFromDataURL('data:image/png;base64,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')
    // 菜单栏标准 22pt：必须 resize，否则 64px 原图会撑爆菜单栏
    const sized = icon.resize({ width: 22, height: 22 })
    console.log('[PetPet] 图标加载:', sized.isEmpty() ? 'FAILED' : 'OK', JSON.stringify(sized.getSize()))
    tray = new Tray(sized)
    console.log('[PetPet] Tray 创建成功')
    tray.setToolTip('PetPet 桌宠')
    rebuildTrayMenu()
    console.log('[PetPet] 托盘菜单已设置')
  } catch (error) {
    console.error('[PetPet] 创建托盘失败:', error)
  }
}

function rebuildTrayMenu() {
  const petName = currentPetName || '宠物'
  const template = [
    { label: 'PetPet 桌宠', enabled: false },
    { type: 'separator' },
    { label: '🐾 显示/隐藏', click: () => toggleWindow() },
    { label: '🔍 放大', click: () => send('view:zoom', 1.15) },
    { label: '🔎 缩小', click: () => send('view:zoom', 1 / 1.15) },
    { label: '↺ 重置大小', click: () => send('view:reset') }
  ]

  // P0-1：多宠切换（列出 PETS_ROOT 下所有宠物包）
  let pets = []
  try {
    pets = fs.readdirSync(PETS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[a-z0-9_-]+$/i.test(d.name))
      .map(d => d.name)
    if (pets.length > 1) {
      template.push({ type: 'separator' })
      template.push({
        label: '🐕 切换宠物',
        submenu: pets.map(id => ({
          label: id === currentPetId ? `${id} ✓` : id,
          type: 'radio',
          checked: id === currentPetId,
          click: () => send('pet:switch', id)
        }))
      })
    }
  } catch (e) { /* PETS_ROOT 不存在时忽略 */ }

  // 动作子菜单（从 pet.json 加载，恢复旧版功能）
  if (currentPetActions && Object.keys(currentPetActions).length > 0) {
    const actionItems = Object.keys(currentPetActions).map(name => ({
      label: ACTION_LABELS[name] || name,
      click: () => send('pet:action', name)
    }))
    template.push({ type: 'separator' })
    template.push({ label: '🎬 切换动作', submenu: actionItems })
  }

  // 方案B：功能入口兜底（右键手势不可用时从托盘调出）
  template.push({ type: 'separator' })
  template.push({ label: `📖 ${petName}日记`, click: () => openDiaryWindow(currentPetId || pets[0] || 'redshao') })
  template.push({ label: '⏰ 提醒我', click: () => openReminderWithFocus() })

  template.push({ type: 'separator' })
  template.push({ label: '🚪 退出', click: () => app.quit() })
  console.log('[PetPet][诊断] 菜单动作子项数:', currentPetActions?Object.keys(currentPetActions).length:0)
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

// 右键菜单：原生 macOS Menu.popup（自动毛玻璃/定位，替代 HTML 自绘）
ipcMain.handle('menu:showContext', (_evt, x, y) => {
  const petName = currentPetName || '宠物'
  const template = [
    { label: petName, enabled: false },
    { type: 'separator' },
    { label: '⏰ 提醒我', click: () => openReminderWithFocus() },
    { label: `📖 ${petName}日记`, click: () => openDiaryWindow(currentPetId || 'redshao') },
    { type: 'separator' }
  ]
  if (currentPetActions && Object.keys(currentPetActions).length > 0) {
    Object.keys(currentPetActions).forEach(name => {
      template.push({ label: ACTION_LABELS[name] || name, click: () => send('pet:action', name) })
    })
  }
  template.push({ type: 'separator' })
  template.push({ label: '↺ 重置大小', click: () => send('view:reset') })
  const menu = Menu.buildFromTemplate(template)
  menu.popup({ x: Math.round(x), y: Math.round(y) })
})

function toggleWindow() {
  if (!mainWindow) return
  if (mainWindow.isVisible()) mainWindow.hide()
  else mainWindow.show()
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

// P0-4: 从托盘/菜单打开提醒面板前，先解除窗口穿透 + 抢焦点（否则面板点不动、键盘输不进去）
function openReminderWithFocus() {
  if (!mainWindow) return
  mainWindow.setIgnoreMouseEvents(false)
  mainWindow.show()
  mainWindow.focus()
  send('open:reminder')
}

// ---------- IPC：宠物资产读取 ----------
// 列出 ~/.petpet/pets 下的宠物
ipcMain.handle('pet:list', () => {
  try {
    const dirs = fs.readdirSync(PETS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(name => fs.existsSync(path.join(PETS_ROOT, name, 'pet.json')))
    return dirs
  } catch (e) {
    return []
  }
})

// 读取 pet.json
ipcMain.handle('pet:load', (_evt, petId) => {
  try {
    const p = path.join(PETS_ROOT, petId, 'pet.json')
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (e) {
    return { error: String(e) }
  }
})

// 渲染进程加载宠物后通知主进程（用于托盘动作菜单）
ipcMain.on('pet:loaded', (_evt, petId) => {
  currentPetId = petId
  try {
    const p = path.join(PETS_ROOT, petId, 'pet.json')
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    currentPetActions = parsed.actions
    currentTheme = parsed.theme || 'bro'
    currentPetName = parsed.name || '宠物'  // P0-3：宠物名跟随 pet.json
  } catch (e) {
    currentPetActions = null
    currentTheme = 'bro'
  }
  console.log('[PetPet][诊断] pet:loaded →', petId, '动作数:', currentPetActions?Object.keys(currentPetActions).length:0)
  rebuildTrayMenu()
})

// 读取精灵表文件 → dataURL（按扩展名传 MIME）
const MIME = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif'
}

ipcMain.handle('pet:file', (_evt, petId, relPath) => {
  try {
    const full = path.join(PETS_ROOT, petId, relPath)
    if (!full.startsWith(PETS_ROOT)) return { error: 'invalid path' }
    const buf = fs.readFileSync(full)
    const ext = path.extname(full).toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  } catch (e) {
    return { error: String(e) }
  }
})

// 窗口尺寸变化（渲染进程请求调整窗口大小）
ipcMain.on('view:setSize', (_evt, w, h) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setSize(Math.max(60, Math.round(w)), Math.max(60, Math.round(h)))
})

// 窗口移动（拖拽宠物）
ipcMain.on('view:move', (_evt, x, y) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setPosition(Math.round(x), Math.round(y))
})

// 鼠标穿透（借鉴 bitnp：透明区穿透，宠物区交互；forward=true 穿透时仍收 mousemove）
ipcMain.on('pet:setIgnoreMouse', (_evt, ignore, forward) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setIgnoreMouseEvents(ignore, { forward: !!forward })
})

// 查询窗口当前位置（拖拽用）
ipcMain.handle('view:getPos', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0 }
  const [x, y] = mainWindow.getPosition()
  return { x, y }
})

// ---------- 提醒系统 + 活动记录（方案B，2026-08-06） ----------
const reminders = new Map() // id -> { at, repeat, text }
let reminderSeq = 0
const REMINDERS_FILE = path.join(app.getPath('home'), '.petpet', 'reminders.json')

// P0-5: 提醒持久化——退出不丢（"每天/每周"提醒的语义就是设一次不用管）
function loadReminders() {
  try {
    const raw = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf-8'))
    for (const [id, r] of Object.entries(raw.reminders || {})) {
      if (!r || typeof r.at !== 'number' || !r.text) continue
      reminders.set(id, { at: r.at, repeat: r.repeat || 'none', text: r.text })
      reminderSeq = Math.max(reminderSeq, parseInt(String(id).replace(/\D/g, '')) || 0)
    }
    console.log(`[PetPet] 已载入 ${reminders.size} 条提醒`)
  } catch (e) {
    console.log('[PetPet] 无提醒存档或读取失败，从空开始')
  }
}

function saveReminders() {
  try {
    fs.mkdirSync(path.dirname(REMINDERS_FILE), { recursive: true })
    const obj = {}
    for (const [id, r] of reminders) obj[id] = r
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify({ reminders: obj }, null, 2))
  } catch (e) {
    console.error('[PetPet] 提醒存档失败:', e)
  }
}

// 校验 petId，防路径穿越
function safePetId(id) {
  return typeof id === 'string' && /^[a-z0-9_-]+$/i.test(id) ? id : null
}

function activityPath(petId) {
  return path.join(PETS_ROOT, petId, 'activity.json')
}

function appendActivity(petId, entry) {
  const pid = safePetId(petId) || currentPetId || 'redshao'
  if (!pid) return
  try {
    const p = activityPath(pid)
    let list = []
    if (fs.existsSync(p)) {
      try { list = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch (e) { list = [] }
    }
    if (!Array.isArray(list)) list = []
    list.push({ ts: Date.now(), ...entry })
    if (list.length > 100) list = list.slice(-100)
    fs.writeFileSync(p, JSON.stringify(list, null, 2))
  } catch (e) {
    console.error('[PetPet] 写活动记录失败:', e)
  }
}

// 渲染进程追加一条活动记录
ipcMain.on('pet:activity', (_evt, entry) => {
  if (!entry || typeof entry !== 'object') return
  appendActivity(entry.petId, { mood: String(entry.mood || ''), text: String(entry.text || '') })
})

// 读取活动记录
function readActivity(petId) {
  const pid = safePetId(petId)
  if (!pid) return []
  try {
    const p = activityPath(pid)
    if (!fs.existsSync(p)) return []
    const list = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

ipcMain.handle('pet:activity:list', (_evt, petId) => readActivity(petId))

// 红苕日记面板：独立小窗口（避免在宠物窗口内遮挡宠物）
let diaryWindow = null
let currentActionInfo = null // 当前动作文案（动作切换时由渲染进程推送）

// 动作切换 → 更新当前状态 + 实时推送到日记窗口
ipcMain.on('pet:action:notify', (_evt, info) => {
  currentActionInfo = info
  if (diaryWindow && !diaryWindow.isDestroyed()) {
    diaryWindow.webContents.send('diary:status', info)
  }
})
let currentTheme = 'bro'

function openDiaryWindow(petId) {
  const theme = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(PETS_ROOT, safePetId(petId) || 'redshao', 'pet.json'), 'utf-8')).theme || 'bro'
    } catch (e) {
      return 'bro'
    }
  })()
  const sendData = (win) => win.webContents.send('diary:data', { petId, petName: currentPetName, theme, entries: readActivity(petId), status: currentActionInfo })
  if (diaryWindow && !diaryWindow.isDestroyed()) {
    diaryWindow.focus()
    sendData(diaryWindow)
    return
  }
  const pos = mainWindow ? mainWindow.getPosition() : [100, 100]
  const size = mainWindow ? mainWindow.getSize() : [320, 320]
  const work = screen.getPrimaryDisplay().workAreaSize
  let x = pos[0] + size[0] + 8
  if (x + 300 > work.width) x = Math.max(0, pos[0] - 300 - 8) // 右侧无空间则放左侧
  diaryWindow = new BrowserWindow({
    width: 300,
    height: 400,
    x,
    y: Math.max(0, pos[1]),
    frame: false,
    // P1-8: 日记窗口可拖动、可缩放（此前不可移动不可缩放，挡住内容只能退出重开）
    movable: true,
    resizable: true,
    minWidth: 240,
    minHeight: 240,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'panel-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  diaryWindow.setAlwaysOnTop(true, 'screen-saver')
  diaryWindow.loadFile(path.join(__dirname, 'panel.html'))
  diaryWindow.on('closed', () => { diaryWindow = null })
  diaryWindow.webContents.on('did-finish-load', () => {
    sendData(diaryWindow)
  })
}

ipcMain.on('diary:open', (_evt, petId) => openDiaryWindow(petId || currentPetId))

ipcMain.on('diary:close', () => {
  if (diaryWindow && !diaryWindow.isDestroyed()) diaryWindow.close()
})

// 设置提醒：{ at: ms 时间戳, repeat: 'none'|'daily'|'weekly', text }
ipcMain.handle('reminder:set', (_evt, spec) => {
  if (!spec || typeof spec.at !== 'number' || spec.at <= Date.now() + 1000) {
    return { error: '时间无效' }
  }
  const repeat = ['none', 'daily', 'weekly'].includes(spec.repeat) ? spec.repeat : 'none'
  const id = 'r' + (++reminderSeq)
  reminders.set(id, { at: spec.at, repeat, text: String(spec.text || '该办正事啦！') })
  saveReminders()  // P0-5: 持久化
  console.log(`[PetPet] 提醒已设置 #${id} → ${new Date(spec.at).toLocaleString()} [${repeat}] ${reminders.get(id).text}`)
  return { id }
})

// P0-5: 提醒列表（查看/删除入口）
ipcMain.handle('reminder:list', () => {
  return [...reminders.entries()].map(([id, r]) => ({ id, at: r.at, repeat: r.repeat, text: r.text }))
})

ipcMain.handle('reminder:del', (_evt, id) => {
  const existed = reminders.delete(id)
  if (existed) saveReminders()
  return { ok: existed }
})

function fireReminder(id) {
  const r = reminders.get(id)
  if (!r) return
  console.log('[PetPet] 提醒触发 #' + id + ' → ' + r.text)
  // P1-3: 窗口隐藏时横幅不可见 → 发系统通知兜底；窗口可见仍走横幅
  if (mainWindow && !mainWindow.isVisible()) {
    try {
      new Notification({ title: '⏰ 提醒', body: r.text }).show()
    } catch (e) { /* 无通知权限时忽略 */ }
  }
  send('reminder:fire', { id, text: r.text })
  appendActivity(currentPetId || 'redshao', { mood: '提醒', text: `${currentPetName || '宠物'}提醒你：` + r.text })
  if (r.repeat === 'daily') {
    r.at += 24 * 3600 * 1000
  } else if (r.repeat === 'weekly') {
    r.at += 7 * 24 * 3600 * 1000
  } else {
    reminders.delete(id)
  }
  saveReminders()  // P0-5: 重复提醒推进/一次性删除都要落盘
}

// 每秒检查（桌宠常驻，开销可忽略；避免超长 setTimeout 超 2^31-1ms 溢出问题）
setInterval(() => {
  const now = Date.now()
  for (const [id, r] of reminders) {
    if (r.at <= now) fireReminder(id)
  }
}, 1000)

// ---------- 生命周期 ----------
// 截图测试模式：electron . --screenshot=/tmp/x.png [--action=run]
const shotArg = process.argv.find(a => a.startsWith('--screenshot='))
const testAction = process.argv.find(a => a.startsWith('--action='))?.split('=')[1]
// P0-4 验证用：--open-reminder 启动后自动打开提醒面板（验证面板可交互/焦点）
const openReminderArg = process.argv.includes('--open-reminder')

app.whenReady().then(() => {
  createWindow()
  // macOS Dock 图标：示例宠物头像（内嵌 base64，打包后有效；换宠物时替换此图标）
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(nativeImage.createFromDataURL('data:image/png;base64,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'))
    } catch (e) { console.error('[PetPet] Dock 图标设置失败:', e) }
  }

  createTray()

  if (shotArg) {
    // 等页面加载完成后再切动作
    if (testAction) {
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => send('test:action', testAction), 1500)
      })
    }
    // P0-4 验证：自动打开提醒面板（等效 openReminderWithFocus 的效果）
    if (openReminderArg) {
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => openReminderWithFocus(), 1200)
      })
    }
    const out = shotArg.split('=')[1]
    const shots = []
    const capture = async (i) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const img = await mainWindow.webContents.capturePage()
          shots.push(img.toPNG())
        }
      } catch (e) {
        console.error('screenshot error', e)
      }
      if (i >= 2) {
        for (let n = 0; n < shots.length; n++) {
          const base = out.replace(/\.png$/, '')
          fs.writeFileSync(`${base}_${n}.png`, shots[n])
        }
        console.log('SCREENSHOTS_SAVED', out)
        app.quit()
        return
      }
      setTimeout(() => capture(i + 1), 600)
    }
    setTimeout(() => capture(0), 4500)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 桌宠常驻：关窗口不退出，只有托盘退出才退出
})

// PetPet 桌宠查看器 - 渲染引擎（PixiJS v8）
// 功能：精灵表播放、动作切换、拖拽、缩放、气泡、随机行为
// 注意：Electron/CSP 环境下必须使用 unsafe-eval 模块（PixiJS v8 依赖）
import 'pixi.js/unsafe-eval'
import * as PIXI from 'pixi.js'
import { parseReminder } from './reminder'
import { shouldPlay, isOneshot } from './state-priority'
import { effectiveWeight } from './temperament' // V2-A: 气质调制器（2026-08-09）

// ================= 类型 =================
interface PetActionSpec {
  file?: string
  sprite?: string
  frames: number
  fps?: number
  loop?: boolean
  weight?: number
  pingpong?: boolean
  frameWidth?: number
  frameHeight?: number
  scale?: number
  transitions?: Record<string, number>
}

interface PetJson {
  version: number
  id: string
  name: string
  theme?: string
  cellWidth: number
  cellHeight: number
  error?: string
  actions: Record<string, PetActionSpec>
  // V2-A: 身份+气质（2026-08-09，可选，缺省=中性，兼容旧包）
  identity?: {
    species?: string
    appearance?: Record<string, string>
    habits?: Record<string, boolean>
  }
  temperament?: {
    activity?: number
    clinginess?: number
    curiosity?: number
    independence?: number
  }
}

declare global {
  interface Window {
    petAPI: {
      listPets: () => Promise<string[]>
      loadPet: (id: string) => Promise<PetJson>
      getFile: (id: string, rel: string) => Promise<{ dataUrl?: string; error?: string }>
      setWindowSize: (w: number, h: number) => void
      moveWindow: (x: number, y: number) => void
      setIgnoreMouse: (ignore: boolean, forward?: boolean) => void
      getWindowPosition: () => Promise<{ x: number; y: number }>
      onZoom: (cb: (f: number) => void) => void
      onReset: (cb: () => void) => void
      onTestAction: (cb: (name: string) => void) => void
      notifyPetLoaded: (id: string) => void
      notifyAction: (info: { mood: string; text: string }) => void
      onAction: (cb: (name: string) => void) => void
      setReminder: (spec: { at: number; repeat: string; text: string }) => Promise<{ id?: string; error?: string }>
      onReminderFire: (cb: (r: { id: string; text: string }) => void) => void
      appendActivity: (entry: { petId: string; mood: string; text: string }) => void
      openDiary: (petId: string) => void
      onOpenReminder: (cb: () => void) => void
      onVisibility: (cb: (visible: boolean) => void) => void  // P2-5: 隐藏时暂停动画
      showContextMenu: (x: number, y: number) => Promise<void>
      listActivity: (petId: string) => Promise<{ ts: number; mood: string; text: string }[]>
      onPetSwitch: (cb: (id: string) => void) => void
    }
  }
}

// ================= 状态 =================
const app = new PIXI.Application()

let pet: PetJson | null = null
let petId = ''
let sprite: PIXI.AnimatedSprite | null = null
let textures: Record<string, PIXI.Texture[]> = {}
let currentAction = 'idle'
let baseScale = 0.9
// P2-8: 缩放持久化（localStorage，渲染层可用）
try {
  const savedScale = parseFloat(localStorage.getItem('petpet:scale') || '')
  if (savedScale >= 0.5 && savedScale <= 2) baseScale = savedScale
} catch { /* ignore */ }
let pingpongDir = 1
let bubbleTimer: ReturnType<typeof setTimeout> | null = null
let randomTimer: ReturnType<typeof setInterval> | null = null
let transitionTimer: ReturnType<typeof setTimeout> | null = null // 行为链调度（scheduleTransition）
let reminderBarOn = false
// 渲染进程跟踪的窗口状态（初始 = 主进程创建尺寸/位置；本地维护，避免异步竞态漂移）
let curWinW = 320
let curWinH = 320
let curWinX = 0
let curWinY = 0

const WINDOW_W = 320
const WINDOW_H = 320
const BUBBLE_TEXTS = ['汪！', '摸摸我～', '今天也要开心哦！', '饿了…有吃的吗？', '(*^▽^*)']

// ================= 初始化 =================
async function init() {
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    resizeTo: window,
    resolution: Math.min(window.devicePixelRatio || 1, 2)
  })
  document.getElementById('stage')?.replaceWith(app.canvas)
  app.canvas.style.width = '100%'
  app.canvas.style.height = '100%'
  app.canvas.style.display = 'block'
  // P2-3: 可访问性——canvas 角色标注（屏幕阅读器能读出这是桌宠）
  app.canvas.setAttribute('role', 'img')
  app.canvas.setAttribute('aria-label', pet?.name ? `${pet.name}（桌面宠物）` : '桌面宠物')

  // 拖拽移动窗口
  let dragging = false
  let startScreen = { x: 0, y: 0 }
  let winStart = { x: 0, y: 0 }

  app.canvas.addEventListener('pointerdown', async (e) => {
    dragging = true
    startScreen = { x: e.screenX, y: e.screenY }
    winStart = await window.petAPI.getWindowPosition()
    app.canvas.setPointerCapture(e.pointerId)
  })

  // 拖拽移动窗口（同步本地位置跟踪，供缩放中心计算使用）
  app.canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const nx = winStart.x + (e.screenX - startScreen.x)
    const ny = winStart.y + (e.screenY - startScreen.y)
    curWinX = Math.round(nx)
    curWinY = Math.round(ny)
    window.petAPI.moveWindow(Math.round(nx), Math.round(ny))
  })

  app.canvas.addEventListener('pointerup', () => { dragging = false })
  app.canvas.addEventListener('pointercancel', () => { dragging = false })

  // 鼠标穿透（借鉴 bitnp）：透明区穿透桌面，宠物区可交互
  // forward=true 让穿透时仍能收到 mousemove，从而检测鼠标进入宠物区
  // 方案B：面板/提醒条/菜单打开时，其区域也保持可交互
  let lastIgnore: boolean | null = null
  function uiRects() {
    const out: { x: number; y: number; w: number; h: number }[] = []
    for (const el of [
      document.getElementById('reminder-panel'),
      document.getElementById('reminder-bar')
    ]) {
      if (el && !el.classList.contains('hidden')) {
        const r = el.getBoundingClientRect()
        out.push({ x: r.x, y: r.y, w: r.width, h: r.height })
      }
    }
    document.querySelectorAll('.pet-menu').forEach(el => {
      const r = el.getBoundingClientRect()
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height })
    })
    return out
  }
  function updateMouseIgnore(e: PointerEvent) {
    if (dragging) return // 拖拽中强制交互
    const x = e.clientX
    const y = e.clientY
    const onSprite = sprite ? sprite.getBounds().containsPoint(x, y) : false
    const onUI = uiRects().some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
    const shouldIgnore = !(onSprite || onUI)
    if (shouldIgnore !== lastIgnore) {
      lastIgnore = shouldIgnore
      window.petAPI.setIgnoreMouse(shouldIgnore, true)
    }
  }
  // R-3: document capture 监听已覆盖 canvas 上所有移动，删掉 canvas 冗余绑定（避免每次移动走两遍 uiRects 回流）
  document.addEventListener('pointermove', updateMouseIgnore, true)
  // 初始穿透
  setTimeout(() => window.petAPI.setIgnoreMouse(true, true), 300)

  // 单击 = 互动气泡（桌宠灵魂：点宠物有反应；2026-08-06 用户明确：单击不占用为功能入口）
  // 功能入口：托盘爪印（红苕日记/提醒/换肤/动作）+ 右键菜单（触控板双指/辅助点按用户）
  let downPos = { x: 0, y: 0 }
  let lastPointerUp = 0
  app.canvas.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY } })
  app.canvas.addEventListener('pointerup', (e) => {
    lastPointerUp = Date.now()
    if (e.button !== 0) return // 只处理左键（右键走 contextmenu 菜单）
    const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y)
    if (dist < 6) showBubbleText() // 单击 = 互动气泡
  })

  // 右键 → 原生 macOS 菜单（主进程 Menu.popup，自动毛玻璃/定位）
  app.canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    window.petAPI.showContextMenu(e.screenX, e.screenY)
  })

  // 滚轮/触摸表面缩放（Magic Mouse 表面滑动 = 滚动事件，极易误触）
  // 三重防误触：
  // 1. ctrlKey（智能缩放/双指双击）→ 忽略
  // 2. 点击后 250ms 内的滚动 → 忽略
  // 3. 累积式：滚动位移累积到阈值才缩放一档（点击抖动 dY<5、短滑、方向抖动都不会触发）
  let wheelAccum = 0
  let wheelLastTs = 0
  const WHEEL_SCROLL_THRESHOLD = 40
  app.canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return
    if (Date.now() - lastPointerUp < 250) return
    e.preventDefault()
    const now = Date.now()
    if (now - wheelLastTs > 300) wheelAccum = 0 // 滚动停顿后重置累积
    wheelLastTs = now
    wheelAccum += e.deltaY
    while (Math.abs(wheelAccum) >= WHEEL_SCROLL_THRESHOLD) {
      applyZoom(wheelAccum < 0 ? 1.08 : 1 / 1.08)
      wheelAccum -= Math.sign(wheelAccum) * WHEEL_SCROLL_THRESHOLD
    }
  }, { passive: false })

  // 双击 → 恢复默认大小（绝不缩小）
  app.canvas.addEventListener('dblclick', (e) => {
    e.preventDefault()
    resetZoom()
  })

  // 托盘事件
  window.petAPI.onZoom((f) => applyZoom(f))
  window.petAPI.onReset(() => resetZoom())

  // 测试：切换动作
  window.petAPI.onTestAction((name) => requestAction(name, 'menu'))

  // 托盘菜单切换动作（7/31 恢复旧版功能）
  window.petAPI.onAction((name) => requestAction(name, 'menu'))

  // 记录初始窗口位置（缩放中心计算基准）
  try {
    const pos = await window.petAPI.getWindowPosition()
    curWinX = pos.x
    curWinY = pos.y
  } catch (err) {
    console.error('获取窗口位置失败', err)
  }

  // P0-1：发现宠物，而非硬编码 redshao（listPets 终于被调用）
  let pets: string[] = []
  try {
    pets = await window.petAPI.listPets()
  } catch (err) {
    console.error('listPets 失败', err)
  }
  if (pets.length === 0) {
    // P0（2026-08-09）：Windows 用户看不懂 ~ 路径（老坑复发）——按平台显示实际路径
    const petsPath = navigator.userAgent.includes('Windows')
      ? '%USERPROFILE%\\.petpet\\pets'
      : '~/.petpet/pets'
    showFatal(`没有找到宠物包。请创建 ${petsPath}/<宠物名>/pet.json（格式见 docs/08-接口协议.md）`)
    return
  }
  petId = pets[0]
  await loadPet(petId)
  // 多宠：托盘菜单支持切换（主进程已构建切换子菜单）
  window.petAPI.onPetSwitch((id) => {
    loadPet(id).catch(err => showFatal(err.message))
  })
  setupUI()
  startRandomBehavior()
}

// ================= 宠物加载 =================
async function loadPet(id: string) {
  // N-1：先释放上一只宠物的 GPU 资源（P0-1 修复引入的回归：只丢引用不释放显存）
  // 必须在 textures = {} 之前——否则对象被替换后 GC 够不着（Assets 缓存持有强引用）
  if (sprite) { sprite.destroy(); sprite = null }
  for (const frames of Object.values(textures)) {
    for (const f of frames) f.destroy()   // Texture.destroy() 连 TextureSource 一起销毁
  }
  textures = {}
  // 切换宠物/动作时取消挂起的转移调度（防止旧宠物转移定时器在新宠物上触发）
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null }

  petId = id
  const data = await window.petAPI.loadPet(id)
  if (!data || data.error) {
    // P0-2：不再静默失败，抛出给顶层 catch → 可见错误卡片
    const msg = data?.error || `宠物 ${id} 加载失败：pet.json 缺失或无法解析`
    throw new Error(msg)
  }
  pet = data
  // P2-3: 宠物加载后更新 canvas 的 aria-label（init 时 pet 还未加载）
  if (app.canvas) {
    app.canvas.setAttribute('aria-label', `${pet.name}（桌面宠物）`)
  }
  // 主题皮肤：bro=弟弟(蓝绿) / sis=妹妹(暖粉)，跟随 pet.json 的 theme 字段
  document.body.dataset.theme = pet.theme || 'bro'
  // 通知主进程当前宠物（托盘动作菜单用）
  window.petAPI.notifyPetLoaded(id)

  const names = Object.keys(pet.actions)
  // N-2：先加载首个动作 → 立刻有画面，其余后台补（此前 await Promise.all 全部加载完才画第一帧，冷启动秒级空窗）
  await loadAction(names[0])
  playAction(names[0], 'init') // 初始加载：直接播放（不经仲裁，init 语义）
  void Promise.all(names.slice(1).map(loadAction))  // 其余不阻塞首帧
  updateTitle()
}

// 加载单个动作的精灵表 → 切片 → 存入 textures[name]
async function loadAction(name: string) {
  if (!pet) return
  const act = pet.actions[name]
  const rel = act.file || act.sprite
  if (!rel || textures[name]) return
  // N-3：优先 petpet:// 协议短 URL（零 base64、流式读盘、Assets 缓存键稳定）；
  // 协议不可用时回退 dataURL（getFile 保留 IPC 兼容路径）
  const url = `petpet://${petId}/${rel}`
  let tex: PIXI.Texture
  try {
    tex = await PIXI.Assets.load(url)
  } catch (e) {
    console.warn(`动作 ${name} 协议加载失败，回退 IPC: ${e}`)
    const res = await window.petAPI.getFile(petId, rel)
    if (!res.dataUrl) {
      console.warn(`动作 ${name} 精灵表加载失败: ${res.error}`)
      return
    }
    tex = await PIXI.Assets.load(res.dataUrl)
  }
  const cw = act.frameWidth || pet!.cellWidth
  const ch = act.frameHeight || pet!.cellHeight
  const cols = Math.max(1, Math.floor(tex.width / cw))
  const frames: PIXI.Texture[] = []
  for (let i = 0; i < act.frames; i++) {
    const col = i % cols
    frames.push(new PIXI.Texture({
      source: tex.source,
      frame: new PIXI.Rectangle(col * cw, 0, cw, ch)
    }))
  }
  textures[name] = frames
}

function updateTitle() {
  if (pet) document.title = `PetPet - ${pet.name}`
}

// ================= 动作播放 =================
// 动作请求仲裁：所有触发源统一走这里（P0 状态仲裁层）
// - menu/init：用户主动/初始加载 → 直接执行
// - reminder：提醒必须显示 → 直接执行
// - random：随机行为 → 仅在待机时允许（不再打断任何动作）
function requestAction(name: string, source: 'menu' | 'reminder' | 'random' | 'init' | 'transition' = 'menu') {
  if (!pet || !textures[name] || textures[name].length === 0) return
  if (!shouldPlay({ name, source }, currentAction)) return
  playAction(name, source)
}

function playAction(name: string, source: 'menu' | 'reminder' | 'random' | 'init' | 'transition' = 'menu') {
  if (!pet || !textures[name] || textures[name].length === 0) return
  // P1-7: 随机行为不写日记（12s 一条会把 100 条日记 20 分钟冲光）——只有用户主动/提醒才记录
  if (source !== 'random' && name !== 'idle' && name !== currentAction) logActionActivity(name)
  // 动作切换 → 通知主进程同步日记「当前状态」（idle 也用固定文案）
  const actT = ACTIVITY_TEXTS[name]
  window.petAPI.notifyAction(actT
    ? { mood: actT.mood, text: actT.text.replace('{name}', petDisplayName()) }
    : { mood: '待机', text: `${petDisplayName()}安安静静地待着，等你来摸～` })
  const act = pet.actions[name]
  const frames = textures[name]

  if (sprite) {
    sprite.destroy()
    sprite = null
  }

  sprite = new PIXI.AnimatedSprite(frames)
  sprite.anchor.set(0.5)
  sprite.animationSpeed = (act.fps || 4) / 60
  sprite.loop = act.loop !== false
  pingpongDir = 1

  if (act.pingpong) {
    // 往返播放：播完一 cycle 反向
    sprite.on('loop', () => {
      if (!sprite) return
      pingpongDir *= -1
      sprite.animationSpeed = Math.abs(sprite.animationSpeed) * pingpongDir
    })
  }

  app.stage.addChild(sprite)
  currentAction = name
  applyScale()
  sprite.play()
  // 行为链调度：仅自动行为源（random/transition）挂转移定时器——
  // 用户手动/提醒进入的动作不设转移（state-priority 设计意图：手动切换不被自动打断）
  if (source === 'random' || source === 'transition') scheduleTransition(name)
}

// 缩放约束：0.5x ~ 2x（窗口跟随缩放，永远完整显示全身，不裁切）
const ZOOM_MIN = 0.5
const ZOOM_MAX = 2

async function applyScale() {
  if (!sprite) return
  // 8/5 v2：窗口尺寸只随缩放（baseScale）变化，与动作无关 → 切换动作零跳变（修复"切换时窗口闪烁/动作消失"感）
  // 帧尺寸优先取当前动作帧的真实纹理尺寸（Pixi v8 的 FrameObject 无 width/height，需类型收窄）
  const firstTex = sprite.textures[0]
  const fw = (firstTex && 'width' in firstTex ? (firstTex as PIXI.Texture).width : undefined) || pet?.cellWidth || 250
  const fh = (firstTex && 'height' in firstTex ? (firstTex as PIXI.Texture).height : undefined) || pet?.cellHeight || 250
  const fit = Math.min(WINDOW_W / fw, WINDOW_H / fh)  // 固定 320 基准，不随窗口变化
  const act: PetActionSpec = pet?.actions?.[currentAction] || { frames: 0 }
  const actScale = act.scale || 1

  // 窗口 = 初始尺寸 × baseScale（与动作无关）
  const newW = Math.max(60, Math.round(WINDOW_W * baseScale))
  const newH = Math.max(60, Math.round(WINDOW_H * baseScale))
  sprite.scale.set(baseScale * fit * actScale)
  sprite.position.set(newW / 2, newH / 2)

  const newX = Math.round(curWinX + (curWinW - newW) / 2)
  const newY = Math.round(curWinY + (curWinH - newH) / 2)
  window.petAPI.moveWindow(newX, newY)
  window.petAPI.setWindowSize(newW, newH)
  curWinX = newX
  curWinY = newY
  curWinW = newW
  curWinH = newH
}

function applyZoom(factor: number) {
  const prev = baseScale
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, baseScale * factor))
  baseScale = next
  try { localStorage.setItem('petpet:scale', String(next)) } catch { /* ignore */ }  // P2-8
  // P2-9: 到边界给反馈（静默钳制让人困惑：继续滚什么都没发生）
  if (next === prev) {
    showBubbleText(next >= ZOOM_MAX ? '已经是最大啦 🐾' : '已经最小啦 🐾')
  } else {
    applyScale()
  }
}

function resetZoom() {
  baseScale = 0.9
  try { localStorage.setItem('petpet:scale', '0.9') } catch { /* ignore */ }  // P2-8
  applyScale()
}

// ================= 气泡 =================
function showBubbleText(text?: string) {
  const bubble = document.getElementById('bubble')!
  bubble.textContent = text || BUBBLE_TEXTS[Math.floor(Math.random() * BUBBLE_TEXTS.length)]
  bubble.classList.remove('hidden')
  bubble.style.left = '50%'
  bubble.style.top = '8px'
  bubble.style.transform = 'translateX(-50%)'

  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    bubble.classList.add('hidden')
  }, 6000)
}

// ================= 红苕日记（方案B） =================
// 动作 → 心情 + 文案（{name} 运行时替换为宠物名，不再硬编码红苕）
const ACTIVITY_TEXTS: Record<string, { mood: string; text: string }> = {
  sleep:   { mood: '安逸', text: '{name}蜷成一团睡着了，呼噜声轻轻的。' },
  sniff:   { mood: '好奇', text: '{name}凑近嗅了嗅，鼻头湿漉漉的。' },
  wiggle:  { mood: '开心', text: '{name}扭着屁股撒欢，尾巴摇成小风扇。' },
  run:     { mood: '兴奋', text: '{name}嗖地窜了出去，一溜烟就没影了。' },
  knead:   { mood: '满足', text: '{name}踩奶踩得入迷，前爪一按一按的。' },
  belly:   { mood: '惬意', text: '{name}翻出肚皮晒太阳，毫无防备。' },
  poop:    { mood: '心虚', text: '{name}先转着圈圈踩好位置，解决完就撒欢跑开了。' },
  stretch: { mood: '舒坦', text: '{name}伸了个大大的懒腰，爪子张得开花。' }
}

function petDisplayName(): string {
  return pet?.name || '宠物'
}

function logActionActivity(name: string) {
  const t = ACTIVITY_TEXTS[name]
  if (!t) return
  window.petAPI.appendActivity({ petId, mood: t.mood, text: t.text.replace('{name}', petDisplayName()) })
}


// ================= 提醒系统（方案B） =================
function openReminderPanel() {
  document.getElementById('reminder-panel')!.classList.remove('hidden')
  const input = document.getElementById('reminder-input') as HTMLInputElement
  input.value = ''
  input.focus()
}

function closeReminderPanel() {
  document.getElementById('reminder-panel')!.classList.add('hidden')
}

async function submitReminder() {
  const input = document.getElementById('reminder-input') as HTMLInputElement
  const raw = input.value.trim()
  if (!raw) return
  const spec = parseReminder(raw)
  if (!spec) {
    showBubbleText('我听不懂这个时间…试试「一分钟后提醒我喝水」')
    return
  }
  const res = await window.petAPI.setReminder({ at: spec.at, repeat: spec.repeat, text: spec.text })
  if (res && res.error) {
    showBubbleText('这个时间有点奇怪，换个说法试试？')
    return
  }
  closeReminderPanel()
  // P1-2: 回执回显解析结果——"每天 10:30 叫你「吃药」"，用户当场核对，解析 bug 不再隐藏
  const d = new Date(spec.at)
  const p = (n: number) => String(n).padStart(2, '0')
  const when = `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
  const repeatLabel = spec.repeat === 'daily' ? '（每天）' : spec.repeat === 'weekly' ? '（每周）' : ''
  showBubbleText(`好哦，${when}叫你「${spec.text}」${repeatLabel}`)
  window.petAPI.appendActivity({ petId, mood: '答应', text: `${petDisplayName()}答应提醒你：${when} ${spec.text}${repeatLabel}` })
}

function handleReminderFire(r: { id: string; text: string }) {
  reminderBarOn = true
  const bar = document.getElementById('reminder-bar')!
  // P1-4: 多条提醒同时到点不覆盖——已显示的提醒条追加新条目（换行），而非替换
  const existing = document.getElementById('reminder-text')!.textContent
  document.getElementById('reminder-text')!.textContent = existing && existing !== '⏰ '
    ? existing + '\n⏰ ' + r.text
    : '⏰ ' + r.text
  bar.classList.remove('hidden')
  requestAction('wiggle', 'reminder') // 提醒时扭两下，不打扰地刷存在感（reminder 源优先，可打断当前动作）
}

function dismissReminder() {
  reminderBarOn = false
  document.getElementById('reminder-bar')!.classList.add('hidden')
  window.petAPI.appendActivity({ petId, mood: '放心', text: `${petDisplayName()}确认你收到提醒了。` })
}

function openDiary() {
  // 日记面板是独立小窗口（主进程管理），避免在宠物窗口内遮挡宠物
  window.petAPI.openDiary(petId)
}

// P1-5: 删除幽灵换肤（switchTheme 无调用者、无 CSS 消费 data-theme）

function setupUI() {
  const input = document.getElementById('reminder-input') as HTMLInputElement
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitReminder()
    } else if (e.key === 'Escape') {
      closeReminderPanel()
    }
  })
  document.getElementById('reminder-ok')!.addEventListener('click', submitReminder)
  document.getElementById('reminder-cancel')!.addEventListener('click', closeReminderPanel)
  document.getElementById('reminder-done')!.addEventListener('click', dismissReminder)
  window.petAPI.onReminderFire((r) => handleReminderFire(r))
  // 托盘兜底入口：提醒面板（右键手势不可用时）
  window.petAPI.onOpenReminder(() => openReminderPanel())
  // P2-5: 窗口隐藏时暂停动画（省电）——恢复时继续
  window.petAPI.onVisibility((visible) => {
    if (visible) {
      app.ticker.start()
    } else {
      app.ticker.stop()
    }
  })
}

// ================= 随机行为 =================
// P0：随机触发经 requestAction('random') 仲裁——只在待机时触发（守卫已在 shouldPlay），
// 且回 idle 带守卫：仅当“当前仍是本次随机动作”时才回（修复：用户/提醒打断后不再被强制拉回 idle）

// 统一行为链调度（替代原内联 4s 补丁）：
// 按时长 frames/fps 估算（钳制 2–12s）；到点且未被更高优先级动作打断时，
// 有 transitions 则按权重转移（transition 源），否则回 idle（init 源）
function scheduleTransition(name: string) {
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null }
  const act = pet?.actions?.[name]
  if (!act) return
  const durMs = Math.min(12000, Math.max(2000, ((act.frames || 1) / (act.fps || 4)) * 1000))
  transitionTimer = setTimeout(() => {
    transitionTimer = null
    if (!pet || currentAction !== name) return
    const trans = act.transitions
    if (trans && Object.keys(trans).length > 0) {
      // 转移链：按权重选下一个动作（Shimeji NextBehaviorList 思路，docs/11 §2.1）
      const pool = Object.entries(trans).filter(([n, w]) => textures[n] && n !== name && w > 0)
      if (pool.length > 0) {
        const total = pool.reduce((s, [, w]) => s + w, 0)
        let r = Math.random() * total
        for (const [n, w] of pool) {
          r -= w
          if (r <= 0) { requestAction(n, 'transition'); return }
        }
      }
    }
    // 无转移链 → 回 idle（init 源，绕开 random 源互斥守卫）
    requestAction('idle', 'init')
  }, durMs)
}

function startRandomBehavior() {
  if (randomTimer) clearInterval(randomTimer)
  randomTimer = setInterval(() => {
    if (!pet) return
    // 8/5：自动演示只在待机状态触发——用户手动切换动作后锁定，验证/观看不被随机切换打断
    // P3-4: 提醒横幅显示期间也暂停随机行为（提醒是用户关注的焦点，宠物别抢戏）
    if (currentAction !== 'idle' || reminderBarOn) return
    const candidates = Object.entries(pet.actions).filter(([name, act]) => {
      return textures[name] && name !== currentAction && (act.weight ?? 0) > 0
    })
    if (candidates.length === 0) return

    const total = candidates.reduce((s, [n, a]) => s + effectiveWeight(n, a.weight ?? 0, pet?.temperament), 0)
    let r = Math.random() * total
    for (const [name, act] of candidates) {
      r -= effectiveWeight(name, act.weight ?? 0, pet?.temperament)
      if (r <= 0) {
        requestAction(name, 'random')
        break
      }
    }
  }, 12000)
}

// ================= 启动 =================
// P0-2：可见的错误反馈（不透明卡片，替代透明窗口里的静默失败）
function showFatal(msg: string) {
  const bubble = document.getElementById('bubble')!
  bubble.textContent = '⚠️ ' + msg
  bubble.classList.remove('hidden')
  bubble.style.background = 'rgba(255,255,255,0.98)'
  bubble.style.maxWidth = '280px'
  bubble.style.whiteSpace = 'normal'
}

init().catch(err => {
  console.error('PetPet 启动失败', err)
  showFatal(err?.message || '启动失败')
})

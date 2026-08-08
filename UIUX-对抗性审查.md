# UI/UX 对抗性审查 · petpet-playbook

> 审查对象：`viewer/`（Electron + PixiJS 客户端参考实现）+ 其与 `README.md` / `docs/` 的一致性
> 审查方法：源码逐行走查 + 关键路径实测（提醒解析器实跑、CSS 盒模型与对比度计算）
> 审查视角：**对抗性**——假设审查者是一个刚 clone 仓库、想给自己的狗做桌宠的陌生人，而不是作者本人
> 日期：2026-08-07 · 提交基线：`1d49fa3`

---

## 0. 一句话结论

管线（`pipeline/`）是可信的工程；**客户端（`viewer/`）目前是「作者本人的红苕专用版」，不是「参考实现」**——一个按 README 操作的陌生用户，在第一分钟就会看到一个完全空白的透明窗口，且不会收到任何错误提示。

按严重度分布：

| 级别 | 数量 | 含义 |
|------|------|------|
| **P0 阻断** | 5 | 新用户拿不到任何价值，或功能实际不可用 |
| **P1 严重** | 8 | 产生错误结果 / 静默数据丢失 / 承诺的功能不存在 |
| **P2 中等** | 9 | 可用性与可访问性缺陷 |
| **P3 打磨** | 7 | 死代码、抖动、一致性 |
| **文档偏差** | 8 | 文档描述与代码事实不符（含 CI 当前必然失败） |

---

## P0 · 阻断级

### P0-1 · 客户端只会加载名为 `redshao` 的宠物，用户的宠物包永远加载不到

`viewer/src/main.ts:68`

```ts
let petId = 'redshao'
```

`init()`（`main.ts:232`）直接 `loadPet(petId)`。而 `listPets()` 在 preload（`preload.cjs:5`）和主进程（`main.js:143`）都实现了，**渲染层从未调用过一次**——全仓库对 `listPets` 的引用只有类型声明。

**后果**：用户按 README 建了 `~/.petpet/pets/baobao/`，启动后什么都没有。除非他把目录改名成 `redshao`。

**README 与之直接冲突**（`README.md`）：

> `npm run dev # 开发模式：加载 ~/.petpet/pets/<宠物名>/ 下的宠物包`

`<宠物名>` 是个假的占位符。这是整个仓库定位（"给你家宠物做替身"）与实现之间最大的裂口。

**修**：`init()` 里 `const pets = await window.petAPI.listPets()`；0 个 → 走 P0-2 的空状态；1 个 → 直接加载；多个 → 托盘菜单加"切换宠物"子菜单。记住上次选择。

---

### P0-2 · 加载失败是完全静默的：透明窗口 + 零反馈

`viewer/src/main.ts:238-244`

```ts
async function loadPet(id: string) {
  const data = await window.petAPI.loadPet(id)
  if (!data || data.error) {
    console.error('加载宠物失败', data)
    return          // ← 静默返回，init() 不抛，catch 不触发
  }
```

窗口是 `transparent: true, frame: false, hasShadow: false`（`main.js:23-32`），加载失败时舞台上没有任何精灵。用户看到的是：**桌面上什么都没有**，只有一个托盘图标。DevTools 里的 `console.error` 对普通用户不存在。

`init()` 末尾的 `catch` 会往气泡里写"启动失败"（`main.ts:547-552`），但这条路径永远走不到——`loadPet` 吞掉了错误而不是抛出。

**这是首次运行的默认体验**，因为 `~/.petpet/pets/redshao/` 在任何非作者机器上都不存在。

**修**：`loadPet` 失败时 `throw`，让顶层 catch 接管；并区分三种情况给出不同文案 —— 目录不存在（引导去 08-接口协议 建宠物包）/ `pet.json` 解析失败（贴出 JSON 错误行）/ 精灵表缺失（列出缺哪几个动作）。空状态必须是**可见的**（不透明卡片，不能是气泡）。

---

### P0-3 · 全部 UI 文案硬编码"红苕"，共 38 处

```
main.js  src/state-priority.ts  src/main.ts  panel.css  panel.html  panel.js
```

- 日记窗口标题：`panel.html:6,12` → `红苕日记`
- 空状态：`panel.js:39` → `还没有日记，去戳戳红苕吧～`
- 右键菜单标题：`main.js:112` → `{ label: '红苕', enabled: false }`
- 托盘：`main.js:100` → `📖 红苕日记`
- 全部 8 条心情文案：`main.ts:399-408` → `红苕蜷成一团睡着了…`
- 待机兜底：`main.ts:310` → `红苕安安静静地待着，等你来摸～`
- 提醒回执：`main.ts:450` / `main.js:360` → `红苕答应提醒你：…`

`pet.json` 里的 `name` 字段**被读取了但只写进 `document.title`**（`main.ts:287-289`），而窗口是 `frame: false`——标题栏根本不存在，这行代码的效果为零。

**后果**：用户的金毛「包包」在自己的桌宠里全程被叫做「红苕」。对一个卖点是"这是**你家**宠物的替身"的产品，这是定位级的破坏。

**修**：所有文案模板化。`ACTIVITY_TEXTS` 的 value 改成带 `{name}` 占位的模板串，渲染时 `pet.name` 注入；`panel.html` 标题改由 `diary:data` 下发；`main.js` 的菜单 label 用 `currentPetName`。

---

### P0-4 · 提醒面板在窗口里点不动，且从托盘打开时拿不到键盘焦点

两个独立缺陷叠加，结果是**「⏰ 提醒我」这个功能大概率完全用不了**。

**(a) 鼠标穿透状态机漏掉了面板**

`main.ts:151-163`：

```ts
function updateMouseIgnore(e: PointerEvent) { … }
app.canvas.addEventListener('pointermove', updateMouseIgnore)   // ← 只绑在 canvas 上
```

DOM 结构是 `<body>` 下 `canvas` / `#bubble` / `#reminder-panel` / `#reminder-bar` **并列的兄弟节点**（`index.html:10-28`）。指针移到面板上时，事件目标是面板，**不会冒泡到 canvas**，`updateMouseIgnore` 不执行 → `setIgnoreMouseEvents(true)` 保持不变 → 面板整体穿透，点不到。

`uiRects()`（`main.ts:134-150`）确实把面板矩形算进去了，但它只在 canvas 的 pointermove 回调里被调用——用不上。

只有当用户**先把鼠标划过宠物身体**（关掉穿透）**再移到面板**时，面板才是活的。而面板在 `top: 56px`，宠物精灵在窗口正中——从菜单栏点完托盘往下移动鼠标，最自然的轨迹恰好是**直接进面板、不经过宠物**。

**(b) 从托盘打开时不 focus 窗口**

`main.js:101,114` 都只是 `send('open:reminder')`，主进程没有任何 `mainWindow.focus()` / `setIgnoreMouseEvents(false)`。渲染层 `openReminderPanel()`（`main.ts:423-428`）调用 `input.focus()`——**在一个未获焦、且处于点击穿透状态的窗口里**。DOM 焦点给了，但键盘输入去了当时真正获焦的那个 App。

**修**：`open:reminder` 的主进程侧先 `mainWindow.setIgnoreMouseEvents(false)` + `mainWindow.focus()`；`updateMouseIgnore` 改绑 `document`（或 `window`，capture 阶段），而不是 `app.canvas`；面板关闭时再恢复穿透。

---

### P0-5 · 提醒只存在内存里，退出即全部消失，且不告知

`viewer/main.js:228`

```js
const reminders = new Map()   // id -> { at, repeat, text }
```

没有任何持久化。用户设"每天早上10点吃药"，重启电脑后它不存在了。**"每天/每周"重复提醒尤其致命**——这类提醒的语义就是"我设一次就不用管了"，而实现是"关掉 App 就没了"。

而且没有任何地方告诉用户这件事：设置时回的是"好哦，到点我叫你！"（`main.ts:446`）。

同时**没有任何查看/取消提醒的入口**——设完就是黑盒，你不知道有几条待触发、也删不掉一条设错的每周提醒（除非退出 App，而那会把所有提醒一起清空）。

**修**：写到 `~/.petpet/reminders.json`，启动时载入 + 补发/跳过过期项（需要明确策略：错过的一次性提醒是补发还是丢弃）；托盘加"提醒列表"，支持查看与删除。

---

## P1 · 严重

### P1-1 · 正则转义 bug：`5点30分` 被解析成 `5:00`，且提醒正文被污染

`viewer/src/reminder.ts:79`

```ts
const MIN_PAT = '(?:\d{1,2}|半|[一二两三四五六七八九十]{1,3})'
```

这是**单引号普通字符串**，不是正则字面量。JS 里 `'\d'` 的求值结果是 `'d'`（未知转义被吞）。实际拿到的是：

```
(?:d{1,2}|半|[一二两三四五六七八九十]{1,3})
```

分钟的数字分支彻底失效——只剩下"半"和中文数字能匹配。

**实测**（`parseReminder`，基准时间 2026-08-07 09:00）：

| 输入 | 实际触发时间 | 实际提醒正文 |
|------|------|------|
| `明天下午5点30分提醒我开会` | **8/8 17:00**（早 30 分钟） | **`30分提醒我开会`** |
| `每天早上10点30分吃药` | **10:00**（早 30 分钟） | **`30分吃药`** |
| `下午5点半提醒我下班` | 17:30 ✅ | `下班` ✅ |

因为分钟没匹配上，`contentOf()`（`reminder.ts:71-76`）从原文里只抠掉了 `下午5点`，把 `30分` 留在了提醒正文里。

**双重伤害**：时间错了 + 正文被污染，而且**全程没有任何错误提示**——它"成功"了。

**修**：`const MIN_PAT = '(?:\\d{1,2}|半|[一二两三四五六七八九十]{1,3})'`。同时 `tests/` 目前只覆盖 `state-priority`，**`reminder.ts` 零测试**——这个 bug 一条断言就能拦住。建议补一组表驱动用例，含带分钟的每种句式。

---

### P1-2 · 确认回执不回显解析结果，让 P1-1 无法被用户察觉

`main.ts:446`：`showBubbleText('好哦，到点我叫你！')`

自然语言时间解析**必然**会有歧义和误判，唯一的防线是把解析结果回读给用户。现在没有。

**修**：`好哦，明天 17:30 叫你「开会」` / 重复项加上 `（每天）`。这一条同时是 P1-1 的兜底：即使解析器再出 bug，用户当场就能看见。

---

### P1-3 · 提醒到点没有系统通知；窗口隐藏时提醒静默丢失

`main.js:355-359`：`fireReminder` 只做 `send('reminder:fire', …)`，把 UI 责任全交给渲染进程。

托盘有「🐾 显示/隐藏」（`main.js:82`），`toggleWindow()` 直接 `mainWindow.hide()`。**窗口隐藏时提醒照常触发，横幅渲染在一个不可见的窗口里**，用户永远看不到。日记里会留一条"红苕提醒你：…"，但那要主动去翻。

Electron 的 `Notification` 一行就能兜底，且能穿透隐藏状态、进入系统通知中心。

**修**：`fireReminder` 里并发一条 `new Notification({ title, body }).show()`；或者至少在窗口 `!isVisible()` 时强制 `show()`。

---

### P1-4 · 多条提醒同时到点，先到的被静默覆盖

`main.ts:453-459` 的 `handleReminderFire` 把文案写进**唯一一个** `#reminder-text`：

```ts
document.getElementById('reminder-text')!.textContent = '⏰ ' + r.text
```

主进程的扫描循环（`main.js:371-376`）在同一个 tick 里可能触发多条。第二条直接覆盖第一条，第一条**从未被用户看见就消失了**（`reminders.delete(id)` 已执行）。

睡眠唤醒后尤其明显：积压的一次性提醒会在同一秒里全部触发，用户只看到最后一条。

**修**：改成队列/堆叠——多条时显示"还有 N 条"，`知道了` 逐条消费。

---

### P1-5 · 「换肤」是幽灵功能：无 CSS、无入口、纯死代码，但会写盘并回话"换好啦"

三件事同时成立：

1. **没有任何 CSS 消费 `data-theme`**。全仓库 `grep '\[data-theme'` → **0 命中**。`main.ts:248,475,498` 和 `panel.js:32` 设置 `document.body.dataset.theme`，没有一条规则会响应它。
2. **没有入口**。`switchTheme()`（`main.ts:473`）**无调用者**；`setThemeFromMain()`（`main.js:380`）**无调用者**；右键原生菜单（`main.js:111-124`）和托盘菜单（`main.js:79-106`）都没有换肤项。
3. **但副作用是真的**。`ipcMain.on('pet:theme')`（`main.js:396`）会真的把 `theme` 字段写回用户的 `pet.json`，然后渲染层弹气泡：`换好啦，弟弟款！`（`main.ts:477`）。

也就是说：**如果这条路径被触发，App 会改用户的数据文件、告诉用户"换好啦"，而屏幕上什么都不会变。**

`docs/00-设计缘起.md:63` 承认了"换肤入口因 UI 重构暂时隐藏"，但没说 CSS 也不存在。而 `docs/10-架构升级评估.md:41` 的现状表写的是：

> | 主题 | 三套 CSS 变量（bro/sis/orange）**硬编码在 `panel.css`** |

**这一行是错的**。`panel.css` 里只有 `:root` 和 `prefers-color-scheme: dark` 两套变量，与 bro/sis/orange 无关。第 10 篇整篇架构评估建立在这张"现状表"上——一个错误的事实前提。

**修**（三选一，但必须选一个）：① 补齐三套 `[data-theme=...]` 变量 + 恢复菜单入口；② 彻底删除（`switchTheme`、`setThemeFromMain`、`pet:theme` IPC、`THEME_LABELS`、preload 的 `setTheme`/`onThemeSet`），并把 `pet.json` 的 `theme` 字段标为保留；③ 保留数据字段但**禁用写入路径**。无论选哪个，`docs/10:41` 和 `docs/08:54` 都要同步。

---

### P1-6 · 布局在默认窗口尺寸就已临界，缩小后直接裁掉

**盒模型**：`src/style.css` 里**没有全局 `box-sizing` 重置**（`html, body` 规则在 35-46 行，无 `*` 选择器），`.panel`（157 行）也没设 `box-sizing`，因此是默认的 `content-box`：

```
#reminder-panel 实际宽度 = width 250 + padding 16×2 + border 0.5×2 = 283px
```

**窗口宽度**：`WINDOW_W = 320`，默认 `baseScale = 0.9`（`main.ts:72,83`），`applyScale()` 算出 `newW = 320 × 0.9 = 288px`。

| 缩放 | 窗口宽 | 面板 283px | 结果 |
|------|--------|-----------|------|
| 0.9（默认） | 288 | 283 | 左右各余 2.5px —— 临界 |
| 0.8 | 256 | 283 | **裁掉 27px** |
| 0.5（下限） | 160 | 283 | **裁掉 123px，按钮全部不可见** |

高度同理：面板 `top: 56px` + 内容约 182px ≈ 238px；0.5x 时窗口只有 160px 高，**「设置」「取消」按钮在窗口外**。

`#reminder-bar` 是 `max-width: 300px` + padding（`style.css:251-270`），长提醒文案在**默认 288px 窗口下就会溢出**，"知道了"按钮被切边。`#bubble` 的 `max-width: 200px` + padding 13×2 = 226px 实际宽，小缩放下同样溢出。

根因：**所有浮层用 `position: fixed` + 固定 px 尺寸，而它们所在的 BrowserWindow 尺寸是随缩放变化的**（60px ~ 640px）。UI 从不知道自己住在多大的窗口里。

**修**：短期——加 `* { box-sizing: border-box }`，浮层改 `width: min(250px, calc(100% - 16px))`，并给窗口设一个**下限**（宠物可以缩到 0.5x，但窗口不能小于浮层需要的尺寸）。长期——提醒面板/横幅移到**独立 BrowserWindow**（日记面板已经是这么做的，`main.js:293`），彻底摆脱宠物窗口尺寸的约束。

---

### P1-7 · 日记被自动行为刷屏，约 20 分钟就把真实记录全部冲掉

- 随机行为定时器：**每 12 秒**一次（`main.ts:543`）
- 每次非 idle 的动作切换都写一条日记（`main.ts:305` → `logActionActivity`）
- 上限硬切 100 条（`main.js:251`：`if (list.length > 100) list = list.slice(-100)`）

**算术**：12s/条 = 5 条/分钟 = 300 条/小时 → **整个日记每 20 分钟完整轮换一次**。

用户真正想留下的东西——"红苕答应提醒你：接孩子"（`main.ts:450`）、"红苕提醒你：吃药"（`main.js:360`）——会在 20 分钟内被"红苕凑近嗅了嗅，鼻头湿漉漉的。"淹没并挤出。

这不是"心情日记"，是**动画播放日志**。`docs/08-接口协议.md:151` 把这个机制描述为设计意图，但没意识到 12s × 100 条的量纲后果。

顺带：`appendActivity` 每次都是 `readFileSync` 全量读 + `writeFileSync` 全量写（`main.js:240-256`），**主进程每 12 秒同步 IO 一次，永久运行**。

**修**：① 随机动作**不写日记**（或按 N 分钟节流/去重）；② 区分"自动痕迹"与"用户事件"两类，上限分开算，用户事件永不被自动条目挤出；③ 写盘改防抖 + 异步。

---

### P1-8 · 日记窗口不可移动、不可缩放、且置顶于一切

`main.js:312-330`：

```js
diaryWindow = new BrowserWindow({
  width: 300, height: 400,
  frame: false,          // 无标题栏
  resizable: false,      // 不可缩放
  alwaysOnTop: true,
  skipTaskbar: true,
})
diaryWindow.setAlwaysOnTop(true, 'screen-saver')   // 最高层级
```

而 `panel.css` 里 **没有任何 `-webkit-app-region: drag`**（全仓库 0 命中）。

结果：一个 300×400 的无边框窗口，**浮在包括全屏应用在内的所有内容之上，既拖不动也拉不大**，唯一的关闭方式是右上角 22×22 的 ✕（`panel.html:14`），且没有 Esc / Cmd+W（`panel.js` 无任何 keydown 监听）。

定位逻辑（`main.js:305-309`）也只考虑了水平方向：

```js
let x = pos[0] + size[0] + 8
if (x + 300 > work.width) x = Math.max(0, pos[0] - 300 - 8)
y: Math.max(0, pos[1])        // ← 垂直方向没有任何边界检查
```

宠物被拖到屏幕下半部分时，日记窗口下沿（`pos[1] + 400`）直接超出工作区。多显示器场景下 `screen.getPrimaryDisplay()` 也是错的——宠物在副屏时，日记会开在主屏。

**修**：`.head` 加 `-webkit-app-region: drag`（`.close` 加 `no-drag`）；`resizable: true` + 记住尺寸；`alwaysOnTop` 降到 `'floating'`；用 `screen.getDisplayNearestPoint(petPos)` 取显示器，并做上下边界钳制；补 Esc / Cmd+W。

---

## P2 · 可用性与可访问性

### P2-1 · 正文对比度全线低于 WCAG AA 4.5:1

按最有利条件计算（浅色模式 = 纯白桌面壁纸，深色模式 = 纯黑壁纸，即 alpha 叠加的最好情况）：

| 元素 | 前景 | 有效对比度 | 判定 |
|------|------|-----------|------|
| `.time` 日记时间戳（10.5px） | `rgba(60,60,67,.55)` on `.card-bg` | **3.02:1** | ✗ AA |
| `.time` 深色模式 | `rgba(235,235,245,.5)` on `rgba(60,60,62,.7)` | **3.83:1** | ✗ AA |
| `.mood` 心情胶囊（11px 600） | `#007AFF` on `rgba(0,122,255,.12)` | **3.43:1** | ✗ AA |
| `.status` 当前状态行（12.5px） | 同上 | **3.43:1** | ✗ AA |
| `.panel-hint` 提醒语法说明（11px） | `--text-secondary` | **3.02:1** | ✗ AA |

而且这是**上界**——所有背景都是 `backdrop-filter` 叠在**任意桌面壁纸**上（`panel.css:50`、`style.css:63,105,160,261`），用户换一张亮色照片壁纸，实际对比度只会更低，且**不可控**。

`.panel-hint` 尤其要命：它是唯一说明提醒输入语法的文字，是这个功能的说明书，用 11px + 3:1 呈现。

**修**：`--text-secondary` 提到至少 `rgba(60,60,67,0.75)`；`.mood`/`.status` 用更深的蓝（浅色模式 `#0040A0` 级）；给毛玻璃层加一层不透明底色兜底（`background-color` 打底 + `backdrop-filter` 增强，而不是只靠半透明）；正文最小字号提到 12px。

### P2-2 · 深色模式是半成品：一半的值硬编码成浅色

`@media (prefers-color-scheme: dark)` 只覆盖了 `:root` 变量（`style.css:19-33`），但下面这些**写死在规则里，两个模式共用**：

| 位置 | 硬编码值 | 深色模式下的效果 |
|------|---------|-----------------|
| `.btn`（style.css:226） | `background: rgba(255,255,255,0.6)` | 「取消」按钮变成浅灰底 + 近白文字 → **实测 2.16:1，几乎不可读** |
| `.btn` / `.panel` / `#reminder-input` / `#reminder-bar` / `.pet-menu` 的 border | `rgba(0,0,0,0.1~0.12)` | 深色背景上黑色描边 = 完全不可见 |
| `#bubble` border（style.css:65,89） | `rgba(255,255,255,0.35)` | 浅色模式上发白光晕 |
| `#reminder-input:focus`（style.css:205） | `rgba(0,122,255,0.22)` | 焦点环不跟随 `--accent`，深色模式偏色 |

**修**：把这四类值也变量化（`--btn-bg`、`--border`、`--focus-ring`），在 dark 块里给出对应值。`panel.css` 已经定义了 `--border` 变量——`style.css` 没有，应对齐。

### P2-3 · 键盘完全不可用

- 日记窗口：无 Esc、无 Cmd+W，唯一出口是 22×22 的 ✕ 按钮（远低于 24×24 最小点击目标建议）
- `.btn` **没有 `:focus-visible` 样式**（全仓库唯一的焦点样式是 `#reminder-input:focus`）→ Tab 到「设置」「取消」时看不出焦点在哪
- 宠物本体：`<canvas>` 无 `role` / `aria-label`，无任何键盘触发动作的方式
- `#bubble` 无 `aria-live` → 屏幕阅读器永远读不到宠物说的话，**包括错误提示**（"我听不懂这个时间…"）
- 日记列表不是语义列表（`panel.html:17` 是裸 `<div>`），无 `role="list"` / `role="listitem"`

### P2-4 · 日记不能复制，也不能导出

`panel.css:40-41` 全局 `user-select: none`。一个叫"日记"的东西，用户**选不中一个字**。也没有导出/复制按钮、没有清空、没有按天分组。

**修**：`.list` 局部改回 `user-select: text`（拖拽区保持 none）。

### P2-5 · 无 `prefers-reduced-motion`，也无"暂停"

全仓库 0 命中。同时：宠物精灵**持续循环动画**、每 12s 随机切换动作并移动、`.pet-menu` 有 `menuIn` 缩放动画、窗口在缩放时会跳。

而这个对象是 `alwaysOnTop: 'screen-saver'` + `setVisibleOnAllWorkspaces(visibleOnFullScreen: true)`（`main.js:43-44`）——**它盖在全屏视频、演示、游戏之上，在每一个桌面空间里，没有任何退出方式**，除了托盘里那个无状态指示的「显示/隐藏」。

对前庭敏感用户，这是教科书级的触发场景。

**修**：加 `@media (prefers-reduced-motion: reduce)` 降级为静帧 + 关闭随机行为；托盘加「专注模式 / 暂停动画」；检测到全屏应用时自动隐藏（Electron 可监听 `enter-full-screen`）。另外 `backgroundThrottling: false`（`main.js:39`）+ 隐藏后 ticker 不停 → 隐藏状态仍在持续耗电。

### P2-6 · 空状态文案在教用户做一件不生效的事

`panel.js:39`：`还没有日记，去戳戳红苕吧～`

但点击宠物只调用 `showBubbleText()`（`main.ts:176`），**不写任何日记条目**。日记条目只来自"非 idle 的动作切换"（`main.ts:305`）。用户照做，戳一百下，日记依然是空的。

**修**：改成引导到真正有效的动作（"从托盘切换一个动作，或者设个提醒试试～"），或者干脆让点击也记一条。

### P2-7 · 自定义动作在菜单里显示原始英文 key

`main.js:14-17` 的 `ACTION_LABELS` 是硬编码的 8 项，且**漏了 `knead`**（`src/main.ts:508` 的 `actionLabel` 里有，两份表不一致）。

`docs/08-接口协议.md` 允许用户在 `pet.json` 里自定义动作名，但 **`pet.json` 的 action spec 没有 `label` 字段**（`main.ts:10-22`）。用户加一个 `zoomies` 动作，托盘菜单里就显示 `zoomies`。

同样地，`ACTIVITY_TEXTS`（`main.ts:399-408`）也是 8 项硬编码——自定义动作播放时，日记的"当前状态"会**错误地回落到待机文案**"红苕安安静静地待着"（`main.ts:310`），而宠物明明在跑。

**修**：`pet.json` 的 action 增加可选 `label` 与 `diary: { mood, text }`；代码侧的映射表降级为内置默认值。

### P2-8 · 窗口位置与缩放不持久化

退出重开，宠物回到 `width - 380, height - 420`（`main.js:25-26`）、`baseScale = 0.9`。每天都要重新摆一次。

### P2-9 · 缩放交互无反馈

`ZOOM_MIN = 0.5 / ZOOM_MAX = 2`（`main.ts:341-342`），到边界后**静默钳制**——用户继续滚动，什么都不发生，也不知道为什么。无档位提示、无当前倍率显示。

另外双击重置（`main.ts:208`）之前会先触发**两次** `pointerup` → 两次 `showBubbleText()`（`main.ts:172-177`，没有 dblclick 抑制）。

---

## P3 · 死代码与打磨

| # | 问题 | 位置 |
|---|------|------|
| P3-1 | `.pet-menu` 全套样式（56 行）是死代码——菜单已迁到主进程原生 `Menu.popup`，`main.ts:503` 的注释自己说明了 | `style.css:98-154` |
| P3-2 | `actionLabel()` 无调用者 | `main.ts:505` |
| P3-3 | `fmtTime()` 无调用者（panel.js 里那份才是活的） | `main.ts:416` |
| P3-4 | `reminderBarOn` 只写不读——意味着提醒横幅**不会**抑制随机动作，横幅显示期间宠物照常乱切动作 | `main.ts:76,454,462` |
| P3-5 | `ACTION_PRIORITY.remind = 7` 是装饰性的——`remind` 从来不是动作名，提醒实际播的是 `wiggle`，靠 `source === 'reminder'` 直接放行（`state-priority.ts:44`）。优先级表里排最高的那一项从未参与仲裁 | `state-priority.ts:19` |
| P3-6 | `applyScale()` 用两次独立 IPC（`moveWindow` + `setWindowSize`，`main.ts:363-364`）改窗口几何 → 两帧之间窗口位置与尺寸不一致，缩放时可见抖动。应合并为一次 `setBounds` | `main.ts:344-369` |
| P3-7 | 拖拽竞态：`dragging = true` 同步置位，但 `winStart` 要等 `await getWindowPosition()`（`main.ts:110-115`）。中间到达的 `pointermove` 会用**上一次拖拽的** `winStart` 计算位移 → 窗口瞬跳。应在 await 完成后再置 `dragging = true` | `main.ts:110-125` |

**另需实机确认**：右键时 `pointerdown` 会把 `dragging` 置 true（`main.ts:110`，不区分按键），随后原生 `Menu.popup` 接管输入。若 `pointerup` 被原生菜单吞掉，`dragging` 会**卡在 true**，之后不按键移动鼠标也会拖动窗口。`pointercancel` 是否触发取决于平台行为，建议实测；无论如何 `pointerdown` 里应加 `if (e.button !== 0) return`。

**其他**：命中检测用 `sprite.getBounds().containsPoint()`（`main.ts:155`）是矩形包围盒而非 alpha 命中，精灵透明的四角也会挡住鼠标；睡眠唤醒后 daily/weekly 提醒会按每秒一次连补多轮（`main.js:361-364` 每次只 `+= 24h`）。

---

## 文档 / 配置与实现的偏差

| # | 文档或配置说 | 代码事实 |
|---|-------------|---------|
| D-1 | `README.md`：`加载 ~/.petpet/pets/<宠物名>/ 下的宠物包` | 只加载 `redshao`（P0-1） |
| D-2 | `docs/10:41`：三套主题 CSS 变量**硬编码在 `panel.css`** | `panel.css` 无任何 `data-theme` 规则（P1-5）。整篇架构评估的现状表在这一行是错的 |
| D-3 | `docs/03:139-148`：`knead` 已并入 idle，定稿 8 动作 | `main.ts:404` 的 `ACTIVITY_TEXTS` 与 `main.ts:508` 的 `actionLabel` 都还留着 knead |
| D-4 | `package.json`：`"mac": { "icon": "icon_apple_dog.png" }` | **文件不存在**——`viewer/assets/` 里只有 `icon.ico`。macOS 打包会拿不到图标（运行时 `app.dock.setIcon` 用的是内嵌 base64，但 `.app` 在 Finder / Launchpad 里是 Electron 默认图标） |
| D-5 | `.github/workflows/ci.yml`：上传 `viewer/dist/*.exe`，`if-no-files-found: error` | `package.json` 的 `directories.output` 已在 `4c9ab48` 改为 `release`。**exe 现在产在 `viewer/release/`，这一步必然失败** → Windows 安装包产物拿不到 |
| D-6 | `docs/08:2.2`：`weight` 默认值 **10** | 代码是 `act.weight ?? 0` 且 `> 0` 才进候选池（`main.ts:524`）。**用户按文档省略 `weight`，该动作永远不会随机触发** |
| D-7 | `docs/08:2.2`：`fps` 默认值 **5** | 代码是 `act.fps \|\| 4`（`main.ts:321`） |
| D-8 | `docs/08:2.1` 顶层字段表只有 `id`/`name`/`theme`/`actions` | TS 的 `PetJson`（`main.ts:24-33`）还要求 `version`/`cellWidth`/`cellHeight`。若 `frameWidth` 与 `cellWidth` 同时缺失，切片计算得到 `NaN`（`main.ts:264-273`），精灵**静默不可见**，无任何报错 |

D-5 值得单独强调：它直接掐断了"下载安装包试用"这条路径，而这通常是陌生用户对一个桌宠项目的**第一次接触**。

D-6 同样值得注意：这是"照着文档做，结果不对，且没有任何提示"——和 P0-1 / P0-2 属于同一类失败模式。

---

## 修复优先级建议

**第一梯队（不修则客户端对外无意义）**
1. P0-1 + P0-2 + P0-3：宠物发现 / 可见的失败反馈 / 文案去硬编码 —— 这三条是同一件事的三个面："让别人的宠物也能用"
2. D-5：修好 CI 产物路径，让人能下载到安装包

**第二梯队（提醒功能目前不可信）**

3. P1-1（正则转义）+ P1-2（回显解析结果）：一行代码 + 一句文案，收益极高
4. P0-4（面板点不动 / 拿不到焦点）+ P0-5（提醒不持久化）+ P1-3（系统通知兜底）

**第三梯队（体验塌陷点）**

5. P1-6（`box-sizing` + 浮层自适应）：一行全局重置能解决大半
6. P1-7（日记刷屏）：随机动作不写日记，一行判断
7. P1-8（日记窗口可拖可缩）+ P1-5（换肤：补齐或删干净）

**第四梯队（可访问性，建议排进常规迭代）**

8. P2-1 / P2-2（对比度与深色模式）
9. P2-3 / P2-4 / P2-5（键盘、可复制、reduced-motion 与暂停）

---

## 附：审查方法说明

- **提醒解析器**：通过 `tsx` 直接调用 `parseReminder()`，固定 `now = 2026-08-07T09:00`，实跑 6 组输入，P1-1 表格中的时间与正文均为实测输出，非推断。
- **正则转义**：在 Node 中打印 `MIN_PAT` 的求值结果确认 `\d` 被吞（`"(?:d{1,2}|半|…)"`），并实跑正则确认分钟捕获组为 `null`。
- **盒模型与窗口尺寸**：按 CSS 规范的 `content-box` 默认值计算（仓库内无 `box-sizing` 重置，已确认），窗口尺寸取自 `WINDOW_W × baseScale` 的代码常量。
- **对比度**：按 WCAG 2.x 相对亮度公式计算，半透明层按 alpha 合成到**最有利的**底色（浅色模式 = 白，深色模式 = 黑），因此表中数值是实际体验的**上界**。
- **死代码 / 调用关系**：`grep` 全仓库确认无调用者（`switchTheme`、`setThemeFromMain`、`listPets`、`actionLabel`、`fmtTime`、`.pet-menu`）。
- **未实机运行**：本次未启动 Electron 实例。P3 中"右键后 `dragging` 卡死"一项已明确标注为需实机确认；其余结论均可由源码或上述实测直接推出。

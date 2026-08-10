#!/usr/bin/env node
// PetPet scheduleTransition 边界测试（F-004）
//
// 场景：
//   A. 手动打断（menu 源）：random 动作播放中手动切换 idle → 不挂转移定时器 → 无意外转移
//   B. reminder 打断（reminder 源）：提醒触发 wiggle → 无转移定时器 → 无意外转移
//   C. 多宠切换瞬间：random 动作挂起定时器后立即切宠物 → loadPet 清除旧定时器 → 无旧宠物动作残留
//   D. loop 长时：idle 长时间运行无抖动（无 <2s 间隔的异常切换）
//
// 用法（viewer 目录，至少 2 个宠物包）：
//   npx electron scripts/boundary-test.cjs
// 输出：控制台 PASS/FAIL 摘要 + /tmp/petpet-boundary-<时间戳>.json
//
// 动作识别：事件流 pet:action:notify 只有 {mood,text}（日记文案），按文案关键词映射动作名
'use strict'
process.env.PETPET_MEMTEST = '1'
const path = require('path')
const fs = require('fs')
const os = require('os')
require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow, ipcMain } = require('electron')

function parseArgs() {
  const a = process.argv.slice(1)
  const i = a.indexOf('--pets')
  return i >= 0 ? a[i + 1].split(',') : null
}

const events = []
ipcMain.on('pet:action:notify', (_e, info) => events.push({ t: Date.now(), ...info }))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 文案关键词 → 动作名（内置 ACTIVITY_TEXTS 稳定；pet.json diary 覆盖后按实际文案微调）
function actionOf(info) {
  const t = (info.text || '') + (info.mood || '')
  if (t.includes('睡')) return 'sleep'
  if (t.includes('懒腰')) return 'stretch'
  if (t.includes('扭')) return 'wiggle'
  if (t.includes('待机')) return 'idle'
  if (t.includes('嗅')) return 'sniff'
  if (t.includes('跑')) return 'run'
  if (t.includes('肚皮')) return 'belly'
  if (t.includes('粑粑')) return 'poop'
  return 'unknown'
}

function discoverPets() {
  const root = path.join(os.homedir(), '.petpet', 'pets')
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'pet.json')))
      .map(d => d.name)
  } catch { return [] }
}

const RANDOM_ACTIONS = ['sleep', 'stretch', 'wiggle', 'run', 'sniff', 'belly', 'poop']
const isRandomAction = e => RANDOM_ACTIONS.includes(actionOf(e))

// 宠物包是否含指定动作（读 pet.json）
function petHasAction(petId, action) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.petpet', 'pets', petId, 'pet.json'), 'utf-8'))
    return !!(p.actions && p.actions[action])
  } catch { return false }
}

async function run() {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.error('NO_WINDOW'); process.exit(1) }
  const pets = parseArgs() || discoverPets()
  if (pets.length < 2) { console.error('需要 ≥2 个宠物包（--pets id1,id2 或 ~/.petpet/pets 下准备）'); app.exit(1); return }
  const results = []

  // B 场景需要 wiggle 动作：主宠物优先选含 wiggle 的（提醒播 wiggle），切换目标取另一个
  const mainPet = pets.find(p => petHasAction(p, 'wiggle')) || pets[0]
  const otherPet = pets.find(p => p !== mainPet)
  // 无条件切换到 mainPet（幂等）：当前宠物由渲染层启动顺序决定，不能假设 pets[0]
  win.webContents.send('pet:switch', mainPet)
  await sleep(1500)
  console.log(`主宠物: ${mainPet}（含 wiggle=${petHasAction(mainPet, 'wiggle')}），切换目标: ${otherPet || '无'}`)

  // A. 手动打断（menu 源不挂转移定时器）：手动切 sleep，等 4.5s（>sleep 一轮 2.4s）
  //    若 menu 源误挂 timer，sleep 播完会按 transitions 转移 → FAIL
  //    确定性设计：menu 切换后 currentAction=sleep，randomTimer 守卫（非 idle 不触发）排除干扰
  console.log('A. 手动打断测试…')
  win.webContents.send('pet:action', 'sleep')
  const tA = Date.now()
  await sleep(4500)
  const strayA = events.filter(e => e.t > tA + 300 && isRandomAction(e))
  results.push(['A 手动打断', strayA.length === 0 ? 'PASS' : 'FAIL', `手动切 sleep 后 4.5s 内意外转移 ${strayA.length} 次（menu 源不应挂转移定时器）`])

  // B. reminder 打断
  console.log('B. reminder 打断测试…')
  if (!petHasAction(mainPet, 'wiggle')) {
    results.push(['B reminder 打断', 'SKIP', `主宠物 ${mainPet} 无 wiggle 动作（提醒播 wiggle 的前提缺失）`])
  } else {
    win.webContents.send('reminder:fire', { id: 'boundary-test', text: '边界测试提醒' })
    await sleep(1500)
    const wiggleSeen = events.filter(e => actionOf(e) === 'wiggle').length > 0
    const tWiggle = events.filter(e => actionOf(e) === 'wiggle').pop()?.t || Date.now()
    await sleep(4000)
    const strayB = events.filter(e => e.t > tWiggle + 500 && ['sleep', 'stretch'].includes(actionOf(e)))
    results.push(['B reminder 打断', (wiggleSeen && strayB.length === 0) ? 'PASS' : 'FAIL', `wiggle 出现=${wiggleSeen}，之后 4s 意外转移 ${strayB.length} 次`])
  }

  // C. 多宠切换瞬间（需 ≥2 宠物）
  if (otherPet) {
    console.log('C. 多宠切换瞬间测试…')
    win.webContents.send('pet:action', 'idle') // 先回 idle（B 场景后停在 wiggle，random 守卫非 idle 不触发）
    await sleep(1200)
    const tC = Date.now()
    // 等一次 random 动作出现，随后 500ms 内切宠物
    let switched = false
    for (let i = 0; i < 60; i++) { // 30s 窗口，覆盖 ≥2 个 random 周期（12s）
      if (events.some(e => e.t > tC && isRandomAction(e))) {
        win.webContents.send('pet:switch', otherPet)
        switched = true
        break
      }
      await sleep(500)
    }
    if (!switched) {
      results.push(['C 多宠切换瞬间', 'SKIP', '等待随机动作超时'])
    } else {
      const tSwitch = Date.now()
      await sleep(5000)
      // 切换后应只有 init idle；出现任意非 idle（旧宠物转移残留）即失败
      const strayC = events.filter(e => e.t > tSwitch && isRandomAction(e))
      results.push(['C 多宠切换瞬间', strayC.length === 0 ? 'PASS' : 'FAIL', `切换后 5s 旧宠物动作残留 ${strayC.length} 次`])
    }
  } else {
    results.push(['C 多宠切换瞬间', 'SKIP', '需要 ≥2 个宠物包'])
  }

  // D. loop 长时无抖动：idle 播放 20s，正常 random（12s 周期）允许出现，
  //    但不得有 <1.8s 的快速来回（转移计时器钳制下限 2s，真实抖动会低于此）
  console.log('D. loop 长时稳定性（20s idle 观察）…')
  const tD = Date.now()
  const dCountBefore = events.length
  win.webContents.send('pet:action', 'idle')
  await sleep(20000)
  const dEvents = events.slice(dCountBefore).map((e, i, arr) => ({ a: actionOf(e), t: e.t, gap: i > 0 ? e.t - arr[i - 1].t : -1 }))
  const rapid = dEvents.filter(e => e.gap > 0 && e.gap < 1800)
  results.push(['D loop 长时', rapid.length === 0 ? 'PASS' : 'FAIL', `20s 内快速抖动 ${rapid.length} 次（<1.8s 间隔）`])

  // 汇总
  const out = `/tmp/petpet-boundary-${Date.now()}.json`
  fs.writeFileSync(out, JSON.stringify({ results, events }))
  console.log('\n==== 边界测试汇总 ====')
  let allPass = true
  for (const [name, status, detail] of results) {
    console.log(`  ${status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️' : '❌'} ${name}: ${status} — ${detail}`)
    if (status === 'FAIL') allPass = false
  }
  console.log(allPass ? '\n✅ 全部通过' : '\n❌ 存在失败项')
  console.log('详情 →', out)
  app.exit(allPass ? 0 : 1) // FAIL 必须非零退出，否则 CI 假绿（workflow 只看 exit code）
}

app.whenReady().then(() => setTimeout(run, 6000))

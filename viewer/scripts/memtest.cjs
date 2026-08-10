#!/usr/bin/env node
// PetPet 纹理泄漏压测：多宠切换 N 次，采样渲染进程 / GPU 进程 / GPU 驱动内存（ioreg）
//
// 用法（viewer 目录）：
//   npx electron scripts/memtest.cjs [--switches 100] [--interval 250] [--pets id1,id2]
// 默认：自动取 ~/.petpet/pets 下前 2 个有效宠物包；不足 2 个时退出并提示
// 输出：/tmp/petpet-memtest-<时间戳>.json + 控制台平台期分析
//
// 判定：前 ~25 次为缓存建立期，之后应进入平台期；
//       渲染进程 workingSet 后半 vs 前半显著增长（>50MB）→ 疑似泄漏
'use strict'
process.env.PETPET_MEMTEST = '1'
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
require(path.join(__dirname, '..', 'main.js'))
const { app, BrowserWindow } = require('electron')

function parseArgs() {
  const a = process.argv.slice(1)
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d }
  return {
    switches: parseInt(get('--switches', '100'), 10),
    interval: parseInt(get('--interval', '250'), 10),
    pets: get('--pets', '') ? get('--pets', '').split(',') : null,
  }
}

function discoverPets() {
  const root = path.join(os.homedir(), '.petpet', 'pets')
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'pet.json')))
      .map(d => d.name)
  } catch { return [] }
}

// 统一内存架构（Apple Silicon）下 GPU 驱动侧内存 = 最接近「显存」的可观测读数
function gpuMem() {
  try {
    const out = execFileSync('ioreg', ['-l'], { timeout: 8000, maxBuffer: 64 * 1024 * 1024 }).toString()
    const m = out.match(/"In use system memory"=(\d+)/)
    const a = out.match(/"Alloc system memory"=(\d+)/)
    return {
      inUseMB: m ? Math.round(parseInt(m[1]) / 1048576) : -1,
      allocMB: a ? Math.round(parseInt(a[1]) / 1048576) : -1,
    }
  } catch { return { inUseMB: -1, allocMB: -1 } }
}

const opts = parseArgs()
const pets = opts.pets || discoverPets()
if (pets.length < 2) {
  console.error(`❌ 需要至少 2 个宠物包才能测切换（当前 ${pets.length} 个）。\n   请先准备 ~/.petpet/pets/ 下的宠物包，或用 --pets id1,id2 指定。`)
  process.exit(1)
}
console.log(`压测宠物: ${pets.slice(0, 2).join(' ↔ ')}（${opts.switches} 次切换，间隔 ${opts.interval}ms）`)

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) { console.error('NO_WINDOW'); app.exit(1); return }
    const ids = pets.slice(0, 2)
    const samples = []
    for (let i = 0; i < opts.switches; i++) {
      const id = ids[i % 2]
      win.webContents.send('pet:switch', id)
      await new Promise(r => setTimeout(r, opts.interval))
      let wsMB = -1, gpuMB = -1
      try {
        const pid = win.webContents.getOSProcessId()
        const all = app.getAppMetrics()
        const m = all.find(x => x.pid === pid)
        const gpu = all.find(x => x.type === 'GPU')
        wsMB = m ? Math.round(m.memory.workingSetSize / 1024) : -1
        gpuMB = gpu && gpu.memory ? Math.round(gpu.memory.workingSetSize / 1024) : -1
      } catch { /* 采样失败保留 -1 */ }
      let title = ''
      if (i % 10 === 0) { try { title = await win.webContents.executeJavaScript('document.title') } catch { /* 忽略 */ } }
      const g = i % 5 === 0 ? gpuMem() : null
      samples.push({ i, id, wsMB, gpuMB, ...(g || {}) , title })
    }
    const out = `/tmp/petpet-memtest-${Date.now()}.json`
    fs.writeFileSync(out, JSON.stringify(samples))
    // 摘要：平台期分析
    const ws = samples.map(s => s.wsMB).filter(v => v > 0)
    const half = Math.floor(ws.length / 2)
    const first = ws.slice(0, half), last = ws.slice(half)
    const avg = a => Math.round(a.reduce((s, v) => s + v, 0) / a.length)
    const delta = avg(last) - avg(first)
    console.log('MEMTEST_DONE →', out)
    console.log(`渲染进程 workingSet(MB): 首=${ws[0]} 末=${ws[ws.length - 1]} 峰=${Math.max(...ws)}`)
    console.log(`后半(${half}个)均值 ${avg(last)} vs 前半 ${avg(first)} → Δ${delta}MB ${delta > 50 ? '⚠️ 疑似泄漏' : '✅ 平台期'}`)
    app.quit()
  }, 6000)
})

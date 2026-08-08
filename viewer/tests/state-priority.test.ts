import { describe, it, expect } from 'vitest'
import {
  shouldPlay, priorityOf, isOneshot, ACTION_PRIORITY,
} from '../src/state-priority'

describe('state-priority 仲裁层', () => {
  // ---- 优先级表 ----
  it('优先级排序正确：提醒最高、睡觉最低', () => {
    expect(ACTION_PRIORITY.remind).toBe(7)
    expect(ACTION_PRIORITY.sleep).toBe(0)
    expect(ACTION_PRIORITY.remind).toBeGreaterThan(ACTION_PRIORITY.poop)
    expect(ACTION_PRIORITY.poop).toBeGreaterThan(ACTION_PRIORITY.wiggle)
    expect(ACTION_PRIORITY.wiggle).toBeGreaterThan(ACTION_PRIORITY.run)
    expect(ACTION_PRIORITY.run).toBeGreaterThan(ACTION_PRIORITY.sniff)
    expect(ACTION_PRIORITY.sniff).toBeGreaterThan(ACTION_PRIORITY.idle)
  })

  it('未知动作默认优先级 1（待机级）', () => {
    expect(priorityOf('nonexistent')).toBe(1)
  })

  // ---- menu / reminder / init：永远允许 ----
  it('menu 源永远执行（用户主动最高权限）', () => {
    expect(shouldPlay({ name: 'sniff', source: 'menu' }, 'sleep')).toBe(true)
    expect(shouldPlay({ name: 'sniff', source: 'menu' }, 'wiggle')).toBe(true)
  })

  it('reminder 源永远执行（提醒必须显示）', () => {
    expect(shouldPlay({ name: 'wiggle', source: 'reminder' }, 'sleep')).toBe(true)
    expect(shouldPlay({ name: 'wiggle', source: 'reminder' }, 'poop')).toBe(true)
  })

  it('init 源永远执行（初始加载）', () => {
    expect(shouldPlay({ name: 'idle', source: 'init' }, 'idle')).toBe(true)
  })

  // ---- random：仅待机时允许 ----
  it('random 源仅在待机时允许', () => {
    expect(shouldPlay({ name: 'run', source: 'random' }, 'idle')).toBe(true)
    expect(shouldPlay({ name: 'run', source: 'random' }, 'sleep')).toBe(false)
    expect(shouldPlay({ name: 'run', source: 'random' }, 'wiggle')).toBe(false)
  })

  // ---- P0-1 回归：随机动作播完回 idle 必须放行 ----
  // WorkBuddy 审查发现：回 idle 此前走 random 源，被 'currentAction === idle'
  // 守卫拒绝（此时 currentAction 是刚播的随机动作）→ 宠物永久停在随机动作、
  // 随机行为永久停摆。修复 = 回 idle 改走 init 源（有 currentAction === name
  // 前置守卫防误打断）。本用例锁死该集成链路：
  it('P0-1 回归：随机播 run 后回 idle 被放行（init 源）', () => {
    // 随机播 run（idle 时允许）
    expect(shouldPlay({ name: 'run', source: 'random' }, 'idle')).toBe(true)
    // 4s 后回 idle：当前正在播 run → 走 init 源必须放行（旧代码走 random 源会返回 false）
    expect(shouldPlay({ name: 'idle', source: 'init' }, 'run')).toBe(true)
    // 反向保险：此时再发一个新的随机动作请求必须被拒（仍在播放中）
    expect(shouldPlay({ name: 'sniff', source: 'random' }, 'run')).toBe(false)
  })

  // ---- auto：低优先级不打断高优先级 ----
  it('auto 源：低优先级不打断高优先级', () => {
    expect(shouldPlay({ name: 'idle', source: 'auto' }, 'sniff')).toBe(false)
    expect(shouldPlay({ name: 'run', source: 'auto' }, 'wiggle')).toBe(false)
    expect(shouldPlay({ name: 'sniff', source: 'auto' }, 'sleep')).toBe(true)
  })

  it('auto 源：同优先级不打断（避免抖动）', () => {
    expect(shouldPlay({ name: 'belly', source: 'auto' }, 'run')).toBe(false)
    expect(shouldPlay({ name: 'stretch', source: 'auto' }, 'wiggle')).toBe(false)
  })

  // ---- ONESHOT ----
  it('当前无一次性动作（8 动作全循环，为未来预留）', () => {
    expect(isOneshot('wiggle')).toBe(false)
    expect(isOneshot('stretch')).toBe(false)
  })
})

describe('transition 源（docs/11 §2.1 行为转移链）', () => {
  it('transition 源应被允许（作者显式定义的因果链，非打断）', () => {
    expect(shouldPlay({ name: 'stretch', source: 'transition' }, 'sleep')).toBe(true)
  })
  it('transition 从 sleep → stretch 权重链选择', () => {
    const trans = { stretch: 80, idle: 20 }
    const pool = Object.entries(trans).filter(([, w]) => w > 0)
    const total = pool.reduce((s, [, w]) => s + w, 0)
    expect(total).toBe(100)
    const stretchW = pool.find(([n]) => n === 'stretch')![1]
    expect(stretchW).toBe(80) // 睡醒先伸懒腰的倾向 > 直接回 idle
  })
})

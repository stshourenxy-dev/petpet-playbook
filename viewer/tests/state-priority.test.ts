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

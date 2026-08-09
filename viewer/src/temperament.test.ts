// V2-A temperament 调制器单测
import { describe, it, expect } from 'vitest'
import { temperamentFactor, effectiveWeight } from './temperament'

describe('temperamentFactor', () => {
  it('缺省（无 temperament）= 中性 1', () => {
    expect(temperamentFactor('wiggle', undefined)).toBe(1)
    expect(temperamentFactor('wiggle', null)).toBe(1)
    expect(temperamentFactor('run', {})).toBe(1) // 空对象=中性
  })

  it('中性值（全 0.5）= 1，向后兼容', () => {
    const t = { activity: 0.5, clinginess: 0.5, curiosity: 0.5, independence: 0.5 }
    for (const a of ['wiggle', 'run', 'sniff', 'sleep', 'idle']) {
      expect(temperamentFactor(a, t)).toBe(1)
    }
  })

  it('clinginess 高 → wiggle/belly 上调', () => {
    const t = { clinginess: 1 }
    expect(temperamentFactor('wiggle', t)).toBeGreaterThan(1)
    expect(temperamentFactor('belly', t)).toBeGreaterThan(1)
  })

  it('activity 高 → run 上调', () => {
    expect(temperamentFactor('run', { activity: 1 })).toBeGreaterThan(1)
  })

  it('curiosity 高 → sniff 上调', () => {
    expect(temperamentFactor('sniff', { curiosity: 1 })).toBeGreaterThan(1)
  })

  it('极端值钳制在 [0.7, 1.3]', () => {
    const t = { activity: 1, clinginess: 1, curiosity: 1, independence: 1 }
    for (const a of ['wiggle', 'run', 'sniff', 'sleep']) {
      const f = temperamentFactor(a, t)
      expect(f).toBeLessThanOrEqual(1.3)
      expect(f).toBeGreaterThanOrEqual(0.7)
    }
  })

  it('反向极端（全 0）下调但钳制', () => {
    const t = { activity: 0, clinginess: 0, curiosity: 0, independence: 0 }
    for (const a of ['wiggle', 'run', 'sniff', 'sleep']) {
      const f = temperamentFactor(a, t)
      expect(f).toBeLessThanOrEqual(1.3)
      expect(f).toBeGreaterThanOrEqual(0.7)
    }
    expect(temperamentFactor('run', { activity: 0 })).toBeLessThan(1)
  })
})

describe('effectiveWeight', () => {
  it('零权重不被调制激活', () => {
    expect(effectiveWeight('run', 0, { activity: 1 })).toBe(0)
  })

  it('调制后权重 = base × factor', () => {
    const t = { activity: 1 } // run 系数 = 1 + 0.5*0.6 = 1.3
    expect(effectiveWeight('run', 100, t)).toBe(130)
  })

  it('无 temperament = base 不变', () => {
    expect(effectiveWeight('wiggle', 15, undefined)).toBe(15)
  })
})

import { describe, it, expect } from 'vitest'
import { parseReminder } from '../src/reminder'

// P1-1 回归测试：分钟解析（历史 bug：MIN_PAT 单引号字符串里 \d 被吞成 d，
// 导致"5点30分"解析成 5:00 且正文被污染）
const NOW = new Date('2026-08-07T09:00:00+08:00').getTime()

function fmt(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

describe('parseReminder 分钟解析（P1-1 回归）', () => {
  it('阿拉伯数字分钟：明天下午5点30分 → 17:30', () => {
    const r = parseReminder('明天下午5点30分提醒我开会', NOW)
    expect(r).not.toBeNull()
    expect(fmt(r!.at)).toBe('8/8 17:30')
    expect(r!.text).toBe('开会') // 正文不被"30分"污染
  })

  it('阿拉伯数字分钟：每天早上10点30分吃药 → 10:30 daily', () => {
    const r = parseReminder('每天早上10点30分吃药', NOW)
    expect(r).not.toBeNull()
    expect(fmt(r!.at)).toBe('8/7 10:30')
    expect(r!.repeat).toBe('daily')
    expect(r!.text).toBe('吃药')
  })

  it('中文"半"：下午5点半 → 17:30', () => {
    const r = parseReminder('下午5点半提醒我下班', NOW)
    expect(r).not.toBeNull()
    expect(fmt(r!.at)).toBe('8/7 17:30')
    expect(r!.text).toBe('下班')
  })

  it('中文数字分钟：下午三点十分 → 15:10', () => {
    const r = parseReminder('下午三点十分开会', NOW)
    expect(r).not.toBeNull()
    expect(fmt(r!.at)).toBe('8/7 15:10')
    expect(r!.text).toBe('开会')
  })

  it('无分钟：下午5点 → 17:00', () => {
    const r = parseReminder('下午5点开会', NOW)
    expect(r).not.toBeNull()
    expect(fmt(r!.at)).toBe('8/7 17:00')
  })

  it('相对时间：10分钟后 → +10min', () => {
    const r = parseReminder('10分钟后提醒我喝水', NOW)
    expect(r).not.toBeNull()
    expect(r!.at - NOW).toBe(10 * 60000)
    expect(r!.text).toBe('喝水')
  })
})

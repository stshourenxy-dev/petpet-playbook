// 提醒时间解析（纯函数，可单测）
// 支持：
//   X秒后 / X分钟后 / X小时后          → 相对时间（含中文数字：一分钟后、半小时后）
//   今天/明天 下午5点                  → 绝对时刻（今天已过顺延一天；明天固定+1天）
//   下午5点 / 5点                      → 今天该时刻（已过顺延）
//   每天早上10点                       → 每天重复
//   每周五下午5点                      → 每周重复
// 返回 { at: 下次触发绝对时间戳(ms), repeat: 'none'|'daily'|'weekly', text: 提醒内容 }

export interface ReminderSpec {
  at: number
  repeat: 'none' | 'daily' | 'weekly'
  text: string
}

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5
}

const WEEK_CN: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0
}

// 数字解析：阿拉伯 / 中文（一二三…、十二、二十五、半）
function numOf(s: string): number {
  if (/^\d+$/.test(s)) return +s
  if (s === '半') return 0.5
  if (CN_NUM[s] !== undefined) return CN_NUM[s]
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/)
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0)
  return NaN
}

// 时段 → 小时修正（下午/晚上 12 点制转 24 点制；晚上12点返回 24 表示次日0点）
function hourOf(period: string | undefined, h: number): number {
  if (!period) return h
  if (period === '下午' || period === '晚上' || period === '半夜') {
    if (h === 12) return period === '下午' ? 12 : 24 // 下午12点=12点；晚上/半夜12点=次日0点
    if (h < 12) return h + 12
    return h
  }
  if (period === '中午') return 12
  return h // 凌晨/早上/上午
}

function dayStart(now: number): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

function dailyAt(now: number, h: number, min: number): number {
  const d = dayStart(now)
  d.setHours(h, min, 0, 0)
  let at = d.getTime()
  if (at <= now) at += 86400000 // 今天该时刻已过 → 明天
  return at
}

function nextWeekly(now: number, dow: number, h: number, min: number): number {
  const d = dayStart(now)
  let diff = (dow - d.getDay() + 7) % 7
  d.setHours(h, min, 0, 0)
  let at = d.getTime() + diff * 86400000
  if (at <= now) at += 7 * 86400000 // 本周该时刻已过 → 下周
  return at
}

// 抠掉时间片段，剩余为提醒内容；清掉"提醒我/叫我"类前缀
function contentOf(input: string, timePart: string): string {
  let rest = input.replace(timePart, '').trim()
  rest = rest.replace(/^(请)?(?:提醒我?|叫我|喊我|让我记住)[:：]?\s*/, '')
  rest = rest.replace(/^[，,。.！!？?\s]+|[，,。.！!？?\s]+$/g, '')
  return rest || '该办正事啦！'
}

const NUM_PAT = '[0-9一二两三四五六七八九十半]+'
const MIN_PAT = '(?:\d{1,2}|半|[一二两三四五六七八九十]{1,3})'

// 分钟解析：半=30，其余走数字解析
function minOf(s: string | undefined): number {
  if (!s) return 0
  if (s === '半') return 30
  const n = numOf(s)
  return Number.isNaN(n) ? 0 : n
}

export function parseReminder(input: string, now = Date.now()): ReminderSpec | null {
  const text0 = input.trim()
  if (!text0) return null

  // 1. 相对时间（优先级最高，避免"每分钟"类误判）
  let m = text0.match(new RegExp(`(${NUM_PAT})\\s*秒后`))
  if (m) {
    const n = numOf(m[1])
    if (!Number.isNaN(n)) return { at: now + n * 1000, repeat: 'none', text: contentOf(text0, m[0]) }
  }
  m = text0.match(new RegExp(`(${NUM_PAT})\\s*分钟(?:后|之后|以后)`))
  if (m) {
    const n = numOf(m[1])
    if (!Number.isNaN(n)) return { at: now + n * 60000, repeat: 'none', text: contentOf(text0, m[0]) }
  }
  m = text0.match(new RegExp(`(${NUM_PAT})\\s*(?:小时|个钟)(?:后|之后|以后)`))
  if (m) {
    const n = numOf(m[1])
    if (!Number.isNaN(n)) return { at: now + n * 3600000, repeat: 'none', text: contentOf(text0, m[0]) }
  }

  // 2. 每周
  m = text0.match(new RegExp(`每周([一二三四五六日天])\\s*(凌晨|早上|上午|中午|下午|晚上|半夜)?\\s*(${NUM_PAT})\\s*[点时:：]\\s*(${MIN_PAT})?分?`))
  if (m) {
    const dow = WEEK_CN[m[1]]
    const h = hourOf(m[2], numOf(m[3]))
    const min = minOf(m[4])
    if (!Number.isNaN(h)) return { at: nextWeekly(now, dow, h, min), repeat: 'weekly', text: contentOf(text0, m[0]) }
  }

  // 3. 每天
  m = text0.match(new RegExp(`每天\\s*(凌晨|早上|上午|中午|下午|晚上|半夜)?\\s*(${NUM_PAT})\\s*[点时:：]\\s*(${MIN_PAT})?分?`))
  if (m) {
    const h = hourOf(m[1], numOf(m[2]))
    const min = minOf(m[3])
    if (!Number.isNaN(h)) return { at: dailyAt(now, h, min), repeat: 'daily', text: contentOf(text0, m[0]) }
  }

  // 4a. 绝对时刻（今天/明天 前缀）
  m = text0.match(new RegExp(`(今天|明天)\\s*(凌晨|早上|上午|中午|下午|晚上|半夜)?\\s*(${NUM_PAT})\\s*[点时:：]\\s*(${MIN_PAT})?分?`))
  if (m) {
    const dayWord = m[1]
    let h = hourOf(m[2], numOf(m[3]))
    const min = minOf(m[4])
    if (!Number.isNaN(h)) {
      let dayOffset = 0
      if (h >= 24) { h -= 24; dayOffset += 1 } // 晚上12点 → 次日0点
      if (dayWord === '明天') dayOffset += 1
      const d = dayStart(now)
      d.setHours(h, min, 0, 0)
      let at = d.getTime() + dayOffset * 86400000
      if (dayWord !== '明天' && at <= now) at += 86400000 // 今天已过 → 顺延
      return { at, repeat: 'none', text: contentOf(text0, m[0]) }
    }
  }

  // 4b. 绝对时刻（裸时段词 / 裸时刻）
  m = text0.match(new RegExp(`(凌晨|早上|上午|中午|下午|晚上|半夜)?\\s*(${NUM_PAT})\\s*[点时:：]\\s*(${MIN_PAT})?分?`))
  if (m) {
    let h = hourOf(m[1], numOf(m[2]))
    const min = minOf(m[3])
    if (!Number.isNaN(h)) {
      let dayOffset = 0
      if (h >= 24) { h -= 24; dayOffset += 1 }
      const d = dayStart(now)
      d.setHours(h, min, 0, 0)
      let at = d.getTime() + dayOffset * 86400000
      if (at <= now) at += 86400000
      return { at, repeat: 'none', text: contentOf(text0, m[0]) }
    }
  }

  return null
}

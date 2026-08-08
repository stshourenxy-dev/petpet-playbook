// 动作优先级仲裁（P0 状态仲裁层）
// 设计参考：Clawd-on-desk src/state-priority.js 的显式优先级表思想
// 原则：低优先级请求不打断高优先级播放；用户主动操作（菜单）永远最高；提醒必须显示
// 注意：红苕 8 动作全为循环动画，ONESHOT 集合当前为空，为未来一次性动作预留

export type ActionSource = 'menu' | 'reminder' | 'random' | 'auto' | 'init' | 'transition'

// 打断价值排序：数字越大越优先
// 提醒(7) > 拉粑粑(5) > 撒娇/伸懒腰(4) > 奔跑/露肚躺(3) > 嗅闻(2) > 待机(1) > 睡觉(0)
// 注：remind:7 当前是装饰性锚点——提醒实际播 wiggle 且走 reminder 源直接放行（shouldPlay 硬路径），
// 保留它作为“未来提醒专用动作”的优先级预留，不参与当前仲裁
export const ACTION_PRIORITY: Record<string, number> = {
  sleep: 0,
  idle: 1,
  sniff: 2,
  run: 3,
  belly: 3,
  wiggle: 4,
  stretch: 4,
  poop: 5,
  remind: 7,
}

// 一次性动作（播完自动回 idle）：当前红苕 8 动作全为循环动画，
// 此集合为未来一次性动作（点击反应/喂食反应）预留，加入即由播放层播完回 idle
export const ONESHOT_ACTIONS = new Set<string>([])

export function priorityOf(action: string): number {
  return ACTION_PRIORITY[action] ?? 1
}

export function isOneshot(action: string): boolean {
  return ONESHOT_ACTIONS.has(action)
}

export interface ActionRequest {
  name: string
  source: ActionSource
}

// 仲裁：是否允许执行请求的动作
// - menu / reminder / init：用户主动 / 提醒必须显示 / 初始加载 → 永远允许
// - random：仅在待机时允许（显式化现有守卫：随机行为不打断任何动作）
// - transition：行为链的自然延续（作者在 pet.json 显式定义的转移链，见 docs/11 §2.1）
//   ——仅在随机进入的动作播完后触发，用户手动切换的动作不设转移定时器，故不会被打断
// - auto：低优先级不打断高优先级（同优先级不打断，避免抖动）
export function shouldPlay(req: ActionRequest, currentAction: string): boolean {
  if (req.source === 'menu' || req.source === 'reminder' || req.source === 'init') return true
  if (req.source === 'random') return currentAction === 'idle'
  if (req.source === 'transition') return true
  return priorityOf(req.name) > priorityOf(currentAction)
}

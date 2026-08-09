// V2-A temperament 调制器（2026-08-09）
// 设计：effectiveWeight = baseWeight × temperamentFactor
// 克制原则：调制幅度 ≤±30%（钳制 0.7-1.3）；中性/缺省 temperament = 原行为（向后兼容）
// 参考：DeepSeek/OpenAI 双评估共识——temperament=动物行为倾向，非人类人格

export interface Temperament {
  activity?: number      // 活跃：高 → run 增多
  clinginess?: number    // 黏人：高 → wiggle/belly（互动撒娇）增多
  curiosity?: number     // 好奇：高 → sniff 增多
  independence?: number  // 独立：高 → sleep 略增（独处倾向）
}

// 单个动作的气质系数（中性=1，钳制 [0.7, 1.3]）
export function temperamentFactor(action: string, t?: Temperament | null): number {
  if (!t) return 1
  let f = 1
  if (action === 'wiggle' || action === 'belly') f *= 1 + ((t.clinginess ?? 0.5) - 0.5) * 0.6
  if (action === 'run') f *= 1 + ((t.activity ?? 0.5) - 0.5) * 0.6
  if (action === 'sniff') f *= 1 + ((t.curiosity ?? 0.5) - 0.5) * 0.6
  if (action === 'sleep') f *= 1 + ((t.independence ?? 0.5) - 0.5) * 0.4
  return Math.min(1.3, Math.max(0.7, f))
}

// 有效权重（供随机行为选择使用）
export function effectiveWeight(action: string, base: number, t?: Temperament | null): number {
  if (base <= 0) return base // 零权重动作不被调制激活
  return Math.round(base * temperamentFactor(action, t) * 100) / 100
}

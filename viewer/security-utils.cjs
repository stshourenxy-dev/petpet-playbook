// PetPet 安全工具（主进程纯函数，独立模块便于单测）
// 职责：宠物 id 白名单校验 + 路径穿越防护（字符串级 + realpath 纵深）
// 背景：原实现内联在 main.js，无单测覆盖——抽离后由 vitest 直接测试（AI 工具审计补充项）
'use strict'
const path = require('path')
const fs = require('fs')

// 宠物 id 白名单：小写/大写字母、数字、下划线、连字符（目录名即 id，防路径注入）
function safePetId(id) {
  return typeof id === 'string' && /^[a-z0-9_-]+$/i.test(id) ? id : null
}

// 路径必须在 petsRoot 内：字符串级（relative 前缀） + 符号链接纵深（realpath）
// 防：../ 逃逸、绝对路径、同级前缀目录绕过（/pets-evil 相对 /pets）、符号链接指向外部
// 注意：petsRoot 自身也需 realpath——macOS /var→/private/var 是符号链接，
// 仅 realpath(full) 会导致相对比较误判（测试 os.tmpdir() 暴露）
function isSafeUnderRoot(full, petsRoot) {
  const rel = path.relative(petsRoot, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  try {
    const realRoot = fs.realpathSync(petsRoot)
    const real = fs.realpathSync(full)
    const relReal = path.relative(realRoot, real)
    return !(relReal.startsWith('..') || path.isAbsolute(relReal))
  } catch (e) {
    return false // 不存在/无法解析 → 拒绝（等价 404）
  }
}

module.exports = { safePetId, isSafeUnderRoot }

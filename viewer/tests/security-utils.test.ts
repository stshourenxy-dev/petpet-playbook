// security-utils 安全函数单测（AI 工具审计补充项：此前 main.js 内联函数零覆盖）
// 覆盖：safePetId 白名单边界 + isSafeUnderRoot 路径逃逸/符号链接/前缀绕过
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { safePetId, isSafeUnderRoot } from '../security-utils.cjs'

describe('safePetId（宠物 id 白名单）', () => {
  it('合法 id 通过（字母/数字/下划线/连字符/大小写）', () => {
    for (const ok of ['dog', 'redshao-demo', 'pet_2', 'A1-b', 'a']) {
      expect(safePetId(ok)).toBe(ok)
    }
  })

  it('路径注入类 id 拒绝', () => {
    for (const bad of ['../../etc', '../pet', '/absolute', 'a/b', '..', 'pet/../x']) {
      expect(safePetId(bad)).toBeNull()
    }
  })

  it('空白/特殊字符/中文拒绝', () => {
    for (const bad of ['a b', '中文', 'a;rm', 'a$b', '']) {
      expect(safePetId(bad)).toBeNull()
    }
  })

  it('非字符串拒绝', () => {
    expect(safePetId(123)).toBeNull()
    expect(safePetId(null)).toBeNull()
    expect(safePetId(undefined)).toBeNull()
    expect(safePetId({})).toBeNull()
  })
})

describe('isSafeUnderRoot（路径穿越防护）', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pets-sec-test-'))
    fs.mkdirSync(path.join(root, 'dog', 'idle'), { recursive: true })
    fs.writeFileSync(path.join(root, 'dog', 'idle', 'a.png'), 'x')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('包内路径通过', () => {
    expect(isSafeUnderRoot(path.join(root, 'dog', 'idle', 'a.png'), root)).toBe(true)
    expect(isSafeUnderRoot(path.join(root, 'dog'), root)).toBe(true)
  })

  it('../ 逃逸拒绝', () => {
    expect(isSafeUnderRoot(path.join(root, '..', 'etc', 'passwd'), root)).toBe(false)
    expect(isSafeUnderRoot(path.join(root, '..', '..', 'tmp', 'x'), root)).toBe(false)
  })

  it('同级前缀目录绕过拒绝（/tmp/pets-evil 相对 /tmp/pets）', () => {
    const sibling = root + '-evil'
    fs.mkdirSync(sibling)
    fs.writeFileSync(path.join(sibling, 'x.png'), 'x')
    expect(isSafeUnderRoot(path.join(sibling, 'x.png'), root)).toBe(false)
  })

  it('不存在路径拒绝（realpath 失败等价 404）', () => {
    expect(isSafeUnderRoot(path.join(root, 'dog', 'nope.png'), root)).toBe(false)
  })

  it('符号链接指向包外拒绝', () => {
    const evil = path.join(root, 'dog', 'evil-link')
    fs.symlinkSync('/etc', evil)
    expect(isSafeUnderRoot(evil, root)).toBe(false)
  })

  it('包内符号链接（指向包内真实文件）通过', () => {
    const link = path.join(root, 'dog', 'idle', 'link.png')
    fs.symlinkSync(path.join(root, 'dog', 'idle', 'a.png'), link)
    expect(isSafeUnderRoot(link, root)).toBe(true)
  })
})

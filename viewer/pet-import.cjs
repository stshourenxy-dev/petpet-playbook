// PetPet 宠物包导入器（主进程模块，CommonJS）
//
// 功能来源：用户反馈——宠物主人安装素材包困难（需手动复制目录到
// ~/.petpet/pets/，红苕爸爸实测暴露），故提供"导入宠物包"入口。
//
// 导入路径：
//   1. 目录选择：选择已解压的宠物包目录 → 校验 → 复制到 ~/.petpet/pets/<id>/
//   2. zip 文件：选择 .petpack/.zip → 系统 unzip 解压到临时目录 → 定位含
//      pet.json 的包根 → 校验 → 移动到 ~/.petpet/pets/<id>/
//
// 校验对齐 pipeline/validate_pet.py 的核心检查项（JS 轻量版）：
//   - pet.json 存在且可解析
//   - version 合法（1/2/3 兼容）
//   - id 合法（^[a-z0-9_-]+$）且作为目标目录名
//   - actions 非空，每个动作的精灵表文件存在
//   - 精灵表总宽 ≤ 16384px（WebGL 纹理硬上限，见 docs/07 踩坑 #1）

const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')

const ID_RE = /^[a-z0-9_-]+$/
const MAX_TEXTURE_WIDTH = 16384

// ── 自由文本净化（Qwen 全量审计 V-10：提示注入链 + 间接注入载体）──────
// 与 pipeline/validate_pet.py 的 clean_text 保持一致：剥离零宽/BiDi/控制字符，
// 超长拒绝。JS 端为轻量版（正则一致，maxLength 一致）。
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u00ad\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
const TEXT_MAX = { name: 50, bubble: 100, label: 30, diary: 200, species: 50, attr: 50, habitKey: 30 }

function cleanText(s) {
  return String(s).replace(INVISIBLE_RE, '')
}

function checkText(field, v, maxLen) {
  // 返回错误消息或 null
  if (typeof v !== 'string') return `${field} 应为字符串`
  const cleaned = cleanText(v)
  if (!cleaned.trim()) return `${field} 剥离不可见字符后为空（可能含零宽/控制字符注入）`
  if (cleaned.length > maxLen) return `${field} 超长（≤${maxLen} 字符），实际 ${cleaned.length}`
  return null
}

// ── PNG 尺寸解析（只读 IHDR，无需完整解码）─────────────────────────────
function pngSize(buf) {
  if (!buf || buf.length < 24) return null
  // 8B signature + 4B length + 'IHDR' + width(4B BE) + height(4B BE)
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// ── WebP 尺寸解析（只读头部，支持 VP8X/VP8/VP8L 三种 chunk）────────────
// GLM 审计补充项：此前 WebP 精灵表跳过实际尺寸校验（仅 PNG 查 IHDR），
// 恶意 WebP 可绕过配置层上限检查 → 资源炸弹路径
function webpSize(buf) {
  if (!buf || buf.length < 30) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    // 扩展格式：24 位 canvas 宽高（存的是 width-1/height-1）
    if (buf.length < 30) return null
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  if (chunk === 'VP8 ') {
    // 有损格式：帧头后 0x9D 0x01 0x2A 标记，随后 14 位宽高
    if (buf.length < 30) return null
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    // 无损格式：0x2F 签名后 4 字节打包宽高（各 14 位 + 1）
    if (buf.length < 25) return null
    if (buf[20] !== 0x2f) return null
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

// ── 校验单个宠物包目录 ──────────────────────────────────────────────────
// 返回 { ok: true, id, name, pet } 或 { ok: false, error }
function validatePetDir(dirPath) {
  const petJsonPath = path.join(dirPath, 'pet.json')
  if (!fs.existsSync(petJsonPath)) {
    return { ok: false, error: `目录中没有 pet.json：${dirPath}` }
  }

  let pet
  try {
    pet = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'))
  } catch (e) {
    return { ok: false, error: `pet.json 解析失败：${e.message}` }
  }

  if (typeof pet.version !== 'number' || pet.version < 1) {
    return { ok: false, error: 'pet.json 缺少合法 version（应为 1/2/3）' }
  }
  if (!pet.id || !ID_RE.test(pet.id)) {
    return { ok: false, error: `pet.json id 不合法（应为小写字母/数字/_-）：${pet.id || '(空)'}` }
  }
  if (!pet.actions || typeof pet.actions !== 'object' || Object.keys(pet.actions).length === 0) {
    return { ok: false, error: 'pet.json actions 为空（至少需要一个动作）' }
  }

  // Qwen 审计 V-10：自由文本净化（name/bubbles/actions.label/diary）——
  // 剥离零宽/BiDi/控制字符（防提示注入链）+ 长度上限（防存储/渲染滥用）
  const nameErr = checkText('name', pet.name, TEXT_MAX.name)
  if (nameErr) return { ok: false, error: nameErr }
  if (Array.isArray(pet.bubbles)) {
    for (let i = 0; i < pet.bubbles.length; i++) {
      const e = checkText(`bubbles[${i}]`, pet.bubbles[i], TEXT_MAX.bubble)
      if (e) return { ok: false, error: e }
    }
  } else if (pet.bubbles !== undefined) {
    return { ok: false, error: 'bubbles 应为字符串数组' }
  }

  // 精灵表存在性 + 纹理总宽上限
  for (const [name, act] of Object.entries(pet.actions)) {
    const file = act.file || act.sprite
    if (!file) {
      return { ok: false, error: `动作 ${name} 缺少 file/sprite 字段` }
    }
    // Qwen V-10：动作级自由文本净化（label/diary，可选字段——undefined 跳过）
    if (act.label !== undefined) {
      const labelErr = checkText(`动作 ${name}.label`, act.label, TEXT_MAX.label)
      if (labelErr) return { ok: false, error: labelErr }
    }
    if (act.diary !== undefined) {
      const d = act.diary
      if (!d || typeof d !== 'object' || typeof d.mood !== 'string' || typeof d.text !== 'string') {
        return { ok: false, error: `动作 ${name}.diary 应含 mood（字符串）和 text（字符串）` }
      }
      const moodErr = checkText(`动作 ${name}.diary.mood`, d.mood, TEXT_MAX.label)
      if (moodErr) return { ok: false, error: moodErr }
      const textErr = checkText(`动作 ${name}.diary.text`, d.text, TEXT_MAX.diary)
      if (textErr) return { ok: false, error: textErr }
    }
    const abs = path.join(dirPath, file)
    if (!fs.existsSync(abs)) {
      return { ok: false, error: `动作 ${name} 的精灵表不存在：${file}` }
    }
    // 纹理上限：帧宽×帧数 或 文件实际宽，二者都查
    const frames = act.frames || 1
    const frameWidth = act.frameWidth || pet.cellWidth || 0
    if (frameWidth > 0 && frameWidth * frames > MAX_TEXTURE_WIDTH) {
      return { ok: false, error: `动作 ${name} 帧宽×帧数 = ${frameWidth}×${frames} = ${frameWidth * frames}px 超过 16384px 上限` }
    }
    if (/\.png$/i.test(file)) {
      const size = pngSize(fs.readFileSync(abs))
      if (size && size.width > MAX_TEXTURE_WIDTH) {
        return { ok: false, error: `动作 ${name} 精灵表实际宽 ${size.width}px 超过 16384px 上限` }
      }
    } else if (/\.webp$/i.test(file)) {
      // GLM 审计补充：WebP 此前跳过尺寸校验，现补头部解析
      const size = webpSize(fs.readFileSync(abs))
      if (size && size.width > MAX_TEXTURE_WIDTH) {
        return { ok: false, error: `动作 ${name} 精灵表实际宽 ${size.width}px 超过 16384px 上限` }
      }
    }
  }

  return { ok: true, id: pet.id, name: pet.name || pet.id, pet }
}

// ── zip 解压（系统工具，零 npm 依赖）────────────────────────────────────
// macOS/Linux 用 unzip；Windows 10+ 用内置 tar（支持 zip）
function unzipTo(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const tool = isWin ? 'tar' : 'unzip'
    const args = isWin ? ['-xf', zipPath, '-C', destDir] : ['-o', zipPath, '-d', destDir]
    execFile(tool, args, { timeout: 30000 }, (err) => {
      if (err) reject(new Error(`系统解压失败（${tool}）：${err.message}`))
      else resolve()
    })
  })
}

// ── 枚举 zip 条目（解压前安全检查用）────────────────────────────────────
function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const tool = isWin ? 'tar' : 'unzip'
    const args = isWin ? ['-tf', zipPath] : ['-Z1', zipPath]
    execFile(tool, args, { timeout: 30000 }, (err, stdout) => {
      if (err) reject(new Error(`读取压缩包条目失败（${tool}）：${err.message}`))
      else resolve(stdout.split(/\r?\n/).filter(Boolean))
    })
  })
}

// ── 条目安全检查（防 zip slip：绝对路径 / ../ 段 / Windows 盘符）────────
function checkZipEntries(entries) {
  const bad = entries.filter((e) => {
    if (!e) return false
    const norm = e.replace(/\\/g, '/')
    if (path.isAbsolute(norm)) return true
    if (/^[a-zA-Z]:/.test(norm)) return true // Windows drive letter
    return norm.split('/').includes('..')
  })
  return bad
}

// ── 解压后兜底：所有落盘文件的真实路径必须在 tmp 内 ──────────────────────
// 防符号链接/条目检查绕过（realpath 纵深，对齐 main.js D-6 思路）
function assertNoEscape(root) {
  const realRoot = fs.realpathSync(root)
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) { offenders.push(p); continue }
      if (entry.isDirectory()) walk(p)
      else {
        let real
        try { real = fs.realpathSync(p) } catch { real = null }
        if (!real || !real.startsWith(realRoot + path.sep)) offenders.push(p)
      }
    }
  }
  walk(root)
  return offenders
}

// ── 在解压产物中定位宠物包根目录 ────────────────────────────────────────
// 规则：顶层有 pet.json → 顶层即包根；否则在单层子目录中找 pet.json
function locatePetRoot(dirPath) {
  if (fs.existsSync(path.join(dirPath, 'pet.json'))) return dirPath
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const subdirs = entries.filter(e => e.isDirectory())
  for (const d of subdirs) {
    const candidate = path.join(dirPath, d.name)
    if (fs.existsSync(path.join(candidate, 'pet.json'))) return candidate
  }
  return null
}

// ── 复制目录（跳过隐藏文件与 .DS_Store）─────────────────────────────────
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

// ── 导入目录：校验 → 复制到 PETS_ROOT/<id>/ ─────────────────────────────
// 返回 { ok: true, id, name, dest } 或 { ok: false, error }
function importPetDir(srcDir, petsRoot) {
  const v = validatePetDir(srcDir)
  if (!v.ok) return v
  const dest = path.join(petsRoot, v.id)
  try {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true })  // 覆盖导入
    }
    copyDir(srcDir, dest)
    return { ok: true, id: v.id, name: v.name, dest }
  } catch (e) {
    return { ok: false, error: `导入失败：${e.message}` }
  }
}

// ── 导入 zip：解压 → 定位包根 → 校验 → 移动 ─────────────────────────────
async function importPetZip(zipPath, petsRoot) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'petpet-import-'))
  try {
    // D-7: zip slip 防护——解压前枚举条目拦截绝对路径/../段；解压后 realpath 兜底
    const entries = await listZipEntries(zipPath)
    const bad = checkZipEntries(entries)
    if (bad.length > 0) {
      return { ok: false, error: `压缩包包含不安全路径条目，已拒绝（zip slip）：${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' …' : ''}` }
    }
    await unzipTo(zipPath, tmp)
    const escaped = assertNoEscape(tmp)
    if (escaped.length > 0) {
      for (const p of escaped) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* 尽力清理 */ } }
      return { ok: false, error: '压缩包解压越界（符号链接或越界路径），已拦截并清理' }
    }
    const root = locatePetRoot(tmp)
    if (!root) {
      return { ok: false, error: '压缩包内找不到 pet.json（请确认是宠物包 zip）' }
    }
    const v = validatePetDir(root)
    if (!v.ok) return v
    const dest = path.join(petsRoot, v.id)
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true })
    }
    fs.mkdirSync(petsRoot, { recursive: true })
    fs.renameSync(root, dest)
    return { ok: true, id: v.id, name: v.name, dest }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = { validatePetDir, importPetDir, importPetZip, unzipTo, pngSize, webpSize, locatePetRoot, listZipEntries, checkZipEntries, assertNoEscape, cleanText }

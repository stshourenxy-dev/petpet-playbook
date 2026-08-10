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
const MAX_TEXTURE_HEIGHT = 16384  // AI 工具审计 V-01：此前只查宽不查高（1024×1亿 头可通过 → OOM）
const MAX_TEXTURE_PIXELS = 8192 * 8192  // 总像素上限（≈256MB 解码内存），防高度炸弹组合
const MAX_ZIP_ENTRIES = 2000  // AI 工具审计 V-02：zip 条目数上限（防海量小文件炸弹）
const MAX_UNZIP_BYTES = 500 * 1024 * 1024  // AI 工具审计 V-02：解压总量上限（防填盘）
const MAX_FILE_BYTES = 64 * 1024 * 1024  // A5-CES-002：单文件上限
const MAX_COMPRESSION_RATIO = 100  // A5-CES-002：压缩比上限（未压缩/压缩 >100 倍拒）

// 只读文件头部（AI 工具审计 V-02：此前 readFileSync 读整个精灵表只为取 30 字节头，4GB 文件可打爆主进程）
function readHead(filePath, n = 64) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(n)
    const read = fs.readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

// JPEG 尺寸解析（SOF0/1/2 marker：FFC0/C1/C2 后 5 字节起 2B 高 + 2B 宽）
// AI 工具审计 V-01 加固（A5-CES-003）：SOF 可能位于较长 EXIF/APP 段之后，
// 必须按 segment 长度流式跳过（64KB 上限），不能只查前 64 字节
function jpgSize(buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null  // 非 JPEG 魔数
  let i = 2
  const limit = Math.min(buf.length, 65536)
  while (i + 4 <= limit) {
    if (buf[i] !== 0xff) return null  // 段标记失步 → 损坏
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2  // 无长度段（SOI/EOI/RST）
      continue
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (i + 9 > buf.length) return null
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    }
    const segLen = buf.readUInt16BE(i + 2)
    if (segLen < 2) return null
    i += 2 + segLen
  }
  return null  // 64KB 内未找到 SOF → 无法验证尺寸
}

// GIF 尺寸解析（GIF87a/89a 头后 LE16 宽高）
function gifSize(buf) {
  if (!buf || buf.length < 10) return null
  if (buf.toString('ascii', 0, 6) !== 'GIF87a' && buf.toString('ascii', 0, 6) !== 'GIF89a') return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

// BMP 尺寸解析（BM 头后 LE32 宽高，高取绝对值）
function bmpSize(buf) {
  if (!buf || buf.length < 26) return null
  if (buf.toString('ascii', 0, 2) !== 'BM') return null
  return { width: buf.readUInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
}

// ── 自由文本净化（AI 工具全量审计 V-10：提示注入链 + 间接注入载体）──────
// 与 pipeline/validate_pet.py 的 clean_text 保持一致：剥离零宽/BiDi/控制字符，
// 超长拒绝。JS 端为轻量版（正则一致，maxLength 一致）。
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u00ad\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
const TEXT_MAX = { name: 50, bubble: 100, label: 30, diary: 200, species: 50, attr: 50, habitKey: 30 }

function cleanText(s) {
  return String(s).replace(INVISIBLE_RE, '')
}

function checkText(field, v, maxLen) {
  // 返回错误消息或 null
  // A5-CES-005：语义从「剥离后检查」改为「含不可见/控制字符即拒绝」（不写回、不落盘净化）
  if (typeof v !== 'string') return `${field} 应为字符串`
  if (INVISIBLE_RE.test(v)) return `${field} 含不可见/控制字符（零宽/BiDi/控制，已拒绝）`
  if (v.length > maxLen) return `${field} 超长（≤${maxLen} 字符），实际 ${v.length}`
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
// AI 工具审计补充项：此前 WebP 精灵表跳过实际尺寸校验（仅 PNG 查 IHDR），
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

  // AI 工具审计 E：version 口径统一——schema enum [2,3] / validate_pet.py (2,3) / 此处收紧（此前 <1 导致 99 也过）
  if (typeof pet.version !== 'number' || ![2, 3].includes(pet.version)) {
    return { ok: false, error: `pet.json version 不合法（应为 2 或 3，3 为当前契约）：${pet.version ?? '(空)'}` }
  }
  if (!pet.id || !ID_RE.test(pet.id)) {
    return { ok: false, error: `pet.json id 不合法（应为小写字母/数字/_-）：${pet.id || '(空)'}` }
  }
  if (!pet.actions || typeof pet.actions !== 'object' || Object.keys(pet.actions).length === 0) {
    return { ok: false, error: 'pet.json actions 为空（至少需要一个动作）' }
  }

  // AI 工具审计 V-10：自由文本净化（name/bubbles/actions.label/diary）——
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
    // AI 工具审计 V-10：动作级自由文本净化（label/diary，可选字段——undefined 跳过）
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
    // P0-4（A5-CES-004）：action 必填对齐 schema required（此前 JS 缺失也通过，Python 必填）
    for (const f of ['frames', 'frameWidth', 'frameHeight']) {
      const v = act[f]
      if (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0) {
        return { ok: false, error: `动作 ${name}: ${f} 必填且为正数（对齐 schema required）` }
      }
    }
    // P0-4（A5-CES-004）：资源路径必须位于包根内（此前 ../outside.png 也能通过）
    const abs = path.join(dirPath, file)
    const rel = path.relative(dirPath, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: `动作 ${name} 精灵表路径越出包根（不允许 ../ 或绝对路径）：${file}` }
    }
    if (!fs.existsSync(abs)) {
      return { ok: false, error: `动作 ${name} 的精灵表不存在：${file}` }
    }
    // 纹理上限：帧宽×帧数 或 文件实际宽高/总像素，都查（AI 工具审计 V-01 加固）
    const frames = act.frames || 1
    const frameWidth = act.frameWidth || pet.cellWidth || 0
    if (frameWidth > 0 && frameWidth * frames > MAX_TEXTURE_WIDTH) {
      return { ok: false, error: `动作 ${name} 帧宽×帧数 = ${frameWidth}×${frames} = ${frameWidth * frames}px 超过 16384px 上限` }
    }
    // 只读头部（不再整文件读入，V-02）；按扩展名解析实际尺寸，统一查宽/高/总像素（V-01）
    // A5-CES-003：解析失败必须 fail-closed（未知格式/损坏头/尺寸头超扫描范围一律拒绝）
    const head = readHead(abs, 65536)
    let size = null
    let knownFormat = true
    if (/\.png$/i.test(file)) size = pngSize(head)
    else if (/\.webp$/i.test(file)) size = webpSize(head)
    else if (/\.jpe?g$/i.test(file)) size = jpgSize(head)
    else if (/\.gif$/i.test(file)) size = gifSize(head)
    else if (/\.bmp$/i.test(file)) size = bmpSize(head)
    else knownFormat = false
    if (!knownFormat) {
      return { ok: false, error: `动作 ${name} 精灵表格式不支持（仅 png/webp/jpg/gif/bmp）：${file}` }
    }
    if (!size) {
      return { ok: false, error: `动作 ${name} 精灵表头部解析失败或损坏（无法验证尺寸）：${file}` }
    }
    if (size.width > MAX_TEXTURE_WIDTH || size.height > MAX_TEXTURE_HEIGHT) {
      return { ok: false, error: `动作 ${name} 精灵表尺寸 ${size.width}×${size.height}px 超过上限（单边 ≤${MAX_TEXTURE_WIDTH}）` }
    }
    if (size.width * size.height > MAX_TEXTURE_PIXELS) {
      return { ok: false, error: `动作 ${name} 精灵表总像素 ${size.width * size.height} 超过 ${MAX_TEXTURE_PIXELS} 上限` }
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

// ── 解压前预算（A5-CES-002：总量/单文件/压缩比在 unzip 之前检查，防填盘）──
// unzip -l 输出每行: Length  Date  Time  Name；tar -tvf 输出含 size 字段
function listZipSizes(zipPath) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const tool = isWin ? 'tar' : 'unzip'
    const args = isWin ? ['-tvf', zipPath] : ['-l', zipPath]
    execFile(tool, args, { timeout: 30000 }, (err, stdout) => {
      if (err) reject(new Error(`读取压缩包大小预算失败（${tool}）：${err.message}`))
      else {
        const sizes = []
        const lines = stdout.split(/\r?\n/)
        for (const line of lines) {
          if (!isWin) {
            // unzip -l: <length>  <MM-DD-YYYY> <time> <name>（日期是美国格式 MM-DD-YYYY）
            const m = line.match(/^\s*(\d+)\s+\d{2}-\d{2}-\d{4}/)
            if (m) sizes.push({ size: Number(m[1]), name: line.slice(30).trim() })
          } else {
            // tar -tvf（Windows bsdtar）: -rw-r--r-- 0 0 0 <size> <MM-DD-YYYY> <time> <name>
            // macOS bsdtar: -rw-r--r-- 0 0 0 <size> <Mon DD HH:MM> <name>——统一取第 5 个字段
            const t = line.split(/\s+/)
            if (t.length >= 5 && /^\d+$/.test(t[4])) {
              sizes.push({ size: Number(t[4]), name: t.slice(5).join(' ') })
            }
          }
        }
        resolve(sizes)
      }
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
    // AI 工具审计 V-02：zip 炸弹防护——条目数上限（防海量小文件）
    if (entries.length > MAX_ZIP_ENTRIES) {
      return { ok: false, error: `压缩包条目数 ${entries.length} 超过上限 ${MAX_ZIP_ENTRIES}（zip 炸弹防护）` }
    }
    const bad = checkZipEntries(entries)
    if (bad.length > 0) {
      return { ok: false, error: `压缩包包含不安全路径条目，已拒绝（zip slip）：${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' …' : ''}` }
    }
    // A5-CES-002：解压前预算检查（unzip -l / tar -tvf 读 uncompressed 元数据，未解压即拒绝）
    const sizes = await listZipSizes(zipPath)
    const totalBytes = sizes.reduce((s, f) => s + f.size, 0)
    const zipBytes = fs.statSync(zipPath).size
    if (totalBytes > MAX_UNZIP_BYTES) {
      return { ok: false, error: `压缩包未压缩总量 ${(totalBytes / 1024 / 1024).toFixed(1)}MB 超过上限 ${MAX_UNZIP_BYTES / 1024 / 1024}MB（zip 炸弹防护，解压前拦截）` }
    }
    const maxFile = sizes.reduce((m, f) => Math.max(m, f.size), 0)
    if (maxFile > MAX_FILE_BYTES) {
      return { ok: false, error: `压缩包单文件 ${(maxFile / 1024 / 1024).toFixed(1)}MB 超过上限 ${MAX_FILE_BYTES / 1024 / 1024}MB` }
    }
    if (zipBytes > 0 && totalBytes / zipBytes > MAX_COMPRESSION_RATIO) {
      return { ok: false, error: `压缩比 ${Math.round(totalBytes / zipBytes)}× 超过上限 ${MAX_COMPRESSION_RATIO}×（zip 炸弹防护）` }
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

module.exports = { validatePetDir, importPetDir, importPetZip, unzipTo, pngSize, webpSize, jpgSize, gifSize, bmpSize, locatePetRoot, listZipEntries, listZipSizes, checkZipEntries, assertNoEscape, cleanText }

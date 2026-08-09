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

// ── PNG 尺寸解析（只读 IHDR，无需完整解码）─────────────────────────────
function pngSize(buf) {
  if (!buf || buf.length < 24) return null
  // 8B signature + 4B length + 'IHDR' + width(4B BE) + height(4B BE)
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
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

  // 精灵表存在性 + 纹理总宽上限
  for (const [name, act] of Object.entries(pet.actions)) {
    const file = act.file || act.sprite
    if (!file) {
      return { ok: false, error: `动作 ${name} 缺少 file/sprite 字段` }
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
    await unzipTo(zipPath, tmp)
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

module.exports = { validatePetDir, importPetDir, importPetZip, unzipTo, pngSize, locatePetRoot }

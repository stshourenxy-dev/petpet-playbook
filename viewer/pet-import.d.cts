// PetPet 宠物包导入器类型声明（pet-import.cjs 的 TS 包装）
export interface ImportResult {
  ok: boolean
  id?: string
  name?: string
  dest?: string
  error?: string
}

export function validatePetDir(dirPath: string): ImportResult
export function importPetDir(srcDir: string, petsRoot: string): ImportResult
export function importPetZip(zipPath: string, petsRoot: string): Promise<ImportResult>
export function unzipTo(zipPath: string, destDir: string): Promise<void>
export function pngSize(buf: Buffer): { width: number; height: number } | null
export function locatePetRoot(dirPath: string): string | null

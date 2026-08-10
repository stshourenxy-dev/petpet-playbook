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
export function listZipEntries(zipPath: string): Promise<string[]>
export function checkZipEntries(entries: string[]): string[]
export function assertNoEscape(root: string): string[]
export function pngSize(buf: Buffer): { width: number; height: number } | null
export function webpSize(buf: Buffer): { width: number; height: number } | null
export function locatePetRoot(dirPath: string): string | null
export function cleanText(s: string): string
export function jpgSize(buf: Buffer): { width: number; height: number } | null
export function gifSize(buf: Buffer): { width: number; height: number } | null
export function bmpSize(buf: Buffer): { width: number; height: number } | null
export function listZipSizes(zipPath: string): Promise<{ size: number; name: string }[]>

// PetPet 安全工具类型声明（security-utils.cjs 的 TS 包装）
export function safePetId(id: unknown): string | null
export function isSafeUnderRoot(full: string, petsRoot: string): boolean

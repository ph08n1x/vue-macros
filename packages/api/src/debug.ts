import { inspect } from 'node:util'

const truthy = new Set(['1', 'true', 'yes', 'on'])
const enabled = truthy.has((process.env.VUE_MACROS_API_DEBUG ?? '').toLowerCase())
const scopeFilter = new Set(
  (process.env.VUE_MACROS_API_DEBUG_SCOPE ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean),
)
const fileFilter = process.env.VUE_MACROS_API_DEBUG_FILE?.trim()
const inspectDepth = Number.parseInt(
  process.env.VUE_MACROS_API_DEBUG_DEPTH ?? '3',
  10,
)

export interface DebugMeta {
  [key: string]: unknown
}

export function apiDebug(scope: string, event: string, meta?: DebugMeta): void {
  if (!enabled) return
  if (scopeFilter.size > 0 && !scopeFilter.has(scope)) return
  if (fileFilter && !matchesFileFilter(meta)) return

  const line = `${new Date().toISOString()} [vue-macros/api:${scope}] ${event}`
  if (!meta || Object.keys(meta).length === 0) {
    console.error(line)
    return
  }

  console.error(
    `${line} ${inspect(meta, {
      breakLength: 120,
      compact: true,
      depth: Number.isNaN(inspectDepth) ? 3 : inspectDepth,
      maxArrayLength: 30,
    })}`,
  )
}

export function formatDebugError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

let nextId = 1
export function nextDebugId(): number {
  const id = nextId
  nextId += 1
  return id
}

function matchesFileFilter(meta?: DebugMeta): boolean {
  if (!fileFilter) return true
  if (!meta) return false

  const candidates = [
    meta.file,
    meta.filePath,
    meta.id,
    meta.importer,
    meta.resolved,
    meta.source,
  ].filter((value): value is string => typeof value === 'string')

  return candidates.some((value) => value.includes(fileFilter))
}

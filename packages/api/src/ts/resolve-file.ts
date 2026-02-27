import path from 'node:path'
import { apiDebug, formatDebugError, nextDebugId } from '../debug'
import { tsFileCache } from './scope'
import type { ResolverFactory } from 'oxc-resolver'
import type { ModuleNode, Plugin } from 'vite'

let typesResolver: ResolverFactory
let typesResolverTask: Promise<ResolverFactory> | undefined

const referencedFiles = new Map<string /* file */, Set<string /* importer */>>()

function collectReferencedFile(importer: string, file: string) {
  if (!importer) return
  if (!referencedFiles.has(file)) {
    referencedFiles.set(file, new Set([importer]))
  } else {
    referencedFiles.get(file)!.add(importer)
  }
}

const resolveCache = new Map<
  string /* importer */,
  Map<string /* id */, string /* result */>
>()
const resolveInFlight = new Map<string, Promise<string | undefined>>()

export async function resolveDts(
  id: string,
  importer: string,
): Promise<string | undefined> {
  const requestId = nextDebugId()
  const cached = resolveCache.get(importer)?.get(id)
  if (cached) {
    apiDebug('resolve-file', 'resolve:cache-hit', {
      requestId,
      id,
      importer,
      resolved: cached,
    })
    return cached
  }

  apiDebug('resolve-file', 'resolve:start', {
    requestId,
    id,
    importer,
  })

  const inFlightKey = `${importer}\n${id}`
  const inFlight = resolveInFlight.get(inFlightKey)
  if (inFlight) {
    apiDebug('resolve-file', 'resolve:singleflight-join', {
      requestId,
      id,
      importer,
    })
    return inFlight
  }

  const task = (async (): Promise<string | undefined> => {
    const startedAt = Date.now()
    if (!typesResolver) {
      if (!typesResolverTask) {
        typesResolverTask = (async () => {
          const { ResolverFactory } = await import('oxc-resolver')
          return new ResolverFactory({
            mainFields: ['types'],
            conditionNames: ['types', 'import'],
            extensions: ['.d.ts', '.ts'],
          })
        })()
      }
      try {
        typesResolver = await typesResolverTask
      } catch (error) {
        typesResolverTask = undefined
        throw error
      }
      apiDebug('resolve-file', 'resolver:init', {
        requestId,
        durationMs: Date.now() - startedAt,
      })
    }

    const resolveStartedAt = Date.now()
    let error: unknown
    let resolved: string | undefined
    try {
      ;({ error, path: resolved } = await typesResolver.async(
        path.dirname(importer),
        id,
      ))
    } catch (resolveError) {
      apiDebug('resolve-file', 'resolve:error', {
        requestId,
        id,
        importer,
        durationMs: Date.now() - resolveStartedAt,
        error: formatDebugError(resolveError),
      })
      throw resolveError
    }
    if (error || !resolved) {
      apiDebug('resolve-file', 'resolve:miss', {
        requestId,
        id,
        importer,
        durationMs: Date.now() - resolveStartedAt,
        error: error ? formatDebugError(error) : undefined,
      })
      return
    }

    collectReferencedFile(importer, resolved)
    if (resolveCache.has(importer)) {
      resolveCache.get(importer)!.set(id, resolved)
    } else {
      resolveCache.set(importer, new Map([[id, resolved]]))
    }
    apiDebug('resolve-file', 'resolve:hit', {
      requestId,
      id,
      importer,
      resolved,
      durationMs: Date.now() - resolveStartedAt,
    })
    return resolved
  })()

  resolveInFlight.set(inFlightKey, task)
  try {
    return await task
  } finally {
    resolveInFlight.delete(inFlightKey)
  }
}

export const resolveDtsHMR: NonNullable<Plugin['handleHotUpdate']> = ({
  file,
  server,
  modules,
}) => {
  apiDebug('resolve-file', 'hmr:start', {
    file,
    inputModules: modules.length,
  })
  const cache = new Map<string, Set<ModuleNode>>()
  if (tsFileCache[file]) delete tsFileCache[file]

  const affected = getAffectedModules(file)
  apiDebug('resolve-file', 'hmr:affected', {
    file,
    affectedModules: affected.size,
  })
  return [...modules, ...affected]

  function getAffectedModules(file: string): Set<ModuleNode> {
    if (cache.has(file)) return cache.get(file)!
    if (!referencedFiles.has(file)) return new Set([])

    const modules = new Set<ModuleNode>([])
    cache.set(file, modules)
    for (const importer of referencedFiles.get(file)!) {
      const mods = server.moduleGraph.getModulesByFile(importer)
      if (mods) mods.forEach((m) => modules.add(m))

      getAffectedModules(importer).forEach((m) => modules.add(m))
    }
    return modules
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { tsFileCache } from './scope'
import type { ResolverFactory } from 'oxc-resolver'
import type { ModuleNode, Plugin } from 'vite'

let fallbackResolver: ResolverFactory
const resolverByTsconfig = new Map<string, ResolverFactory>()

const referencedFiles = new Map<string /* file */, Set<string /* importer */>>()

function collectReferencedFile(importer: string, file: string) {
  if (!importer) return
  if (referencedFiles.has(file)) {
    referencedFiles.get(file)!.add(importer)
  } else {
    referencedFiles.set(file, new Set([importer]))
  }
}

const resolveCache = new Map<
  string /* importer */,
  Map<string /* id */, string /* result */>
>()

export async function resolveDts(
  id: string,
  importer: string,
): Promise<string | undefined> {
  const cached = resolveCache.get(importer)?.get(id)
  if (cached) return cached

  const resolver = await getResolver(importer)
  const { error, path: resolved } = await resolver.async(
    path.dirname(importer),
    id,
  )
  if (error || !resolved) return

  collectReferencedFile(importer, resolved)
  if (resolveCache.has(importer)) {
    resolveCache.get(importer)!.set(id, resolved)
  } else {
    resolveCache.set(importer, new Map([[id, resolved]]))
  }
  return resolved
}

async function getResolver(importer: string): Promise<ResolverFactory> {
  const { ResolverFactory } = await import('oxc-resolver')
  const tsconfigFile = findNearestTsconfig(path.dirname(importer))

  if (!tsconfigFile) {
    if (!fallbackResolver) {
      fallbackResolver = new ResolverFactory({
        mainFields: ['types'],
        conditionNames: ['types', 'import'],
        extensions: ['.d.ts', '.ts'],
      })
    }
    return fallbackResolver
  }

  const cached = resolverByTsconfig.get(tsconfigFile)
  if (cached) return cached

  const resolver = new ResolverFactory({
    mainFields: ['types'],
    conditionNames: ['types', 'import'],
    extensions: ['.d.ts', '.ts'],
    tsconfig: {
      configFile: tsconfigFile,
      references: 'auto',
    },
  })
  resolverByTsconfig.set(tsconfigFile, resolver)
  return resolver
}

function findNearestTsconfig(fromDir: string): string | undefined {
  let current = fromDir
  while (true) {
    const tsconfig = path.join(current, 'tsconfig.json')
    if (fs.existsSync(tsconfig)) return tsconfig

    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

export const resolveDtsHMR: NonNullable<Plugin['handleHotUpdate']> = ({
  file,
  server,
  modules,
}) => {
  const cache = new Map<string, Set<ModuleNode>>()
  if (tsFileCache[file]) delete tsFileCache[file]

  const affected = getAffectedModules(file)
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

import { isTSDeclaration } from './is'
import { resolveDts } from './resolve-file'
import {
  resolveTSReferencedType,
  type TSResolvedType,
} from './resolve-reference'
import { apiDebug, formatDebugError, nextDebugId } from '../debug'
import { getTSFile, resolveTSScope, type TSScope } from './scope'

export const namespaceSymbol: unique symbol = Symbol('namespace')
export type TSNamespace = {
  [K in string]: TSResolvedType | TSNamespace | undefined
} & { [namespaceSymbol]: true }

const namespaceResolveTasks = new WeakMap<TSScope, Promise<void>>()
const namespaceResolveOwners = new WeakMap<TSScope, symbol>()
const scopeDebugIds = new WeakMap<TSScope, number>()
const tokenDebugIds = new Map<symbol, number>()
const tokenWaitGraph = new Map<symbol, Set<symbol>>()

export interface NamespaceResolveOptions {
  namespaceToken?: symbol
}

export function isTSNamespace(val: unknown): val is TSNamespace {
  return !!val && typeof val === 'object' && namespaceSymbol in val
}

function getScopeDebugLabel(scope: TSScope): string {
  const id = scopeDebugIds.get(scope) ?? nextDebugId()
  scopeDebugIds.set(scope, id)
  return `${id}:${resolveTSScope(scope).file.filePath}`
}

function getTokenDebugId(token?: symbol): number | undefined {
  if (!token) return undefined
  const id = tokenDebugIds.get(token) ?? nextDebugId()
  tokenDebugIds.set(token, id)
  return id
}

function wouldCreateWaitCycle(requestToken: symbol, ownerToken: symbol): boolean {
  if (requestToken === ownerToken) return true

  const visited = new Set<symbol>()
  const stack: symbol[] = [ownerToken]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === requestToken) return true
    if (visited.has(current)) continue
    visited.add(current)

    const waitsFor = tokenWaitGraph.get(current)
    if (!waitsFor) continue
    waitsFor.forEach((nextToken) => stack.push(nextToken))
  }

  return false
}

function addWaitEdge(requestToken: symbol, ownerToken: symbol): void {
  if (requestToken === ownerToken) return
  const waitsFor = tokenWaitGraph.get(requestToken) ?? new Set()
  waitsFor.add(ownerToken)
  tokenWaitGraph.set(requestToken, waitsFor)
}

function removeWaitEdge(requestToken: symbol, ownerToken: symbol): void {
  const waitsFor = tokenWaitGraph.get(requestToken)
  if (!waitsFor) return
  waitsFor.delete(ownerToken)
  if (waitsFor.size === 0) tokenWaitGraph.delete(requestToken)
}

/**
 * Get exports of the TS file.
 *
 * @limitation don't support non-TS declaration (e.g. class, function...)
 */
export async function resolveTSNamespace(
  scope: TSScope,
  options: NamespaceResolveOptions = {},
): Promise<void> {
  const scopeLabel = getScopeDebugLabel(scope)
  const requestedTokenId = getTokenDebugId(options.namespaceToken)
  apiDebug('namespace', 'resolve:enter', {
    scope: scopeLabel,
    requestTokenId: requestedTokenId,
    hasExports: !!scope.exports,
  })

  const inFlight = namespaceResolveTasks.get(scope)
  if (inFlight) {
    const owner = namespaceResolveOwners.get(scope)
    const ownerTokenId = getTokenDebugId(owner)
    const requestToken = options.namespaceToken
    const reentrant =
      !!owner && !!requestToken && owner === requestToken
    if (reentrant) {
      apiDebug('namespace', 'resolve:reentrant-skip', {
        scope: scopeLabel,
        ownerTokenId,
        requestTokenId: requestedTokenId,
      })
      return
    }

    if (owner && requestToken && wouldCreateWaitCycle(requestToken, owner)) {
      apiDebug('namespace', 'resolve:wait-cycle-skip', {
        scope: scopeLabel,
        ownerTokenId,
        requestTokenId: requestedTokenId,
      })
      return
    }

    if (owner && requestToken) {
      addWaitEdge(requestToken, owner)
    }

    const waitStartedAt = Date.now()
    apiDebug('namespace', 'resolve:wait-start', {
      scope: scopeLabel,
      ownerTokenId,
      requestTokenId: requestedTokenId,
    })
    try {
      await inFlight
      apiDebug('namespace', 'resolve:wait-end', {
        scope: scopeLabel,
        ownerTokenId,
        requestTokenId: requestedTokenId,
        waitMs: Date.now() - waitStartedAt,
      })
    } finally {
      if (owner && requestToken) {
        removeWaitEdge(requestToken, owner)
      }
    }
    return
  }
  if (scope.exports) {
    apiDebug('namespace', 'resolve:cache-hit', {
      scope: scopeLabel,
      requestTokenId: requestedTokenId,
    })
    return
  }

  const namespaceToken = options.namespaceToken ?? Symbol('namespace-resolve')
  const namespaceTokenId = getTokenDebugId(namespaceToken)
  apiDebug('namespace', 'resolve:start', {
    scope: scopeLabel,
    tokenId: namespaceTokenId,
  })
  let completeTask!: () => void
  let failTask!: (error: unknown) => void
  const task = new Promise<void>((resolve, reject) => {
    completeTask = resolve
    failTask = reject
  })
  namespaceResolveTasks.set(scope, task)
  namespaceResolveOwners.set(scope, namespaceToken)

  try {
    const exports: TSNamespace = {
      [namespaceSymbol]: true,
    }
    scope.exports = exports

    const declarations: TSNamespace = {
      [namespaceSymbol]: true,
      ...scope.declarations,
    }
    scope.declarations = declarations

    const { body, file } = resolveTSScope(scope)
    for (const [index, stmt] of (body || []).entries()) {
      apiDebug('namespace', 'resolve:stmt', {
        scope: scopeLabel,
        tokenId: namespaceTokenId,
        index,
        stmt: stmt.type,
      })

      if (
        stmt.type === 'ExportDefaultDeclaration' &&
        isTSDeclaration(stmt.declaration)
      ) {
        exports.default = await resolveTSReferencedType({
          scope,
          type: stmt.declaration,
        }, [], { namespaceToken })
      } else if (stmt.type === 'ExportAllDeclaration') {
        apiDebug('namespace', 'resolve:export-all', {
          scope: scopeLabel,
          tokenId: namespaceTokenId,
          source: stmt.source.value,
        })
        const resolved = await resolveDts(stmt.source.value, file.filePath)
        if (!resolved) {
          apiDebug('namespace', 'resolve:export-all-miss', {
            scope: scopeLabel,
            tokenId: namespaceTokenId,
            source: stmt.source.value,
          })
          continue
        }

        const sourceScope = await getTSFile(resolved)
        apiDebug('namespace', 'resolve:export-all-hit', {
          scope: scopeLabel,
          tokenId: namespaceTokenId,
          source: stmt.source.value,
          resolved,
          sourceScope: getScopeDebugLabel(sourceScope),
        })
        await resolveTSNamespace(sourceScope, { namespaceToken })

        Object.assign(exports, sourceScope.exports!)
      } else if (stmt.type === 'ExportNamedDeclaration') {
        let sourceExports: TSNamespace

        if (stmt.source) {
          apiDebug('namespace', 'resolve:export-named', {
            scope: scopeLabel,
            tokenId: namespaceTokenId,
            source: stmt.source.value,
          })
          const resolved = await resolveDts(stmt.source.value, file.filePath)
          if (!resolved) {
            apiDebug('namespace', 'resolve:export-named-miss', {
              scope: scopeLabel,
              tokenId: namespaceTokenId,
              source: stmt.source.value,
            })
            continue
          }

          const sourceScope = await getTSFile(resolved)
          apiDebug('namespace', 'resolve:export-named-hit', {
            scope: scopeLabel,
            tokenId: namespaceTokenId,
            source: stmt.source.value,
            resolved,
            sourceScope: getScopeDebugLabel(sourceScope),
          })
          await resolveTSNamespace(sourceScope, { namespaceToken })
          sourceExports = sourceScope.exports!
        } else {
          sourceExports = declarations
        }

        for (const specifier of stmt.specifiers) {
          let exported: TSNamespace[string]
          if (specifier.type === 'ExportDefaultSpecifier') {
            // export x from 'xxx'
            exported = sourceExports.default
          } else if (specifier.type === 'ExportNamespaceSpecifier') {
            // export * as x from 'xxx'
            exported = sourceExports
          } else if (specifier.type === 'ExportSpecifier') {
            // export { x } from 'xxx'
            exported = sourceExports![specifier.local.name]
          } else {
            throw new Error(`Unknown export type: ${(specifier as any).type}`)
          }

          const name =
            specifier.exported.type === 'Identifier'
              ? specifier.exported.name
              : specifier.exported.value
          exports[name] = exported
        }

        // export interface A {}
        if (isTSDeclaration(stmt.declaration)) {
          const decl = stmt.declaration

          if (decl.id?.type === 'Identifier') {
            const exportedName = decl.id.name
            declarations[exportedName] = exports[exportedName] =
              await resolveTSReferencedType({
                scope,
                type: decl,
              }, [], { namespaceToken })
          }
        }
      }

      // declarations
      else if (isTSDeclaration(stmt)) {
        if (stmt.id?.type !== 'Identifier') continue

        declarations[stmt.id.name] = await resolveTSReferencedType({
          scope,
          type: stmt,
        }, [], { namespaceToken })
      } else if (stmt.type === 'ImportDeclaration') {
        apiDebug('namespace', 'resolve:import', {
          scope: scopeLabel,
          tokenId: namespaceTokenId,
          source: stmt.source.value,
        })
        const resolved = await resolveDts(stmt.source.value, file.filePath)
        if (!resolved) {
          apiDebug('namespace', 'resolve:import-miss', {
            scope: scopeLabel,
            tokenId: namespaceTokenId,
            source: stmt.source.value,
          })
          continue
        }

        const importScope = await getTSFile(resolved)
        apiDebug('namespace', 'resolve:import-hit', {
          scope: scopeLabel,
          tokenId: namespaceTokenId,
          source: stmt.source.value,
          resolved,
          importScope: getScopeDebugLabel(importScope),
        })
        await resolveTSNamespace(importScope, { namespaceToken })
        const exports = importScope.exports!

        for (const specifier of stmt.specifiers) {
          const local = specifier.local.name

          let imported: TSNamespace[string]
          if (specifier.type === 'ImportDefaultSpecifier') {
            imported = exports.default
          } else if (specifier.type === 'ImportNamespaceSpecifier') {
            imported = exports
          } else if (specifier.type === 'ImportSpecifier') {
            const name =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value
            imported = exports[name]
          } else {
            throw new Error(`Unknown import type: ${(specifier as any).type}`)
          }
          declarations[local] = imported
        }
      }
    }
    apiDebug('namespace', 'resolve:done', {
      scope: scopeLabel,
      tokenId: namespaceTokenId,
      exportCount: Object.keys(exports).length,
      declarationCount: Object.keys(declarations).length,
    })
    completeTask()
  } catch (error) {
    apiDebug('namespace', 'resolve:failed', {
      scope: scopeLabel,
      requestTokenId: requestedTokenId,
      error: formatDebugError(error),
    })
    failTask(error)
    throw error
  } finally {
    namespaceResolveOwners.delete(scope)
    namespaceResolveTasks.delete(scope)
  }
}

import {
  isTSType,
  type Identifier,
  type Node,
  type TSParenthesizedType,
  type TSType,
  type TSTypeAliasDeclaration,
} from '@babel/types'
import { resolveIdentifier } from '@vue-macros/common'
import { isTSDeclaration, type TSDeclaration } from './is'
import {
  isTSNamespace,
  type NamespaceResolveOptions,
  resolveTSNamespace,
  type TSNamespace,
} from './namespace'
import { resolveTSIndexedAccessType } from './resolve'
import { apiDebug, nextDebugId } from '../debug'
import { resolveTSScope, type TSScope } from './scope'

export interface TSResolvedType<
  T =
    | Exclude<TSType, TSParenthesizedType>
    | Exclude<TSDeclaration, TSTypeAliasDeclaration>,
> {
  scope: TSScope
  type: T
}

type TSReferencedType = TSType | Identifier | TSDeclaration

export function isSupportedForTSReferencedType(
  node: Node,
): node is TSReferencedType {
  return isTSType(node) || node.type === 'Identifier' || isTSDeclaration(node)
}

/**
 * Resolve a reference to a type.
 *
 * Supports `type` and `interface` only.
 *
 * @limitation don't support non-TS declaration (e.g. class, function...)
 */
export async function resolveTSReferencedType(
  ref: TSResolvedType<TSReferencedType>,
  stacks: TSResolvedType<any>[] = [],
  options: NamespaceResolveOptions = {},
): Promise<TSResolvedType | TSNamespace | undefined> {
  const requestId = nextDebugId()
  const { scope, type } = ref
  const scopeLabel = resolveTSScope(scope).file.filePath
  apiDebug('resolve-reference', 'resolve:start', {
    requestId,
    scope: scopeLabel,
    nodeType: type.type,
    depth: stacks.length,
  })
  if (stacks.some((stack) => stack.scope === scope && stack.type === type)) {
    apiDebug('resolve-reference', 'resolve:cycle', {
      requestId,
      scope: scopeLabel,
      nodeType: type.type,
      depth: stacks.length,
    })
    return ref as any
  }
  stacks.push(ref)

  switch (type.type) {
    case 'TSTypeAliasDeclaration':
    case 'TSParenthesizedType':
      apiDebug('resolve-reference', 'resolve:unwrap', {
        requestId,
        scope: scopeLabel,
        nodeType: type.type,
      })
      return resolveTSReferencedType(
        { scope, type: type.typeAnnotation },
        stacks,
        options,
      )
    case 'TSIndexedAccessType':
      apiDebug('resolve-reference', 'resolve:indexed-access', {
        requestId,
        scope: scopeLabel,
        depth: stacks.length,
      })
      return resolveTSIndexedAccessType({ type, scope }, stacks, options)

    case 'TSModuleDeclaration': {
      if (type.body.type === 'TSModuleBlock') {
        const newScope: TSScope = {
          kind: 'module',
          ast: type.body,
          scope,
        }
        apiDebug('resolve-reference', 'resolve:module-declaration', {
          requestId,
          scope: scopeLabel,
        })
        await resolveTSNamespace(newScope, options)
        return newScope.exports
      }
      return undefined
    }
  }

  if (type.type !== 'Identifier' && type.type !== 'TSTypeReference') {
    apiDebug('resolve-reference', 'resolve:terminal', {
      requestId,
      scope: scopeLabel,
      nodeType: type.type,
    })
    return { scope, type }
  }

  await resolveTSNamespace(scope, options)
  const refNames = resolveIdentifier(
    type.type === 'TSTypeReference' ? type.typeName : type,
  )

  let resolved: TSResolvedType | TSNamespace | undefined =
    resolveTSScope(scope).declarations!

  for (const name of refNames) {
    if (isTSNamespace(resolved) && resolved[name]) {
      resolved = resolved[name]
    } else if (type.type === 'TSTypeReference') {
      apiDebug('resolve-reference', 'resolve:unresolved-type-ref', {
        requestId,
        scope: scopeLabel,
        reference: refNames.join('.'),
      })
      return { type, scope }
    }
  }

  apiDebug('resolve-reference', 'resolve:done', {
    requestId,
    scope: scopeLabel,
    nodeType: type.type,
    resolved:
      !resolved || isTSNamespace(resolved) ? 'namespace-or-empty' : resolved.type.type,
    depth: stacks.length,
  })
  return resolved
}

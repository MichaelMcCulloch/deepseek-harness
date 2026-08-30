/** Pure declaration validation for native DAG state. */

import { posix, win32 } from 'node:path'
import { DagNodeId } from './ids.ts'
import type { DagIntegrationPolicy, DagNodeDefinition, DagNodeId as NodeId, DagNodeInput, DagNodeSnapshot } from './types.ts'

/** Stable declaration rejection. */
export class DagDeclarationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DagDeclarationError'
  }
}

/** Canonical declaration plus its stable topological order. */
export interface ValidatedDagDeclaration {
  readonly definitions: readonly DagNodeDefinition[]
  readonly topologicalOrder: readonly NodeId[]
}

/** Validate one owned path as a normalized repository-relative path. */
function filePath(value: string, nodeId: string): string {
  const trimmed = value.trim()
  const portable = trimmed.replaceAll('\\', '/')
  if (trimmed.length === 0 || win32.isAbsolute(trimmed) || posix.isAbsolute(portable)
    || /[\u0000-\u001f\u007f]/u.test(portable)) {
    throw new DagDeclarationError(`node ${JSON.stringify(nodeId)} has an unsafe file path ${JSON.stringify(value)}`)
  }
  const normalized = posix.normalize(portable)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')
    || normalized === '.git' || normalized.startsWith('.git/')) {
    throw new DagDeclarationError(`node ${JSON.stringify(nodeId)} has an unsafe file path ${JSON.stringify(value)}`)
  }
  return normalized
}

/**
 * Validate and detach a whole graph declaration.
 * @param inputs - Complete declaration rows from a trusted parser.
 * @returns Immutable definitions and topological order.
 */
export function validateDagDeclaration(inputs: readonly DagNodeInput[]): ValidatedDagDeclaration {
  const definitions: DagNodeDefinition[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const idText = input.id.trim()
    const content = input.content.trim()
    const brief = input.brief.trim()
    if (idText.length === 0) throw new DagDeclarationError('node id must be a non-empty string')
    if (seen.has(idText)) throw new DagDeclarationError(`duplicate node id ${JSON.stringify(idText)}`)
    seen.add(idText)
    if (content.length === 0) throw new DagDeclarationError(`node ${JSON.stringify(idText)} content must be non-empty`)
    if (!/^\s*VALIDATION:\s*\S/im.test(brief) || !/^\s*ACCEPTANCE:\s*\S/im.test(brief)) {
      throw new DagDeclarationError(`node ${JSON.stringify(idText)} brief requires VALIDATION: and ACCEPTANCE: sections`)
    }
    const kind = input.kind ?? 'task'
    const policy: DagIntegrationPolicy = input.policy ?? 'delegate'
    if (kind === 'task' && input.policy !== undefined) {
      throw new DagDeclarationError(`node ${JSON.stringify(idText)} can use policy only when kind is integration`)
    }
    definitions.push({
      id: DagNodeId(idText),
      content,
      brief,
      deps: input.deps.map(dep => DagNodeId(dep.trim())),
      kind,
      policy,
      files: (input.files ?? []).map(value => filePath(value, idText)),
    })
  }
  const byId = new Map(definitions.map(node => [node.id, node]))
  for (const node of definitions) {
    const deps = new Set<string>()
    for (const dep of node.deps) {
      if (dep === node.id) throw new DagDeclarationError(`node ${JSON.stringify(node.id)} depends on itself`)
      if (deps.has(dep)) throw new DagDeclarationError(`node ${JSON.stringify(node.id)} repeats dependency ${JSON.stringify(dep)}`)
      deps.add(dep)
      if (!byId.has(dep)) throw new DagDeclarationError(`node ${JSON.stringify(node.id)} names missing dependency ${JSON.stringify(dep)}`)
    }
  }
  const indegree = new Map(definitions.map(node => [node.id, node.deps.length]))
  const dependents = new Map<NodeId, NodeId[]>()
  for (const node of definitions) {
    for (const dep of node.deps) {
      const rows = dependents.get(dep) ?? []
      rows.push(node.id)
      dependents.set(dep, rows)
    }
  }
  const queue = definitions.filter(node => node.deps.length === 0).map(node => node.id)
  const order: NodeId[] = []
  for (const id of queue) {
    order.push(id)
    for (const dependent of dependents.get(id) ?? []) {
      const degree = indegree.get(dependent)
      /* v8 ignore next -- dependents contains only identifiers copied from canonical definitions. */
      if (degree === undefined) throw new DagDeclarationError(`missing indegree for ${JSON.stringify(dependent)}`)
      const next = degree - 1
      indegree.set(dependent, next)
      if (next === 0) queue.push(dependent)
    }
  }
  if (order.length !== definitions.length) throw new DagDeclarationError('dependency graph must be acyclic')
  return { definitions, topologicalOrder: order }
}

/**
 * Confirm that an existing node repeats its immutable definition.
 * @param node - Existing durable node.
 * @param definition - Repeated candidate definition.
 * @returns Whether all immutable fields match.
 */
export function sameDefinition(node: DagNodeSnapshot, definition: DagNodeDefinition): boolean {
  return node.id === definition.id
    && node.content === definition.content
    && node.brief === definition.brief
    && node.kind === definition.kind
    && node.policy === definition.policy
    && node.deps.length === definition.deps.length
    && node.deps.every((value, index) => value === definition.deps[index])
    && node.files.length === definition.files.length
    && node.files.every((value, index) => value === definition.files[index])
}

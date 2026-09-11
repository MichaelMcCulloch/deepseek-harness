/** Pure declaration validation for native DAG state. */

import { posix, win32 } from 'node:path'
import { DagNodeId } from './ids.ts'
import type {
  DagIntegrationPolicy,
  DagNodeDefinition,
  DagNodeDefinitionField,
  DagNodeId as NodeId,
  DagNodeInput,
  DagNodeSnapshot,
  DagWriteResult,
} from './types.ts'

/** Stable declaration rejection. */
export class DagDeclarationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DagDeclarationError'
  }
}

/** One declared-file ownership violation along a dependency edge. */
export interface DagOwnershipViolation {
  readonly claimant: NodeId
  readonly dependency: NodeId
  readonly files: readonly string[]
}

/**
 * Existing durable nodes a declaration replaces.
 *
 * A resulting declared-file ownership violation is accepted when it repeats an
 * edge the durable graph already violated with at least those files; a new edge,
 * or a widened file set on a known edge, is refused. The declared rule is
 * multi-node while every repair the service exposes changes one node, so
 * refusing an untouched violation outright would leave an existing violating
 * graph unrepairable, and refusing a narrowed one would fix a repair order.
 * Omit the scope to refuse every violation.
 */
export interface DagDeclarationScope {
  readonly priorNodes?: readonly DagNodeSnapshot[]
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
 * @param scope - Durable nodes this declaration replaces; omitted for a complete declaration.
 * @returns Immutable definitions and topological order.
 */
export function validateDagDeclaration(
  inputs: readonly DagNodeInput[],
  scope: DagDeclarationScope = {},
): ValidatedDagDeclaration {
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
  const retained = scope.priorNodes === undefined ? [] : dependencyOwnershipViolations(scope.priorNodes)
  const rejected = dependencyOwnershipViolations(definitions).filter(row => !retainedViolation(retained, row))
  if (rejected.length > 0) throw new DagDeclarationError(ownershipViolationText(rejected))
  return { definitions, topologicalOrder: order }
}

/**
 * Return whether a resulting violation only repeats one the durable graph already had.
 * @param retained - Ownership violations the durable graph already carries.
 * @param row - Violation the candidate declaration would store.
 * @returns Whether the same edge already violated with at least these files.
 */
function retainedViolation(retained: readonly DagOwnershipViolation[], row: DagOwnershipViolation): boolean {
  return retained.some(prior => prior.claimant === row.claimant
    && prior.dependency === row.dependency
    && row.files.every(file => prior.files.includes(file)))
}

/** Render every rejected ownership violation in one diagnostic. */
function ownershipViolationText(violations: readonly DagOwnershipViolation[]): string {
  const rows = violations.map(row =>
    `node ${JSON.stringify(row.claimant)} claims files already owned by dependency ${JSON.stringify(row.dependency)}: ${row.files.join(', ')}`)
  const [first] = rows
  /* v8 ignore next -- the caller only renders a non-empty violation list. */
  if (first === undefined) throw new DagDeclarationError('declared-file ownership violations: none')
  return rows.length === 1 ? first : `declared-file ownership violations: ${rows.join('; ')}`
}

/**
 * Return every declared-file ownership violation along a dependency edge.
 *
 * A task worktree is prepared by merging every recorded dependency commit, so a
 * file claimed on both sides is contested ownership that the runtime refuses at
 * preparation. Reporting all of them together lets a caller plan the complete
 * repair instead of discovering it one node per attempt.
 * @param definitions - Canonical definitions with every dependency present.
 * @returns One row per violating claimant and dependency pair.
 */
export function dependencyOwnershipViolations(
  definitions: readonly DagNodeDefinition[],
): readonly DagOwnershipViolation[] {
  const byId = new Map(definitions.map(node => [node.id, node]))
  const violations: DagOwnershipViolation[] = []
  for (const node of definitions) {
    if (node.kind !== 'task' || node.files.length === 0) continue
    const visited = new Set<NodeId>()
    const pending = [...node.deps]
    while (pending.length > 0) {
      const depId = pending.pop()
      /* v8 ignore next -- the pending list only receives declared dependency identifiers. */
      if (depId === undefined || visited.has(depId)) continue
      visited.add(depId)
      const dep = byId.get(depId)
      /* v8 ignore next -- every dependency is present before this check runs. */
      if (dep === undefined) continue
      const shared = dep.files.filter(file => node.files.includes(file))
      if (shared.length > 0) violations.push({ claimant: node.id, dependency: depId, files: shared })
      pending.push(...dep.deps)
    }
  }
  return violations
}

/**
 * Drop dependencies that this declaration omits while the durable graph declared them.
 *
 * Dropping a node used to force every dependent to be dropped with it, because a
 * surviving row may not name a missing dependency. Rewriting those rows instead
 * keeps the dependents, their completed work, and their identity; the caller sees
 * every removal in the write result. A dependency name the graph never declared is
 * left alone so a typo still fails declaration validation.
 * @param inputs - Complete declaration rows from the caller.
 * @param known - Node ids the durable graph already declares.
 * @returns Rewritten rows and the dependents whose dependency lists changed.
 */
export function rewireOmittedDependencies(
  inputs: readonly DagNodeInput[],
  known: ReadonlySet<string>,
): { readonly inputs: readonly DagNodeInput[]; readonly rewired: readonly DagWriteResult['rewired'][number][] } {
  const declared = new Set(inputs.map(node => node.id.trim()))
  const rewired: DagWriteResult['rewired'][number][] = []
  const rewritten = inputs.map((node) => {
    const removed = node.deps.map(dep => dep.trim()).filter(dep => !declared.has(dep) && known.has(dep))
    if (removed.length === 0) return node
    rewired.push({ id: DagNodeId(node.id.trim()), removedDeps: removed.map(dep => DagNodeId(dep)) })
    return {
      ...node,
      deps: node.deps.filter(dep => !removed.includes(dep.trim())),
    }
  })
  return { inputs: rewritten, rewired }
}

/**
 * List the declaration fields that differ between one durable node and a candidate definition.
 * @param node - Existing durable node.
 * @param definition - Candidate declaration for the same node id.
 * @returns Changed fields in declaration order; empty when the two agree.
 */
export function changedDefinitionFields(
  node: DagNodeSnapshot,
  definition: DagNodeDefinition,
): readonly DagNodeDefinitionField[] {
  const fields: DagNodeDefinitionField[] = []
  if (node.content !== definition.content) fields.push('content')
  if (node.brief !== definition.brief) fields.push('brief')
  if (node.deps.length !== definition.deps.length
    || node.deps.some((value, index) => value !== definition.deps[index])) fields.push('deps')
  if (node.kind !== definition.kind) fields.push('kind')
  if (node.policy !== definition.policy) fields.push('policy')
  if (node.files.length !== definition.files.length
    || node.files.some((value, index) => value !== definition.files[index])) fields.push('files')
  return fields
}

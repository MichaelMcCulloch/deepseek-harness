/** The display short name of one package row, shared by store ordering and presentation copy. */

/**
 * Strip the scope and the harness prefix from a package name.
 * @param name - full npm package name.
 * @returns the name a row or sentence shows.
 */
export function shortName(name: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return unscoped.replace(/^dsh-(?:host-|client-)?/, '')
}

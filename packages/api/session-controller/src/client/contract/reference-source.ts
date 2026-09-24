/**
 * The source labels an independent Client reference carries. Consumers extend
 * {@link SessionReferenceSourceMap} through the package's canonical `/client`
 * entry; the sessions contract and the concrete client reference both name the
 * derived union, so it lives here rather than in either.
 */

/** Consumer-owned reference labels; extend this map through the package's canonical /client entry. */
export interface SessionReferenceSourceMap {
  /** Temporary Client Controller work, including fork-title preparation. */
  controllerOperation: unknown
  /** A Client Gateway invocation's synchronous Context ownership. */
  gateway: unknown
}

/** Declaration-merge-extensible labels carried by independent Client references. */
export type SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>

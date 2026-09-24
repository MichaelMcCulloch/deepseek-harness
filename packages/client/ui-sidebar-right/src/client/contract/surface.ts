/** Docking-surface vocabulary shared by the store and layout persistence. */
import type { History, LayoutState } from '@deepseek-ai/dsh-client-ui-dockkit'

/** One Session's docking surface: the layout, its sequence, and the id counter. */
export interface SurfaceState {
  readonly layout: LayoutState
  readonly history: History
  /** How many ids this surface has minted; carried so replay stays reproducible. */
  readonly minted: number
}

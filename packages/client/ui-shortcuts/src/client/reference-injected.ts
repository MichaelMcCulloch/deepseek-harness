/** The Reference overlay's injected face, shared with the inline editor it opens. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry, ShortcutPlatform, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'

/** Catalog and device labels delivered through renderer-bound hooks. */
export interface ReferenceInjected {
  platform: ShortcutPlatform
  runtime: Shortcuts['runtime']
  edit: Shortcuts['edit']
  recording: Shortcuts['recording']
  describeBinding: Shortcuts['describeBinding']
  hooks: { catalog: ObservableSnapshot<readonly ShortcutCatalogEntry[]>; config: Shortcuts['config']; fixedCatalog: Shortcuts['fixedCatalog'] }
}

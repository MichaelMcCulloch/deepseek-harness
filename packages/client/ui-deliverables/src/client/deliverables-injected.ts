/** The deliverables tail's injected face: summary reads, native-open callbacks, and shared gesture status. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChangesDiffStore } from './changes-diff.ts'
import type { ChangesSummaryStore } from './changes-summary.ts'
import type { PresentedOpenController } from './present-open.ts'
import type { ChangesReviewCoordinates } from '../changes.ts'

/** Summary reads, native-open callbacks, and shared gesture status supplied by the plugin. */
export interface DeliverablesInjected {
  hooks: {
    changesDiff: ObservableSnapshot<ReturnType<ChangesDiffStore['state']['getSnapshot']>>
    showCodeDiff: ObservableSnapshot<boolean>
    presentedOpen: ObservableSnapshot<ReturnType<PresentedOpenController['state']['getSnapshot']>>
    presentedHost: ObservableSnapshot<ReturnType<PresentedOpenController['host']['getSnapshot']>>
    changesSummary: ObservableSnapshot<ReturnType<ChangesSummaryStore['state']['getSnapshot']>>
  }
  reloadPresentedHost: PresentedOpenController['loadHost']
  loadChangesDiff: ChangesDiffStore['load']
  loadChangesSummary: ChangesSummaryStore['load']
  openPresented: PresentedOpenController['open']
  openChanged: PresentedOpenController['openChanged']
  /** Open one turn's review in the right Sidebar on the file at an index. */
  openChangesReview: (coordinates: ChangesReviewCoordinates, index: number) => void
}

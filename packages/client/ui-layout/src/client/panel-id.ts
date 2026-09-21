/** Panel identity as a leaf module: the layout store and the panel-action service both name it. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity shared by a sidebar panel entry and its main-slot occupant. */
export type MainPanelId = Branded<'MainPanelId'>

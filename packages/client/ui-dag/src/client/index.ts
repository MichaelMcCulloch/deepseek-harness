/** Browser plugin for the read-only native DAG dock. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-dag/client'
import { DagDock } from './DagDock.tsx'
import { en, zh, type DagKey } from './locales.ts'

export { DagBoard, DagDock } from './DagDock.tsx'
export type { DagBoardProps, DagDockProps } from './DagDock.tsx'
export type { DagKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Native DAG dock copy. */
    dag: DagKey
  }
}

/** Required client services for projection reading, locale, and dock registration. */
export const inject = ['slots', 'sessions', 'locale', 'uiConversation']

/** Register locale dictionaries and the order-15 read-only dock. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('dag', { zh, en }), 'ui-dag: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dag',
    order: 15,
    locale: 'dag',
  }, DagDock))
}

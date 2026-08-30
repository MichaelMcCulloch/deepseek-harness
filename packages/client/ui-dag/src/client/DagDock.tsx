/** Read-only expandable topological DAG dock. */

import type { DagNodeStatus, DagProjection } from '@deepseek-ai/dsh-dag/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DagKey } from './locales.ts'
import css from './DagDock.module.css'

/** Direct view props for the native DAG dock. */
export interface DagBoardProps extends PropsLocale<'dag'> {
  readonly dag: DagProjection | null | undefined
}

const STATUS_KEYS = {
  pending: 'pending',
  starting: 'starting',
  in_progress: 'in_progress',
  completed: 'completed',
  blocked: 'blocked',
  failed: 'failed',
  interrupted: 'interrupted',
} as const satisfies Record<DagNodeStatus, DagKey>

/** Render counts and an expandable topological node list. */
export function DagBoard({ dag, t }: DagBoardProps) {
  if (dag == null) return null
  const visibleCounts = (Object.keys(STATUS_KEYS) as DagNodeStatus[]).filter(status => dag.counts[status] > 0)
  return (
    <details className={css.dock} data-dag-dock>
      <summary className={css.summary} aria-label={t('nodes.show')}>
        <span className={css.title}>{t('title')}</span>
        <span className={css.counts}>
          {visibleCounts.map(status => <span key={status}>{t(STATUS_KEYS[status])}: {dag.counts[status]}</span>)}
          <span>{t('ready')}: {dag.readyNodeIds.length}</span>
        </span>
      </summary>
      <ol className={css.nodes}>
        {dag.nodes.map(node => (
          <li className={css.node} key={node.id} data-node-status={node.status}>
            <span className={css.content}>{node.id}: {node.content}</span>
            <span className={css.status}>{t(STATUS_KEYS[node.status])}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

/** Runtime props supplied by the conversation input-dock slot. */
export type DagDockProps = import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'conversation.input.dock'> & PropsLocale<'dag'>

/** Read the current DAG projection and hide before its first state event. */
export function DagDock({ useProjection, t }: DagDockProps) {
  return <DagBoard dag={useProjection('dag')} t={t} />
}

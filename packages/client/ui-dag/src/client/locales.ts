/** Locale dictionaries for the read-only DAG dock. */

/** Simplified Chinese dictionary and key source. */
export const zh = {
  title: '任务图',
  ready: '就绪',
  pending: '待处理',
  starting: '正在启动',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '受阻',
  failed: '失败',
  interrupted: '已中断',
  'nodes.show': '显示任务节点',
} satisfies Record<string, string>

/** Locale key union for the DAG dock. */
export type DagKey = keyof typeof zh

/** English dictionary. */
export const en = {
  title: 'Task Graph',
  ready: 'Ready',
  pending: 'Pending',
  starting: 'Starting',
  in_progress: 'In progress',
  completed: 'Completed',
  blocked: 'Blocked',
  failed: 'Failed',
  interrupted: 'Interrupted',
  'nodes.show': 'Show DAG nodes',
} satisfies Record<DagKey, string>

# 原生 DAG 编排

[English](dag.md) | 中文

原生 DAG 子系统通过可续跑子智能体和本地 Git worktree 执行已声明的依赖图。[`@deepseek-ai/dsh-dag`](../../packages/dag/dag) 负责持久状态、命令效果、恢复、通知和 Git 检查。[`@deepseek-ai/dsh-tool-dag`](../../packages/dag/tool-dag) 提供调度器工具和子节点工具。浏览器包显示只读面板。

## 持久状态

调度器会话日志是 DAG 状态的唯一来源。每个获准的变更都会追加一个完整且不可变的 `dag/state` 快照，格式版本为 `1`。第一次写入前，`dag` 会话投影为 `null`。此后，投影包含修订号、按拓扑排序的节点行、状态计数、就绪节点和开放 wave。浏览器投影不包含 worktree 绝对路径。

每个快照包含单调递增的修订号、图代数、操作计数器、完整节点面板、拓扑顺序、就绪节点列表、状态计数、wave、活动命令 id、操作回执和通知。每个节点还保存其代数、持久子会话 id、分支、worktree、冻结的 wave 基准、确切依赖提交、当前操作、结算信息和完成提交。

生产 reducer 是纯函数。独立参考 reducer 支持有界模型测试。服务调用读取当前修订号、归约命令，并在没有异步等待的情况下追加一个快照。可选的 `if_revision` 值提供比较并设置行为。陈旧值、嵌套追加或重入追加会以 `dag-revision-conflict` 失败。

## 节点生命周期

新节点从 `pending` 开始。主路径是从 `pending` 到 `starting`，然后到 `in_progress`，最后到 `completed`、`blocked`、`failed` 或 `interrupted`。阻塞或中断节点通过 `starting` 恢复。失败节点只能通过重新调度返回 `pending`。完成状态是终止状态。

停止操作先提交 `interrupted`，然后取消活动效果或子节点轮次。定向活动节点时，其状态保持为 `in_progress`；定向阻塞或中断节点时，其状态通过 `starting`。如果子节点轮次结束时没有调用 `dag_node_complete` 或 `dag_node_block`，则节点失败；已记录的停止或定向替换不会造成此失败。

当旧工作失效时，调度、重新调度、恢复、定向、停止和重置会递增节点代数。效果结果必须匹配持久绑定代数、节点代数、命令 id 和操作 id。陈旧结果不改变状态。

## 命令与效果

每个节点拥有一个持久 FIFO 邮箱。命令具有确定性 id，并从 `accepted` 变为 `running`，再变为 `settled`。每个节点有一个进程本地 pump 来运行邮箱。pump 标志只表示调度器状态；异步操作期间不会持有状态锁。

状态追加后，服务将会话刷新、Git 工作、子节点实体化、消息传递和生命周期发布安排为可取消效果。每个获准变更后都会发出 `dag/committed` Cordis 事件，其中包含调度器会话、修订号、图代数、原因和不可变快照。

会话重新打开时，服务折叠最新快照并重新启动已获准或正在运行的命令。确定性子节点 id 和消息 id 使子节点创建和消息传递可以安全重试。每次重试在改变状态前检查当前 Git 和子会话证据。

## 通知与等待

节点失败、阻塞、中断、wave 结算，以及开放 wave 之外的完成都会创建持久通知。通知 id 包含调度器会话命名空间、图代数、节点代数或 wave id，以及通知种类。传递使用 `Agent.inject`；它不会定向或唤醒调度器。

恢复过程针对每个通知 id 检查待处理 inbox 消息和已认领 inbox 会话事件。仅在没有匹配记录时重新注入通知。后续已传递通知存在时，`dag_wait` 会立即返回。否则，它为调度器会话注册一个可取消 waiter。服务先注入并记录通知，再解析该 waiter。

## 由所有者控制的子智能体

DAG 子节点是可续跑子智能体，具有绝对 worktree `cwd`、持久 JSON 所有者元数据，且通用结算传递设为 `none`。子智能体服务仍然执行授权。授权后，效果范围内的 DAG 所有者控制器处理停止、重定向和轮次结算。

`Agent.steer` 保持非中断行为。`Agent.redirect` 取消活动轮次并保留 inbox，将替换工作放在已排队普通轮次之前，然后唤醒智能体。该服务通过 `SubagentRuntime.followup()` 投递节点提示词，在子级尚不可恢复时回退到 `SubagentRuntime.startContinuable()`，并通过 `SubagentRuntime.redirect()` 替换活动工作；每次投递都携带确定性的消息 id。`steer_agent` 模型工具与 `subagent.steer` Remote 操作使用相同的替换行为。

## 本地 Git 执行

服务只通过 `ctx.subprocess` 运行 Git，使用确切参数数组且不使用 shell。它不读取 remote、不调用 GitLab 工具、不推送分支，也不创建 issue 或 merge request。Worktree 存储在 `<DSH_HOME>/dag/worktrees/v1/` 下；分支使用 `dsh/dag/` 命名空间。

调度 wave 打开前，一个 porcelain-v2 探针要求根 worktree 干净、位于符号本地分支，并具有有效本地 HEAD。Wave 冻结该分支和提交。每个节点 worktree 从冻结提交开始。依赖合并按照声明顺序使用确切的已记录完成提交，而不使用分支 tip。

任务完成要求预期分支、无活动合并、worktree 干净、HEAD 已改变，并且每个已记录依赖提交都是祖先。服务记录该确切 HEAD。任务节点必须将变更限制在其已声明文件内。集成节点使用已声明的 `ours`、`theirs` 或 `delegate` 策略。Delegate 模式记录确切提交和冲突，取消自动冲突合并，并将手动集成任务交给子节点。

重置仅适用于待处理或失败节点。它接受冻结的 wave 基准、确切提交 id 或显式本地 `refs/heads/*` ref。它拒绝远程 ref 和歧义名称。它中止活动合并、硬重置已跟踪状态、保留未跟踪文件，并报告剩余脏状态。服务不会删除旧分支、worktree 或子会话。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdag--dagservice"></a>

### `ctx.dag` — `DagService`

Native DAG service backed only by complete session-log state values.

```ts cordis-catalog
/**
 * Return the latest durable state for one dispatcher.
 * @param agent - Live dispatcher agent.
 * @returns Latest state, or null before the first write.
 */
state(agent: Agent): DagState | null

/**
 * Return the complete dispatcher board.
 * @param agent - Live dispatcher agent.
 * @returns Safe board projection, or null before the first write.
 */
status(agent: Agent): DagProjection | null

/**
 * Return one node card, including dispatcher-only local execution facts.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Node to inspect.
 * @returns Complete durable node card.
 */
inspect(agent: Agent, nodeId: DagNodeId): DagNodeSnapshot

/**
 * Return topology and execution facts for the exact owner-bound child.
 * @param child - Live DAG child agent.
 * @returns Topology and the child's safe node facts.
 */
statusFrom(child: Agent): { readonly revision: number readonly topology: readonly { readonly id: DagNodeId; readonly deps: readonly DagNodeId[]; readonly status: DagNodeSnapshot['status'] }[] readonly own: DagProjection['nodes'][number] }

/**
 * Replace the declaration after canonical validation.
 * @param agent - Live dispatcher agent.
 * @param request - Full node declaration and optional revision guard.
 * @returns Accepted write receipt, preserved artifacts, and advisory conflicts.
 */
write(agent: Agent, request: DagWriteRequest): DagWriteResult

/**
 * Start dependency-ready pending nodes without waiting for effects.
 * @param agent - Live dispatcher agent.
 * @param nodeIds - Pending nodes to start.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
dispatch(agent: Agent, nodeIds: readonly DagNodeId[], guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Re-enter a failed node with its durable child identity.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Failed node to dispatch again.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
redispatch(agent: Agent, nodeId: DagNodeId, guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Resume a blocked or interrupted node.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Suspended node to resume.
 * @param message - New work message for the child.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
resume(agent: Agent, nodeId: DagNodeId, message: string, guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Replace a node's active work, or restart a suspended node.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Node to steer.
 * @param message - Replacement work message.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
steer(agent: Agent, nodeId: DagNodeId, message: string, guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Reset tracked worktree state to one allowed local target.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Pending or failed node to reset.
 * @param target - Frozen base, exact commit, or local branch ref.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
reset(agent: Agent, nodeId: DagNodeId, target: string, guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Mark the calling DAG child blocked.
 * @param child - Live DAG child agent.
 * @param reason - Reason that work cannot continue.
 * @returns Accepted command receipt.
 */
blockFrom(child: Agent, reason: string): DagCommandAccepted

/**
 * Request completion validation for the calling DAG child.
 * @param child - Live DAG child agent.
 * @param summary - Result summary for the dispatcher.
 * @param artifacts - Optional JSON result records.
 * @returns Accepted command receipt.
 */
completeFrom(child: Agent, summary: string, artifacts: readonly JsonValue[] = []): DagCommandAccepted

/**
 * Wait for an injected actionable notice after one revision.
 * @param agent - Live dispatcher agent.
 * @param afterRevision - Last revision already handled by the caller.
 * @param signal - Cancellation signal for this wait.
 * @returns First available later notice and current safe board.
 */
wait(agent: Agent, afterRevision: number, signal: AbortSignal): Promise<DagWaitResult>

/**
 * Commit one authorized owner stop and then cancel the child turn.
 * @param request - Authorized owner stop request.
 */
stop(request: SubagentOwnerStopRequest): void

/**
 * Commit a dispatcher stop without waiting for cancellation.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Active or blocked node to stop.
 * @param reason - Optional interruption reason.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
stop(agent: Agent, nodeId: DagNodeId, reason?: string, guard?: DagRevisionGuard): DagCommandAccepted

/**
 * Commit one authorized redirect and then replace the child turn.
 * @param request - Authorized owner redirect request.
 */
redirect(request: SubagentOwnerRedirectRequest): Promise<void>

/**
 * Convert an unreported owner-child turn end to failure.
 * @param settlement - Authorized child turn settlement.
 */
settled(settlement: SubagentOwnerSettlement): void

/**
 * Fail one current child turn that ended without a final DAG report.
 * @param settlement - Authorized ordinary-turn settlement facts.
 */
turnSettled(settlement: SubagentOwnerTurnSettlement): void
```

Types: [Agent](core.zh.md) · [SubagentOwnerRedirectRequest](subagent.zh.md) · [SubagentOwnerSettlement](subagent.zh.md) · [SubagentOwnerStopRequest](subagent.zh.md) · [SubagentOwnerTurnSettlement](subagent.zh.md)

Source: [`packages/dag/dag/src/index.ts`](../../packages/dag/dag/src/index.ts)

<a id="dag-events"></a>

### `dag/*` events

<a id="dagcommitted--emit"></a>

#### `dag/committed` — emit

A complete DAG state value was appended to the dispatcher session.

```ts cordis-catalog
/**
 * A complete DAG state value was appended to the dispatcher session.
 * @param payload.agent - exact live dispatcher Agent.
 * @param payload.committed - immutable committed state facts.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that dispatcher.
 * @mode emit
 */
'dag/committed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { readonly agent: Agent; readonly committed: DagCommitted }): void
```

Types: [Agent](core.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/dag/dag/src/index.ts`](../../packages/dag/dag/src/index.ts)
<!-- END GENERATED cordis-surface -->

# Agent Note：事件溯源的原生 DAG 编排

状态：已实现

[English](2026-08-29-event-sourced-native-dag-orchestrator.md) | 中文

## 问题

按依赖排序的 agent 工作需要一份持久记录，统一说明图声明、节点生命周期、并发启动、重启恢复、本地 Git 隔离与完成证据。只存在于模型中的计划不能承担此职责：工具调用历史不能证明异步 effect 已运行，进程本地 promise chain 也不能在会话重新打开后重建已接受工作。

通用 subagent 管理器拥有子级授权与续行，但不拥有依赖图、逐节点 Git worktree、wave settlement 或图专用通知。用图调度器替换它会重复授权、冷恢复与非 DAG 续行行为。远程仓库自动化也不属于本调度器：图正确性不能依赖 remote、provider CLI、push、issue 或 merge-request API。

## 决策

### 完整状态快照是持久权威

`@deepseek-ai/dsh-dag` 在调度器会话的每个 `dag/state` 事件中保存一份完整且不可变的版本 1 状态值。快照包含 revision、graph generation、operation counter、完整节点面板、拓扑顺序、就绪列表、状态计数、wave、持久命令 mailbox、operation receipt 与通知。会话日志是唯一持久权威；第一次状态前 `dag` projection 为 `null`，之后派生浏览器安全的当前视图。

生产 reducer 与独立 reference reducer 都是纯函数。服务命令读取当前 revision、同步 reduce，并在没有 `await` 的情况下追加一份完整快照。可选 `if_revision` 执行比较并设置。陈旧 revision、嵌套 append 或竞争的重入 commit 返回 `dag-revision-conflict`；它不等待状态锁。类型化 `dag/state` 事件加入已知 session-event vocabulary，但不改变结构化会话格式，因此不认识该事件的构建会拒绝它，而不是误读快照。

节点生命周期是 `pending → starting → in_progress → completed | blocked | failed | interrupted`。blocked 与 interrupted 节点通过 starting resume，failed 节点只能通过 redispatch 回到 pending，completed 是终态。stop 在取消 effect 或子级前提交 interrupted。每个使早期工作失效的操作都会推进节点 generation。每个 effect 结果必须匹配 binding generation、节点 generation 与 operation id，因此陈旧回调对状态没有影响。

### 持久 mailbox 拥有异步工作

每个节点快照包含 FIFO mailbox，命令状态为 accepted、running 或 settled。每节点一个进程本地 pump 在状态 append 后执行 Git 工作、子级物化、消息投递、持久化 flush 与生命周期发布。pump 标志只是调度状态；没有状态锁跨越 `await`。

session-start reconciliation 检查 accepted 和 running 命令，并在重试前检查本地 Git 与子会话证据。child id、message id、command id 与 notice id 都是确定性的，因此重复物化与投递具有幂等性。每次 append 被接受后，非阻塞 `dag/committed` Cordis 事件发布 dispatcher session、revision、graph generation、cause 与不可变快照。

通知记录节点失败、阻塞、中断、在开放 wave 外完成，以及 wave settlement。投递只使用 `Agent.inject`。reconciliation 在重新注入前检查 pending inbox 条目与已 claim 的 inbox session event。`dag_wait` 返回已存在的较新可操作通知，或为调度器会话安装一个可取消 waiter。通知注入与记录先于 waiter resolve。

### 本地 Git 提供执行证据

所有 Git 操作都通过 subprocess capability 使用精确参数数组，不使用 shell。dispatch wave 先提交 starting 意图，再执行一次 porcelain-v2 probe，要求根目录 tracked 与 untracked 状态干净、位于符号本地分支并具有有效本地 HEAD。只有 probe 成功后服务才创建 wave，并只冻结一次根分支与 HEAD。

节点分支与 worktree 位于 `<DSH_HOME>/dag/worktrees/v1/` 下，从冻结 wave HEAD 开始。依赖按声明顺序用已记录的精确完成 commit merge，绝不使用分支 tip。任务完成要求符合预期的符号分支、没有活跃 merge、worktree 干净、HEAD 已变化、每个已记录依赖 commit 都是 ancestor，并满足声明文件归属。integration 节点应用 `ours`、`theirs` 或 delegated conflict resolution。reset 只接受冻结 base、精确 commit id 或显式本地 `refs/heads/*` ref，并保留 untracked 文件。运行时代码不检查 remote、不 fetch、不 push，也不创建远程工作项。

### Subagent 服务保留授权

可续行子级创建接受绝对 `cwd`、持久 JSON owner metadata 与 `settlementDelivery: adaptive | quiet | none`。通用子级保留[可继续生命周期](../feature/2026-07-28-continuable-subagent-conversations.zh.md)和 [adaptive settlement 行为](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)。DAG 子级使用其 worktree 作为 `cwd`，携带版本化 DAG owner 记录，并选择 `none`，因为图通知由调度器状态拥有。

effect-scoped owner-controller registry 保留在 subagent 服务中。服务应用[通用控制授权](../feature/2026-08-06-continuable-subagent-interrupt.zh.md)后，DAG-owned 子级的 stop、redirect 与子级轮次 settlement 委派给 `DagService`。`Agent.redirect` 取消活跃轮次并保留 inbox 状态，把一个替换普通轮次放在已排队普通轮次之前，然后唤醒 agent。`Agent.steer` 仍是非中断式 next-step 操作。Web Stop、`interrupt_agent` 与 `dag_node_stop` 到达同一个 DAG stop transition；Web steering、`steer_agent` 与 `dag_node_steer` 到达同一个 DAG steer transition。

调度器接收完整安全面板与十个命令工具。受 owner 约束的子级只接收其拓扑、依赖状态、执行事实，以及 complete 或 block 工具。变更工具返回 command acceptance、revision 与 operation id，不等待 effect。调度器提示词要求使用 `dag_wait`，而不是轮询状态。只读 Web dock 在第一次声明后显示计数与拓扑行，不暴露绝对 worktree 路径。

## 测试

Reducer 模型在含并行 root、fan-out、fan-in、integration 与 tail 节点的有界图上枚举命令、effect 结果、陈旧回调、重启点、redispatch、resume、steer 与 stop。它比较生产和 reference replay，并检查依赖准入、合法 transition、单个活跃 operation、陈旧结果 fencing、单次通知与 wave settlement、stop 的 interrupted 结果、Git-gated 完成、DAG settlement 隔离，以及 notice-before-wait 顺序。

Barrier 测试覆盖竞争命令对与重启历史。没有 remote 的真实本地仓库覆盖 dirty 和 detached root、并发 worktree 创建、精确依赖 fan-in、文件归属、所有 integration policy、conflict、reset、cancellation、陈旧 effect，以及新 HEAD 上的干净完成。Subagent、projection、tool、composition、locale、Web、generated-catalog 与 recorded-session 测试覆盖其他集成路径。

## 考虑过的替代方案

**把图状态保存在 sidecar 数据库中，或每个字段变更使用一个事件。** 否决。第二个存储会在会话与图数据之间创建恢复顺序。细粒度事件使 replay 依赖更大的 transition vocabulary，并使不完整命令更难检查。完整快照让每个已接受 revision 具有一个自包含权威。

**在异步 effect 期间持有 mutex 或 promise-chain lock。** 否决。工具命令必须在持久 acceptance 后返回，而跨越 Git 或子级工作的锁会阻止立即 stop 与 steer 命令。同步 reduction 加 generation fence 可以序列化状态，而不把外部 effect 纳入 commit。

**替换通用可续行 subagent 管理器。** 否决。授权、冷恢复、one-shot 子级与普通可续行 settlement 仍是通用职责。owner-controller 扩展只添加 DAG 子级所需的控制与 metadata。

**为 DAG 子级使用通用 settlement follow-up 或 steering。** 否决。通用投递可以独立于图状态唤醒或 redirect 调度器，也可能在重启后重复投递。`settlementDelivery: none` 加持久 DAG 通知提供一条幂等路径。

**使用分支 tip 或远程 merge request 作为依赖证据。** 否决。分支可以在完成后移动，且本地调度不需要远程状态。精确记录的 commit 使依赖输入不可变，并可在没有 remote 的仓库中测试。

## 结果

调度器可以在早期 effect 运行时接受图命令，在会话重新打开后恢复这些 effect，并忽略 generation fence 陈旧的每个晚到结果。一条 session event 显示完整当前状态，而浏览器接收较小 projection，模型只通过显式工具与持久通知接收状态。

DAG 工作创建持久本地分支、worktree 与子会话。服务绝不自动删除它们，因此清理仍是显式 operator 操作。完成证明本地 Git 事实与声明归属，不证明语义正确性。图变更通过一个 harness 进程内的 live 调度器 Agent 进行，该会话日志的第二个写入者会被[会话写入 lease](../feature/2026-08-31-cross-process-session-write-lease.zh.md)拒绝，而不会共享同一张图。

Todo 功能保持独立，通用 one-shot 与可续行 subagent 保持既有行为。

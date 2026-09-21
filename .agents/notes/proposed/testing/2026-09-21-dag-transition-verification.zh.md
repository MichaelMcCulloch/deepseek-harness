# Agent Note: 验证每一次 DAG 状态转换都留下合法状态

Status: proposed

[English](2026-09-21-dag-transition-verification.md) | 中文

## 问题

原生 DAG 编排器（[事件溯源编排器决策](../../implemented/architecture/2026-08-29-event-sourced-native-dag-orchestrator.zh.md)）把全部状态放在每次被接受变更对应的一条持久会话事件里：`dag/state` 携带完整的 `DagState` 快照（`packages/dag/dag/src/types.ts:138-153`）。每一次被接受的状态转换都是 `DagService.mutate`（`packages/dag/dag/src/index.ts:730-757`）中一次同步的读取-reduce-追加，恢复则折叠持久前缀，并从找到的快照重新运行每个未结算的 mailbox 命令。只有当每一次被接受的状态转换都产生满足流不变量的状态时，这个设计才成立，而今天已发布产品中没有任何东西检查这一点。

本笔记回答的问题是：要验证每一次 DAG 状态转换都留下合法状态，需要做什么。状态转换通过三种途径进入系统：

1. **agent 调用面向模型的工具** —— `dag_write`、`dag_node_amend`、`dag_dispatch`、`dag_node_redispatch`、`dag_node_resume`、`dag_node_steer`、`dag_node_stop`、`dag_node_reset`，以及 DAG 所属子级调用的 `dag_node_complete` 与 `dag_node_block`。
2. **用户介入** —— Web Stop、`interrupt_agent` 与 `subagent.interrupt` 到达 `DagService.ownerStop`；Web steering、`steer_agent` 与 `subagent.steer` 到达 `DagService.redirect`；子级轮次结束与 activation settlement 到达 `turnSettled` 与 `settled`。人类驱动的 agent 调用同一批工具会到达完全相同的 reducer 命令。
3. **进程死亡后重新打开** —— 崩溃、断电或 SIGKILL，包括一个 effect 内两次 await 之间，以及一次状态追加与其 fsync 之间。

三种来源的覆盖程度不同，差别不在 reducer。工具调用与 owner 钩子收敛到同一套由 reducer 守卫的转换集。未被验证的是它外围的服务层、持久决策与外部 effect 不一致的接缝，以及持久性边界本身。本笔记记录状态模型、当前已检查的内容、分析得出的三个缺陷、验证选项及其真实成本，以及建设顺序。

## 提案

在状态转换实际运行的地方验证它，而不是在它的第二份模型中验证。具体来说：挂载已经存在的不变量，为可执行模型测试补上拒绝 oracle，用仓库已有的 `fast-check` 依赖加入基于属性的序列测试，并在真实 JSONL 追加路径上构建崩溃注入套件，把下文三个缺陷作为预期失败纳入其中。

按单位工作量价值排序；步骤 1-3 成本低且先落地，步骤 4 是发现新缺陷的那一步。

1. **在可选的诊断组合中挂载不变量（半天）。** 把 `@deepseek-ai/dsh-dag/invariant` 加进一个仅测试用的 `cordis.yml`，通过 Loader 启动它，并驱动一个完整节点生命周期。不要改动 `dsh-base`。
2. **为模型测试补上拒绝 oracle（一天）。** 对广度优先搜索出队的每个状态，生成被改动守卫的命令，并断言要么得到精确的 `DagStateError.code`，要么得到返回同一对象的空操作。
3. **加入基于属性的序列测试，并让差分 oracle 诚实（一至两天）。** 生成不做前置条件过滤的命令序列，断言只有 `DagStateError` 会逸出、每个被接受的状态都通过 `validateDagState`、reference reducer 结果一致，以及从 `null` 回放被接受的子序列能复现该状态。在单独的提交中，停止比较生产 reducer 与 reference reducer 之间的 `commandId` 与 `commandState`，使 identity 格式的回归无法靠共同约定通过。
4. **构建崩溃注入套件（三至四天）。** 第 1 层在进程内且确定性：让真实服务对接真实 JSONL 根目录，通过不 flush 就 dispose、把产物截断到指定字节偏移，以及在两步撕裂尾部修复之间中止来模拟崩溃；在每次重新打开时断言折叠结果满足 `validateDagState`，且 `reconcile` 把每个未结算的 mailbox 命令推进到终态。第 2 层把现有的进程外 SIGKILL fixture 推广为按字节计数触发终止的脚本化 DAG 序列。
5. **修复测试钉住的缺陷（三至四天）。** 在 `git.prepare` 运行前持久记录合并前的 HEAD，或从冻结 wave base 与依赖 commit 图推导它；为已存在但未注册的 worktree 路径加入显式修复转换；把恢复的撕裂尾部与其截断合并为一次持久步骤。每个修复都是设计变更，需要各自的 Agent Note。
6. **关闭退出路径缺口（一天）。** 把 `settlement.stop()` 移入 `finally`，决定抛异常的 owner 控制器对子级做什么，并补上缺失的测试：真实 Activation 驱动 `DagService.ownerStop`、抛异常的 owner 控制器，以及子级 settlement 与挂起中的 redirect 竞争。

`fast-check@^4.8.0` 已经是根 devDependency（`package.json:222`），因此步骤 3 不引入新依赖。新测试文件放在 `packages/dag/dag/tests/model-property.spec.ts` 或 `packages/dag/dag/tests/crash-recovery.spec.ts` 即可运行：根 vitest 的 `include` 是 `packages/*/*/tests/**/*.spec.{ts,tsx}`（`vitest.config.ts:123-128`），因此 `pnpm run test` 与 `ci-primary` 中的 `test:coverage` 门禁会自动收集它，无需注册。进程外套件使用 `.e2e.ts`（`vitest.e2e.config.ts:45`，由 `pnpm run test:e2e` 运行），从而保持可选。必须在 `ci-primary` 中单独把关的崩溃恢复套件，在 `scripts/run-gates.ts` 中与现有覆盖率门禁并列新增一个具名门禁。

## 状态模型与当前检查的内容

`dag/state` 通过模块增强声明并加入已知会话事件词汇；它不携带 `ignorable: true`，因此不认识该事件的构建会拒绝整个日志，而不是误读快照。该事件只有一个读取方 `latestState`（`packages/dag/dag/src/index.ts:1379-1386`）：它反向扫描会话快照取最后一条 `dag/state`，不存在进程本地镜像。`DagService.mutate`（`index.ts:730-757`）读取该快照，调用 `reduceDagState`（`packages/dag/dag/src/reducer.ts:432`），当 reducer 返回同一对象时原样返回（`index.ts:733`），否则在一个没有 `await` 的同步块内追加新快照（`index.ts:737`）。

节点字段中有一部分是权威值，另一部分是派生值。`counts`、`readyNodeIds` 与 `activeCommandIds` 由 `completeState` 在每次被接受的命令上重新计算。`settlement`、`currentOperationId` 与 `dependencyCommits` 可从其他字段推导，但被存储下来，不变量把它们当作权威值，只检查格式与单调性。

今天有四层检查，它们覆盖的范围并不相同：

- **reducer 前置条件。** `reduceDagState` 对在当前状态下非法的命令抛出带稳定 `code` 的 `DagStateError`。这些是守卫——「这条命令合法」——而不是关于结果的后置条件。
- **声明校验。** `validateDagDeclaration`（`packages/dag/dag/src/validation.ts:73-142`）强制非空 id 与 content、每份 brief 中的 `VALIDATION:`/`ACCEPTANCE:`、依赖存在与无环、声明文件归属，以及路径规范化。服务在 `write` 与 `amend` 中调用它；reducer 不调用它，而 `reduceDagState` 是导出的。
- **流不变量。** `validateDagState(previous, state)`（`packages/dag/dag/src/invariant.ts:78-376`）是大约八十项检查，覆盖从一个快照到下一个快照的这一步：revision 与 graph generation 运算、合法状态边、generation 与 binding generation 增量、mailbox 历史不可缩短或改写、`completedCommit` 不可变、依赖 commit 与所声明依赖列表一致、每节点至多一条活跃命令、活跃命令的 fence 与节点一致、拓扑与依赖顺序一致、重新推导的计数与就绪集合、receipt 序列、通知不可变，以及 wave identity。
- **服务层断言。** `assertLive`、带重入守卫的 `assertRevision`、`requireCurrentCommand`、`assertBinding` 与 `assertCurrentChildTurn` 为每个入口与每个 effect 结果设置 fence。

关于这份覆盖，有两个事实比检查数量更重要：

- **`validateDagState` 只在 `vitest` 中运行。** `invariant.spec.ts` 与 `invariant-edge.spec.ts` 直接检验它，`model.spec.ts` 在每一步被接受的转换上调用它，但该包以 `./invariant` 发布它，而 `packages/bundle/base/cordis.patch.yml:305` 挂载 `@deepseek-ai/dsh-dag` 时不带任何 companion；`packages/bundle/sdk-minimal/cordis.patch.yml:109-119` 是唯一列出 invariant companion 的组合，列出的是 session、agent、scope 与 agent-loop，不含 dag。`dsh-base` 刻意省略运行时诊断（`packages/runtime-diagnostics/invariants/README.md`），因此修法是可选组合，而不是改动已发布默认值。
- **有八项关系只是意图，任何地方都没有检查。** 节点的 `waveId` 从不与 `state.waves` 交叉引用；wave 槽位归属从不与节点状态比较；`settlement` 只在 `completed` 情形下与 `status` 比较；`branch`、`worktree`、`childSessionId`、`waveId`、`frozenWaveBase`、`dependencyCommits`、`preparedFrom` 与 `preparedHead` 没有跨快照的不可变性检查；`notice.nodeId` 与 `notice.waveId` 没有与已知节点和 wave 比对；wave 槽位顺序只按集合检查；传给 `mutate` 的 `cause` 字符串既不持久也不校验；也没有代码断言最后一个持久快照在 revision 上是服务已确认 revision 的祖先。前两项由 `settleWaves` 在构造上维持，因此它们是缺失的检查，而不是已知缺陷。

不变量中没有任何东西读取 Git、文件系统、子会话或收件箱。关于这些的每一项主张都由服务及其测试承担。

## 三种状态转换来源

### agent 工具调用

十一个调度器工具与三个子级作用域工具解析各自的 agent，把它交给服务方法，并在追加后返回。两次调度器工具调用无法在 `mutate` 内交错，因为工具的 `execute` 会同步执行到底。`if_revision` 是建议性的比较并设置，不是正确性的必要条件。

有三个假设支撑这条路径。`reduceDagState` 信任调用方保证声明合法，因此持有服务的进程内调用方可以绕过 `validateDagDeclaration` 直接到达 reducer。调度器工具集由工具层的 `tools.restrict`（`packages/dag/tool-dag/src/child.ts:19`）拒绝给 DAG 所属子级，而不是由服务拒绝，因此另一个进程内调用方可以绕过它。子级的 `dag_node_complete` 关于「为什么完成」的说法被信任；`DagGit.validateCompletion` 中的 Git 检查是唯一兜底，而下文第一个缺陷削弱了它。

### 用户介入

授权发生在 subagent 服务上游：祖先必须是那个确切的活跃 agent，`user` authority 必须指明子级的父会话。`DagService` 重新检查活跃性与持久 binding，但不重新检查授权，这是正确的，因为它只会收到已授权的请求。到达的是同一批 reducer 命令，唯一差别是 reason 字符串。

这条接缝上有两条失败路径会让持久节点与子级轮次互相不一致。`ContinuableActivationRegistry.interrupt` 在目标会话不驻留时立即返回（`packages/subagent/subagent/src/continuation-activation.ts:348`），早于 owner 分支，因此对不驻留子级的用户 Stop 不会产生任何 DAG 状态转换，而持久节点仍停在 `starting` 或 `in_progress`。owner 控制器调用也没有 `try`/`catch`（`continuation-activation.ts:375-380`）：如果 `DagService.ownerStop` 抛异常，`request.stop()` 就不会执行，子级轮次会在用户以为已停止的节点上继续运行。`turnSettled` 与 `settled` 有镜像问题——它们由记录日志后继续的会话观察者路径调用，因此其中的 DAG 追加失败不可见，节点会带着活跃命令停在 `in_progress`，直到另一次状态转换或重新打开推动它。

`redirect` 是唯一的异步 owner 钩子。当它挂起在「接纳替换消息之前」的持久化 flush 上时，子级轮次可能结束并运行 `turnSettled`，因为 redirect 持有的锁与 settlement 观察者都不串行化二者。可达结果是合法状态——要么陈旧分支不改状态直接返回，要么节点失败且这次 steer 报告 fence 错误——因此这是未建模交错中的活性缺口，而不是合法性缺口。

### 进程死亡与重新打开

`Session.append` 是内存操作：它先把事件推入会话日志，再分发 `session/event`（`packages/core/session/src/index.ts:756-759`），其自身文档也说明热路径从不阻塞在 I/O 上。持久性是单独的、被 await 的步骤。JSONL 后端缓冲实时事件，并在 200 毫秒定时器或 `session/flush` 时排空（`packages/session/session-persistence-jsonl/src/storage.ts:36`）；落地的批次是全有或全无：`appendLines` 先写入再 fsync，写入或 sync 失败会截断回追加前的大小、重新 fsync，然后重新抛出。

每个外部 effect 都在其命令持久之后运行：`pump` 追加 `command-running` 后 flush（`packages/dag/dag/src/index.ts:819`），`prepareAndStart` 在 `git-prepared` 之后 flush（`index.ts:977`），`ensureWave` 在 `wave-probed` 之后 flush（`index.ts:1025`），`deliverOwnerRedirect` 在接纳替换消息之前 flush（`packages/dag/dag/src/index.ts:627`）。`ctx.sessions.flush` 返回的是「是否至少有一个持久性监听者参与」（`packages/core/session/src/index.ts:1205-1235`），它之所以是真实屏障，是因为 agent loop 的已存储会话持有 JSONL 写句柄；这是 agent loop 的性质，不是 `flush` 的性质。

由于每份快照都是完整的、revision 是连续的，被接受 revision 序列的任何持久前缀本身就是合法的 DAG 状态。正是这个性质让崩溃恢复可行，而它成立的条件恰恰是每一次被接受的状态转换都满足 `validateDagState`。重新打开时，构造函数调度 `reconcile`，后者调度 pump 并投递通知；pump 为每个节点取最旧的未结算 mailbox 行，从头重放整个 effect，重新读取 Git 与子级状态，而不是信任已记录事实。重放是幂等的，因为每个标识符都是确定性的：命令 id、子会话 id、`MessageId(`${command.id}-message`)` 与通知 id。

这一层有两个假设未经验证。恢复后的尾部不会被重新推导：没有任何东西断言从被修复日志折叠出的状态等于崩溃前重新打开已经提供过的状态。子会话日志与调度器会话日志是两个文件，没有跨文件原子性；两者的不一致被期望由 reconciliation 修复。

## 现有模型测试覆盖的内容

`packages/dag/dag/src/reference-reducer.ts` 是外部可见调度器状态的小型独立模型：revision、graph generation、operation counter，以及每节点的 id、依赖、状态、generation、binding generation、operation id、command id 与状态、完成 commit。`referenceReduceDagState` 不调用生产代码地重新实现转换关系，`abstractDagState` 把生产 `DagState` 投影进这套词汇。独立性是部分的：reference 逐字复现生产的 id 格式，`abstractDagState` 复制生产 command id，因此这些字段是作为共同约定而非独立推导值被比较的。这种比较在状态、generation 与 operation 语义上很强，在 identity 上很弱。

`packages/dag/dag/tests/model.spec.ts:466-522` 是固定六节点图上的广度优先显式状态搜索，图中含并行 root、fan-out、fan-in、integration 节点与 tail 节点。它按语义键合并状态，探索上限为 25 000 个语义状态，每条被探索的历史允许注入一个故障，每个节点允许一次 resume 或 steer。每走一步被接受的转换后，它运行完整的 `validateDagState`（`:493`）与对 reference 的差分比较（`:494`）；对每个出队状态，它从 `null` 重新 reduce 整段历史并比较，还把每个节点最后一条命令的 binding generation 扰动加一，要求返回同一个对象。活性断言要求每个节点到达 `completed`、动作标签覆盖 18 个具名动作、访问状态超过 1 000 个，且陈旧回调探测次数多于访问状态数。

搜索无法到达的部分：

1. **拒绝。** 动作生成器只发出它已判定为合法的命令，因此 reducer 静默接受的非法命令不可达，每个拒绝都由手写用例覆盖。
2. **服务层。** 它直接驱动 `reduceDagState`，从不运行 `mutate`、`assertRevision`、重入守卫、effect 取消、`pump`、`reconcile` 或任何 owner 钩子。
3. **持久性。** 它不接触会话日志、fsync 边界或撕裂记录；重启断言只是纯 reducer 回放。
4. **Git。** effect 证据由节点自身 binding 合成，因此 `startEvidenceMatches` 只在同意分支上被检验，所有真实 Git 规则都不可见。
5. **子级与收件箱事实。** 消息去重、通知去重、子级轮次断言与 owner 接缝都未建模。
6. **被合并的状态。** 语义键省略 `preparedFrom`、`dependencyCommits`、`conflictedFiles`、`completedCommit`、receipt 日志、通知表、settlement summary 与拓扑顺序，因此只在这些字段上不同的两个状态被当作一个来探索。
7. **多重故障。** 故障预算为一时，只有两次 effect 失败后才可达的状态不会被访问。

一次绿色运行是关于 `reduceDagState` 的证据，与其余部分无关。

## 发现的缺陷

### `preparedFrom` 窗口击败空操作完成守卫

`DagGit.prepare` 在 `packages/dag/dag/src/git.ts:135` 捕获 `currentHead`，早于 `:157` 的依赖合并循环，并在 `:178` 把它作为 `preparedFrom` 返回。只要持久节点没有 `preparedHead`，`prepareAndStart` 就重新运行 `prepare`——而绝不运行 `verifyPrepared`（`packages/dag/dag/src/index.ts:941`），记录结果的 `git-prepared` 追加发生得更晚（`index.ts:959`，flush 在 `:977`）。

该窗口内任意位置的崩溃都会让重试记录错误的判别依据：

1. 节点 `n` 依赖 `d`，`d` 完成于 commit `C`；wave base 是 `B`。`prepare` 在 `B` 创建 worktree，记录 `preparedFrom = B`，合并 `C`，产生 merge commit `M`。
2. 进程在合并之后、`git-prepared` 追加之前死亡。
3. 重新打开时持久节点是 `starting` 且 `preparedHead === undefined`，于是 pump 在已包含 `M` 的 worktree 上再次调用 `prepare`。`currentHead` 现在是 `M`，`M` 是 `B` 的后代，因此 `git.ts:136-140` 的 ancestor 守卫通过，合并成为空操作，函数返回 `preparedFrom = M`、`head = M`。
4. `git-prepared` 存入 `preparedFrom === preparedHead === M`。
5. 什么都没提交的完成现在通过了 `git.ts:253-256` 的空操作守卫，因为 `head === preparedHead`，而 `preparedFrom` 不再等于 `frozenWaveBase`。`:257-261` 的变更文件检查看的是 `preparedHead...head`，结果为空，因此也通过。

节点被记录为 `completed`，`completedCommit = M`，而这个 commit 只包含依赖的工作；依赖方随后把 `M` 当作该节点的贡献合并进来。失败是静默的：没有错误、没有通知，`validateDagState` 也看不到它，因为它只对 `preparedFrom` 做格式检查。该窗口内的任何进程重启都会到达这里，包括普通的会话重新打开。根因是「worktree 在准备前是否已经带有 commit」这个判别依据是在准备时观察的，并被重试销毁；修复必须把合并前的 HEAD 记录到崩溃无法抹去的地方，或从冻结 wave base 与依赖 commit 图推导出来。

### 撕裂尾部修复存在会丢弃已恢复事件的崩溃窗口

默认持久化路径是带 checksum 的 Zstandard frame，每个持久追加批次一个。EOF 处被截断的最后一个 frame 由 frame 扫描发现，其中完整的事件行被恢复，修复在 `persistContiguous`（`packages/session/session-persistence-jsonl/src/storage.ts:328-337`）中分两次持久步骤执行：先由 `truncateTornTail` 截断并 fsync（`session-persistence-jsonl/src/index.ts:840-844`，`repair` 在 `:1287-1296`），然后才写回恢复的尾部。

这两步之间的崩溃会永久丢失已恢复事件。一次读取已经提供过它们，resume 打开的句柄把它们带进内存日志，DAG 折叠它们并可能据此运行 effect；下一次重新打开只能看到被截断的前缀。只有撕裂尾部读取后的第一次写入被中断时该窗口才可达，而现有测试覆盖的是失败重写后重试，不是窗口内的崩溃。

对 DAG 的损害是有界的，因为每个 effect 都以确定性 id 为键、并从幸存快照重新推导：残留是属于已不存在命令的遗留 worktree 或子会话，而不是非法状态。这个论证并不严谨，应该由测试承担，这正是选项 4 显式包含该窗口的原因。

### 被中断的 `git worktree add` 会搁死一个节点 id

如果进程在 `git worktree add` 运行期间死亡（`packages/dag/dag/src/git.ts:123-127`），目录可能存在但不是已注册的 worktree。该节点之后每一次 `prepare` 都在 `git.ts:113-115` 抛异常，包括 redispatch 再 dispatch 的循环，因为 `dispatch` 清空 `preparedHead`（`packages/dag/dag/src/reducer.ts:535-545`），于是 `prepareAndStart` 在同一条路径上再次调用 `prepare`。

没有任何转换能就地修复那个节点 id。`reset` 不能：`DagGit.reset` 在这个未注册目录内运行 `git rev-parse` 并失败（`git.ts:273-286`），而且 `dag_node_reset` 只在 `pending` 或 `failed` 下合法。逃逸方式是先用一次 `write` 丢弃该失败节点——这是允许的，因为移除拒绝只覆盖活跃节点（`reducer.ts:447-448`）——再用之后的一次 `write` 重新声明它：worktree 路径内嵌 `graphGeneration`（`packages/dag/dag/src/index.ts:445`），因此新 generation 会得到新目录。换用新的节点 id 重新声明可以不重连依赖方，但会放弃该 id。这个缺口会响亮失败且不产生非法状态，因此排在第一个缺陷之后；它需要的是一条针对「已存在但未注册路径」的显式修复转换，而不是藏在 `prepare` 里的静默修复。

## 验证选项

**对 reducer 的有界显式状态搜索（`packages/dag/dag/tests/model.spec.ts`）。** 对每个被探索状态与每个生成动作，证明 reducer 要么拒绝，要么产生满足 `validateDagState` 的状态、与 reference 一致，并能原样回放。由于它执行真实 reducer，反例就是真实反例。它无法证明被探索集合之外的任何东西：拒绝、服务层、持久性、Git、子会话，以及所有被语义键合并的状态。成本已经付过；用拒绝 oracle 与更宽的键扩展它是小的、有界的改动，状态上限会把状态爆炸变成响亮的失败。

**用 `fast-check` 做基于属性的差分测试。** 它不能绝对证明任何东西——它是搜索——但它搜索的空间与手写动作枚举器不同，因此能到达拒绝路径、重复操作与搜索预算排除的长历史，收缩还会把失败变成最小命令序列。它无法证明不存在反例，并与差分 oracle 共享盲点。成本：套件一至两天，外加一个单独的小提交来停止比较由生产推导出的 command id。

**在真实追加路径上做崩溃注入测试。** 对每个注入的终止点，证明重新打开得到日志的 `dag/state` 折叠在每一步都满足不变量，且 reconciliation 把每个未结算 mailbox 命令推进到终态；它还测量哪些窗口会丢失已确认的 revision，这一点目前没有文档记录。它无法证明它落不到的点，而让它确定化是难点所在。机械装置已经存在：服务套件已经构建真实 JSONL 根并通过 `ctx.agents.resume` 重新打开，持久化套件拥有格式层崩溃语义，另有一个双进程 fixture 已经对锁持有者发 SIGKILL。成本：进程内层一天，进程外层两至三天外加持续的 flake 风险。

**运行时不变量的强化。** 它不证明设计的任何东西。它把静默损坏转成任何运行它的组合中响亮、可归因的失败，并且是唯一能从真实会话产出证据的选项。它无法在从不产生的状态上触发，也不会回滚它拒绝的状态。三个层级，从最廉价的开始：在可选诊断组合中挂载 companion 并配一个真实组合测试；在 `DagService.Config` 标志后从 `mutate` 调用 `validateDagState`；以及为 reducer 缺陷会最先破坏的两项推导恒等式加入常开廉价断言。第三层是每事件 O(nodes × commands)，发布前需要测量。

**机器检验的规约（TLA+、Alloy 或 Quint）。** 对 reducer，它能证明归纳性对所有可达状态成立，包括 JS 搜索合并或从不生成的状态。它不能证明 TypeScript 实现了该规约，仓库没有这类工具链也没有可运行它的门禁，而 reducer 很小并拥有强大的可执行 oracle。对追加协议，理由确实更强，因为「进程在这两条指令之间死亡」不是 JS 模型能处于的状态——但那里价值最高的产物仍然是崩溃注入套件，因为它执行真实代码。如果终究要写规约，就为提交协议写，并且只在崩溃套件已存在、可作为一致性证据之后再写。

## 建议

步骤 1-3 与 6 是廉价、有界的工作；步骤 4 会发现新缺陷，步骤 5 是这些缺陷要求的。

1. **在不变量能运行的地方挂载它（半天）。** 一个可选诊断组合加一个通过 Loader 启动它、驱动一个节点生命周期的真实组合测试，能把八十项已经写好的检查从「仅存在于测试」变成实时检测器。不要动 `dsh-base`。
2. **为模型测试补上拒绝 oracle（一天）。** 对每个出队状态，生成被改动守卫的命令，断言精确的 `DagStateError.code` 或空操作。reducer 能抛出的十九个 `DagStateError` code 今天靠一个个手写用例覆盖。
3. **加入基于属性的序列测试并修正 oracle（一至两天）。** 生成任意命令序列，断言只有 `DagStateError` 逸出、每个被接受状态通过不变量、reference 一致、从 `null` 回放确定。另用单独提交停止在 `abstractDagState` 中比较 `commandId` 与 `commandState`。
4. **构建崩溃注入套件（三至四天）。** 第 1 层在进程内且确定性，在 `ci-primary` 把关；第 2 层是进程外 SIGKILL，作为可选门禁。不要重复测试 JSONL 格式。价值最高的单个测试是 `preparedFrom` 窗口的回归测试：在依赖合并与 `git-prepared` 追加之间终止进程，然后断言空操作完成仍被拒绝。它今天应当失败。接下来加入被中断 worktree 的用例、撕裂尾部修复窗口与通知注入窗口。
5. **修复缺陷（三至四天）。** 在 `git.prepare` 前持久记录合并前的 HEAD，加入显式的 worktree 修复转换，把撕裂尾部修复变成一次持久步骤；每个都需要各自的 Agent Note。
6. **关闭退出路径缺口（一天）。** 把 `settlement.stop()` 移入 `finally`，决定并记录抛异常的 owner 控制器对子级做什么，并补上缺失测试：真实 Activation 驱动 `ownerStop`、抛异常的 owner 控制器，以及 settlement 与挂起 redirect 竞争。
7. **迁移 DAG 的同步 Session 读取（一到两天）。** 七处生产调用——`latestState`、`dispatcherFor`、子级轮次边界、`messageRecorded`、`noticeRecorded`、不变量的安装期 seed，以及 `SubagentContinuationManager.recordsMessage`——直接读取事件历史，并携带本仓库的延迟迁移豁免。它们所需的既有状态，正是面向客户端的 `dag` 投影有意不携带的内容：完整的 `DagState`、已记录的消息与通知标识、子级描述符，以及当前轮次边界。因此迁移它们是一次持久状态与投影的设计变更，并带有自己的格式问题，而不是机械替换。

明确不做：

- 不为 reducer 写 TLA+、Alloy 或 Quint 规约。
- 不构建通用模型检验器或状态空间抽象层。
- 不为每次追加增加一次 fsync；200 毫秒批次加每个外部 effect 前的 flush 屏障是正确的取舍，已确认但尚未持久的窗口是文档问题。
- 不在 `mutate` 中无条件启用 `validateDagState`。
- 不把模型测试的绿色结果当作关于服务的证据。
- 不在 DAG 测试中重复测试 JSONL 格式；持久化套件拥有它。

## 考虑过的替代方案

**为 reducer 写 TLA+/Alloy/Quint 规约。** 作为花架子否决。状态空间很小，reducer 可执行，现有搜索用真实代码与八十项检查的 oracle 探索了超过一千个语义状态，而规约会成为没有一致性测试装置、也没有门禁可运行的第二个产物。JS 层探索唯一无法确立的性质——折叠持久日志的读取方看到线性化前缀——属于提交协议，而崩溃注入套件就是它的一致性证据。

**从 `mutate` 无条件调用 `validateDagState`。** 否决。它每个被接受事件耗费 O(nodes × commands)，而 `dsh-base` 刻意不带运行时诊断发布。配置标志加可选组合能拿到诊断价值，又不必在每个会话中付费。

**为每次状态追加增加 fsync。** 否决。它会关闭「已确认但尚未持久」窗口，即工具调用返回了一个被接受的 revision，而崩溃在下一次排空前抹去它。该窗口不违反任何状态不变量，因为持久前缀保持合法；代价是每次状态转换都同步写盘，而现有屏障已经保证任何外部 effect 都不会在其命令持久前运行。

**在 DAG 套件中重复测试撕裂 frame 与 fsync 回滚。** 否决。持久化套件已经覆盖格式、回滚与修复重试，重复它们等于把同一份代码测两遍。DAG 套件测试的是 DAG 从被修复日志中折叠、据以行动并重新推导的内容。

**用模型代替测试来覆盖服务层。** 否决。服务行为由真实异步 effect 主导——Git、子会话、持久化 flush——纯模型只能把它们抽象成恰恰需要被测试的那些假设。

## 验收标准

- 有一个可选组合挂载 `@deepseek-ai/dsh-dag/invariant`，且一个真实组合测试通过 Loader 启动它、驱动一个节点从声明到完成，并在向流中注入刻意的不变量违规时失败。
- `packages/dag/dag/tests/model.spec.ts` 从每个出队状态发出被改动守卫的命令，并断言精确的 `DagStateError.code` 或返回同一对象的空操作，两个分支都不留下未覆盖的接受路径。
- `packages/dag/dag/tests/model-property.spec.ts` 在 `pnpm run test` 下运行，生成不做前置条件过滤的命令序列，并断言提案中的全部四项性质；失败的运行可从记录的 seed 复现。
- `packages/dag/dag/tests/crash-recovery.spec.ts` 在真实 `JsonlSessionPersistence` 根上通过，在每次重新打开时断言 `dag/state` 折叠的每一步都满足 `validateDagState`，并断言 `reconcile` 不留下任何未结算 mailbox 命令。
- `preparedFrom` 窗口的回归测试存在，并在当前代码上失败：在依赖合并与 `git-prepared` 追加之间终止进程后，空操作完成仍必须被 `DagGit.validateCompletion` 拒绝。
- 有一个测试在 `git worktree add` 期间终止进程，并断言存在一条已记录的转换让该节点重新可调度。
- 有一个测试在截断与重写之间中断撕裂尾部修复，并断言恢复的事件在重新打开后要么持久，要么可证明从未被据以行动。
- `settlement.stop()` 在 `turnSettled` 的每条退出路径上运行，且抛异常的 owner 控制器有一个测试说明子级是否被取消。
- `abstractDagState` 不再比较由生产推导的 command id 与状态，且差分断言仍然通过。
- 本笔记中的每一处 file:line 主张仍指向所指代码，否则在移动该代码的同一变更中修正本笔记。

## 风险

崩溃注入套件是最昂贵的部分，也最容易 flake。第 1 层在构造上就是确定性的——不 flush 就 dispose、截断到指定偏移、在两次修复步骤之间中止——但第 2 层依赖把 SIGKILL 落在特定窗口内以及子进程时序，因此必须保持可选，并且必须自己持有临时根目录、子进程与清理。

在实时组合中打开 `validateDagState` 会把静默损坏变成追加路径上的抛出错误。这正是目的，但会话期间的不变量失败会让会话失败，因此组合必须可选，失败必须可归因、可行动。

拒绝 oracle 会把模型测试的工作量乘以每个状态的守卫改动数量。现有的 25 000 状态上限与 30 秒超时会把状态爆炸变成响亮的失败，而 oracle 可能只能跑出队状态的一个有界子集。

修复 `preparedFrom` 窗口会改变关于准备的持久记录内容，这是一个持久格式决策，并对已经携带 `dag/state` 快照的会话带来迁移问题。修复在发布前需要自己的 Agent Note。

本笔记记录三个缺陷，并不修复它们。在步骤 5 落地前，`preparedFrom` 窗口中的崩溃仍会产生静默错误的完成，而这里提出的回归测试预期会失败（这正是它证明缺陷的方式）。

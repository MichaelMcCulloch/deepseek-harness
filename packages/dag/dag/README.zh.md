---
description: "面向配置、操作或排查按依赖排序的本地 agent 工作的用户与维护者：持久原生 DAG 服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-dag

[English](README.md) | 中文

## 概述

`dsh-dag` 是 DeepSeek Harness 的原生依赖图调度器。每次变更被接受后，一个调度器会话拥有一份完整且不可变的 `dag/state` 快照。服务验证依赖顺序，通过比较并设置 revision 提交状态，然后运行可取消的 Git、子会话、mailbox、通知与持久化 effect。每个节点在专用本地分支与 worktree 中使用可续行子级。服务只使用本地 Git，绝不读取 remote、push，或创建 issue 与 merge request。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一个 agent 必须在隔离的本地 Git worktree 之间协调按依赖排序的工作时，在宿主平面挂载本包。在 agent 组合中挂载 `@deepseek-ai/dsh-tool-dag` 以提供模型控制；在 Web bundle 中挂载 `@deepseek-ai/dsh-client-ui-dag` 以提供只读面板。

### 配置

```yaml
- name: '@deepseek-ai/dsh-dag'
  config:
    gitExecutable: git
    commandDeadlineMs: 120000
    terminationGraceMs: 5000
    outputLimitBytes: 8388608
    subagentProvider: spawn
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | 正常 `DSH_HOME` 解析 | `dag/worktrees/v1` 的基目录；空值使用共享 home-path resolver |
| `gitExecutable` | `git` | 在 subprocess 执行环境中解析的可执行文件 |
| `commandDeadlineMs` | `120000` | 每个 Git 进程的期限 |
| `terminationGraceMs` | `5000` | 从终止请求到强制结束的宽限时间 |
| `outputLimitBytes` | `8388608` | 每个 Git 流最多收集的字节数 |
| `subagentProvider` | `spawn` | DAG 子级使用的进程内可续行 provider |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-dag)是完整字段参考。

### 节点生命周期

新节点从 `pending` 开始。dispatch 让就绪节点经过 `starting` 进入 `in_progress`。子级报告 `completed` 或 `blocked`；effect 或子级失败记录 `failed`；stop 在取消前记录 `interrupted`。blocked、interrupted 与 failed 节点通过 `starting` resume 或被 steer；failed 节点也可通过 redispatch 回到 `pending`。completed 节点是终态。

错误的声明会被就地修正，因此修正一行绝不会让依赖它的行付出代价。`dag_write` 重新发送完整图，并修正每个已声明字段发生变化的既有行；它还会把被省略的节点从每个存活依赖节点的依赖列表中移除，而不再要求丢弃该依赖节点，并把两者分别报告为 amended 行与 rewired 行。`dag_node_amend` 在不重新发送图的情况下更改单个节点的已声明字段。两条路径都不会更改活动节点的声明，也不会更改已记录本地 Git 准备的节点的依赖。已声明的文件归属沿每条依赖边互斥，且该规则针对请求将要存储的图进行检查：修正可以保留或收窄图已携带的违规边，但绝不可扩大它或新增一条，因此早于该规则的图仍可逐个节点修复。两者都会把仍存在的违规报告为 `dependency-file-overlap` 冲突行。

dispatch、redispatch、resume、steer、stop 或 reset 操作在使早期工作失效时递增节点 generation。effect 回调必须匹配节点 binding generation、节点 generation 与 operation id。陈旧回调不能修改状态。

### 本地 Git 执行

dispatch wave 先记录意图，再检查一次 porcelain-v2 根状态。根 worktree 必须干净、位于符号本地分支并具有有效本地 HEAD。wave 只冻结一次该分支与 commit。节点分支与 worktree 从冻结 commit 开始，位于 `<DSH_HOME>/dag/worktrees/v1/` 下；依赖 commit 按声明顺序用已记录的精确 commit id merge。

任务节点完成要求 worktree 干净、分支符合预期、没有活跃 merge，且每个依赖 commit 都是 ancestor，另外还要求 HEAD 不同于冻结 base，或 worktree 在准备开始时已带有 commit。准备会记录 merge 前的 HEAD，因此把节点重新投入其自身已交付的工作时可以无需新 commit 而完成。服务在接受完成前执行声明文件归属检查，并会在声明时拒绝某个传递依赖也声明了其已声明文件的任务节点。integration 节点使用 `ours`、`theirs` 或 `delegate`；delegate 模式记录精确 commit 与 conflict，交由子级手动解决。reset 接受冻结 base、精确 commit 或显式本地 `refs/heads/*` ref，并保留 untracked 文件。

### 立即命令与等待

变更先同步 reduce 并追加一份完整快照，再启动异步工作。可选 `if_revision` 字段以 `dag-revision-conflict` 拒绝陈旧调用方；重入 append 也会失败而不会等待。每个被接受的变更返回新 revision 与 operation id。

每个节点有一个持久 FIFO mailbox 与一个进程本地 effect pump。重新打开时，reconciliation 在重试前检查 accepted 和 running 命令、本地 Git 事实与子会话证据。确定性的 child、message、command 与 notice id 使重试具有幂等性。`dag_wait` 在 resolve 前注入并记录可操作通知；一个调度器会话只能有一个 waiter。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 持久状态与回放

调度器日志是唯一持久权威。每个 `dag/state` 事件包含完整的版本 1 快照：revision、graph generation、operation counter、节点面板、拓扑顺序、就绪列表、状态计数、wave、命令、receipt 与通知。`dag` 会话投影持有该完整状态——第一条事件前为 `null`——注册表随每个已提交事件推进它，因此服务通过 `stateOf` 读取状态，无需扫描日志。其 wire 值是不含绝对 worktree 路径的浏览器安全视图。

生产 reducer 与独立 reference reducer 都是纯函数。测试在有界的命令、effect、陈旧回调与重启历史上比较两者。每次 append 被接受后，服务发布非阻塞 `dag/committed` Cordis 事件，供其他插件观察不可变结果。

### 受 owner 控制的子级

DAG 子级携带持久 JSON owner metadata、绝对 worktree `cwd` 与 `settlementDelivery: none`。subagent 服务保留授权。授权后，其 owner-controller registry 把 stop、redirect 与子级 settlement 交给本服务。通用可续行子级仍使用既有 continuation lock 与 adaptive settlement 行为。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、状态提交、effect pump、恢复、通知、waiter、子级归属、projection |
| [`src/reducer.ts`](src/reducer.ts) | 生产状态 reducer 与 projection |
| [`src/reference-reducer.ts`](src/reference-reducer.ts) | 模型测试使用的独立 reference reducer |
| [`src/validation.ts`](src/validation.ts) | 完整图声明验证与 advisory 重叠行 |
| [`src/git.ts`](src/git.ts) | 通过 subprocess 服务执行精确参数的本地 Git 操作 |
| [`src/types.ts`](src/types.ts) | 持久、服务、事件与浏览器安全类型 |
| [`src/invariant.ts`](src/invariant.ts) | 独立持久日志检查 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DAG 子系统](../../../docs/subsystems/dag.zh.md)——服务 API、状态行、生命周期、恢复与 Git 规则。
- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——可续行子级控制与 owner 委派。
- [DAG 工具包](../tool-dag/README.zh.md)——调度器与子级模型工具。
- [生成的持久化目录](../../../docs/persistence-catalog.zh.md)——`dag/state` 事件条目。

-----

<a id="model-experience"></a>
## 模型体验

### 状态通知

#### 模型看到什么

本服务不注册工具或提示词。节点失败、阻塞、被中断、在开放 wave 外完成，或 wave settle 时，它可以注入持久通知。工具包控制模型命令集。

#### Token 影响

每个已投递通知增加一条短 inbox 消息。完整 `dag/state` 快照与 `dag` 浏览器 projection 本身不进入模型输入。

#### KV Cache 影响

新通知扩展请求历史。只有状态的提交不修改模型输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每会话一个活跃进程**——revision 检查保护一个进程内的重入命令；不支持多进程修改同一会话。
- **不迁移旧格式**——不读取 `dag-todo` 状态、sidecar、alias 或远程 provider 数据。
- **只使用本地 Git**——运行时代码不 fetch、不检查 remote、不 push，也不创建远程工作项。
- **保留 artifact**——分支、worktree、子会话与 untracked 文件绝不自动删除。
- **完成依据是 Git 证据，不是审查**——服务证明分支与 commit 事实，但不证明语义正确性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

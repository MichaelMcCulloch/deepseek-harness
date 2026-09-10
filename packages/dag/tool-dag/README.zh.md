---
description: "面向操作原生持久 DAG 的用户与维护者：调度器工具和受 owner 约束的子级工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dag

[English](README.md) | 中文

## 概述

`dsh-tool-dag` 向调度器提供原生 DAG 命令集，并只向每个 DAG-owned 子级提供其自身工作的控制。变更工具提交持久意图，并立即返回 acceptance revision 与 operation id，不等待 Git 或子级 effect。调度器提示词要求使用 `dag_wait`，而不是轮询状态。子级工具从持久 owner metadata 派生 dispatcher、node 与 child identity；模型输入不能选择这些 identity。

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

在调度器组合中挂载主 export；在创建可续行子级的宿主组合中挂载 `/child` export。已发布的 base、`standard`、`ptc` 与 Cordis agent 组合包含这些角色。

### 调度器工具

| 工具 | 用途 |
|---|---|
| `dag_write` | 声明或修改完整图 |
| `dag_dispatch` | 启动依赖已就绪的 pending 节点 |
| `dag_wait` | 等待 revision 之后注入的可操作通知 |
| `dag_status` | 读取一次完整安全面板 |
| `dag_node_inspect` | 读取一个节点及其执行事实 |
| `dag_node_redispatch` | 把 failed 节点返回 pending |
| `dag_node_resume` | resume blocked 或 interrupted 节点 |
| `dag_node_steer` | 取消并替换节点工作 |
| `dag_node_stop` | 先记录 interrupted，再取消节点工作 |
| `dag_node_reset` | 把 tracked 工作 reset 到允许的本地目标 |

`dag_write` 发送完整节点列表。新节点只能声明 `pending`。既有行重复其不可变定义与精确 live status。每个 brief 必须包含 `VALIDATION:` 与 `ACCEPTANCE:` 段。验证拒绝重复 id、cycle、缺失依赖、自依赖、不安全路径、无效 integration policy，以及移除活跃节点。文件与 contract-pin 重叠行仅为 advisory。

### 子级工具

DAG 子级看到 scoped `dag_status`、`dag_node_complete` 与 `dag_node_block`。它看到拓扑、依赖状态与自身执行事实，但不能控制另一个节点。成功轮次必须以 complete 或 block 结束。正常子级轮次如果结束时没有这两种报告，会在 settlement 后变为 failed。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

调度器插件注册公开工具与一个模型提示词段。只有 owner metadata 指定 DAG controller 时，子级插件才使用 continuable setup registry。它在该子级 scope 中拒绝调度器控制，注册三个子级工具，并添加子级完成规则。每个工具都使用通用 rendering，不返回可点击文件位置。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 调度器 schema、执行、rendering、状态与子级工具 factory |
| [`src/child.ts`](src/child.ts) | owner-scoped 子级 setup、限制与提示词文本 |
| — | 不发布 runtime invariant companion；每个工具都是 DAG 服务上的 effect-scoped 注册，持久状态由 DAG 服务拥有并校验。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DAG 服务](../dag/README.zh.md)——持久状态、effect、Git、恢复与通知。
- [DAG 子系统](../../../docs/subsystems/dag.zh.md)——生成的服务 API 与生命周期参考。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-dag)——精确模型 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 调度器与子级工具

#### 模型看到什么

调度器看到十个公开工具和一条在 dispatch 后使用 `dag_wait` 的短规则。DAG 子级只看到其 scoped 状态、完成与阻塞工具，以及 stop 取消工作、steer 取消并替换工作的规则。

#### Token 影响

工具 schema 增加固定请求成本。`dag_status` 与 inspect 结果随图或节点状态增长。被接受的变更结果小且格式固定。

#### KV Cache 影响

只要组合与子级 scope 不变，提示词与工具定义就是前缀稳定的。工具调用与结果追加到历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有同步完成**——acceptance 表示持久意图已提交；effect 之后仍可能失败。
- **子级不能跨节点控制**——只有调度器可以控制面板。
- **没有状态轮询工作流**——调用方在 dispatch 后必须使用 `dag_wait`；重复调用 `dag_status` 不是调度器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

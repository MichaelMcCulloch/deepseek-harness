---
description: "面向需要持久依赖工作紧凑视图的用户与维护者：只读 Web DAG dock。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dag

[English](README.md) | 中文

## 概述

本包向 Web 对话 composer 添加只读 DAG dock。`dag` projection 为 `null` 时，它保持隐藏。第一次 `dag_write` 之后，它显示非零状态计数、就绪节点数量与可展开的拓扑节点列表。其 order 为 `15`，位于 Todo 和 Goal 之后、Queue 之前。它不提供 dispatch、stop、steer 或其他变更控制。

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

在 Web bundle 中挂载宿主包，并在浏览器图中包含其 client module。本包需要 session projection 与 conversation dock 服务。它通过 locale 服务注册英文与简体中文文案。

dock 只读取 `useProjection('dag')`。绝对 worktree 路径不在此 wire view 中。重新加载会从最新持久 `dag/state` 事件重建相同面板。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

宿主 export 没有运行时状态。client export 注册 locale dictionary 与一个 `conversation.input.dock` slot 条目。`DagBoard` 是纯展示组件，`DagDock` 只读取 projection hook。

| 文件 | 职责 |
|---|---|
| [`src/client/DagDock.tsx`](src/client/DagDock.tsx) | projection adapter 与只读面板组件 |
| [`src/client/locales.ts`](src/client/locales.ts) | 类型化英文与简体中文 dictionary |
| [`src/client/DagDock.module.css`](src/client/DagDock.module.css) | dock、计数与节点列表布局 |
| — | 不发布 runtime invariant companion；本包渲染的每个 projection 状态值都由宿主 DAG 包拥有并校验。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DAG 服务](../../dag/dag/README.zh.md)——持久状态与浏览器 projection。
- [DAG 子系统](../../../docs/subsystems/dag.zh.md)——projection 字段与生命周期。
- [客户端包地图](../README.zh.md)——相邻 Web UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这个只读浏览器 projection 不注册模型提示词、工具、消息或上下文。

#### KV Cache 影响

无；本包不修改模型请求或历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只读视图**——用户不能从此 dock 修改节点。
- **只含紧凑事实**——dock 省略通知、命令、operation receipt、子会话、commit 与 worktree 路径。
- **只有当前状态**——不显示 revision 时间线或过去的 graph generation。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

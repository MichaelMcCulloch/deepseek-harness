---
description: "原生 DAG 包组：持久编排、本地 Git 执行、调度器工具与受 owner 约束的子级工具。"
kind: "package-group"
---

# dag/ — 原生依赖图编排

[English](README.md) | 中文

## 概述

`dag/` 组让一个调度器会话声明依赖图、并行启动就绪节点，并在隔离的本地 Git worktree 中协调可续行的子 agent。会话日志保存完整图状态。每次状态变更被接受后，后台 effect 执行 Git 与子级工作。本组不替代 todo 列表或通用 subagent 管理器。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`dag/`](dag/README.zh.md) | 拥有持久状态、revision 检查、effect 恢复、通知、子级归属与本地 Git worktree |
| [`tool-dag/`](tool-dag/README.zh.md) | 向调度器提供 DAG 命令集，并向受 owner 约束的子级提供状态、完成与阻塞工具 |

-----

<a id="related-documentation"></a>
## 相关文档

- [DAG 子系统](../../docs/subsystems/dag.zh.md)——状态、生命周期、服务 API、effect、通知与 Git 规则。
- [Subagent 子系统](../../docs/subsystems/subagent.zh.md)——可续行子级、redirect、settlement 投递与 owner controller。
- [客户端 DAG UI](../client/ui-dag/README.zh.md)——只读 Web 面板。

<a id="dev-note"></a>
## 开发备注

无。

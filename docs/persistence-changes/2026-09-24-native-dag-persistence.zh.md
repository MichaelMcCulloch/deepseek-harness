---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-native-dag-persistence

[English](2026-09-24-native-dag-persistence.md) | 中文

## 概述

新增持久化 DAG 状态事件、DAG 通知来源类型，以及可继续描述符的两个可选字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-native-dag-persistence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "4cddb6c4710a48bc4016639dedc3324ce6338bbb8d2959c602f2671047a4006e"
    decision: same-version
  - root: "event:dag/state"
    previous: null
    after: "26b4cd8ea2bb75a88573a0b9ce528fa799964f726eb828a0c9bc825b7cd7762f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "2d4867033090cebbffa44f2614c2008cb2d1136bed69923390fc9449e5110b82"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "f436874e46e458a1aa08c182025ce1f168514aa8d890fb7bc4c0100a3ecb5b0a"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "5812a50598170303bc355b38f2062ed1d3d087df657726bb8ee5a084fa9677d0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "685f4a52ac629d750f96e6da76132eb4f65a96e4c593b37450ad584757a8920e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

四条被检测到的路径都是纯新增。`dag/state` 是新的普通事件类型，承载一份完整且不可变的 DAG 快照；没有它的会话不受影响，执行 DAG 工作的读取方通过 `dag` projection 折叠它。`dag-notice` 是仅作归因（attribution）的来源类型：它只声明通知文本，因此没有 DAG 服务的读取方会保留该消息，仅跳过通知自身的识别信息。`settlementDelivery` 与 `owner` 在可继续描述符上是可选的：在这两个字段出现之前写入的描述符会解析为写入方在调用方未声明时采用的 `adaptive` 投递策略，并解析为无 owner 绑定，因此旧记录恢复后的行为与其写入时一致。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/subagent packages/dag packages/session/session-persistence-jsonl：1686 个测试通过、1 个跳过。pnpm run verify-persistence-changes 将每条被检测到的路径报告为允许 same-version；pnpm run verify-persistence-catalog 报告目录、schema 清单与已知事件类型源码均为最新。

<a id="dev-note"></a>
## 开发备注

无。

# Agent Note: 模块图零导入环

Status: implemented

[English](2026-09-10-zero-import-cycles-in-the-module-graph.md) | 中文

## 问题

`cyclecheck` 在 `packages/` 与 `vendor/` 中报告了 27 个导入环。每个环都把两个模块双向耦合：一方引用另一方声明的类型或值，而后者又反向引用前者。TypeScript 会擦除纯类型导入，因此多数环在运行时无害，但该检查器有意将其计入——类型环同样把两个模块的声明绑在一起——而值环会让求值顺序依赖于尚未初始化完成的绑定。

## 决策

模块图现在没有任何环。每个环都通过移动声明来打破，使依赖只朝一个方向流动，再从原位置重新导出，因此每个公开导出的名称与类型都保持不变。

多数环源于某模块从自己包的 `index.ts` 桶文件导入类型，而该桶文件又反向值导入它。现在该类型来自声明它的模块，或来自只含类型的叶子模块——已有的同类文件如 `types.ts`，或新建一个——再由 `index.ts` 重新导出。少数环需要移动类或符号集合：客户端会话存储词汇、把 `SessionPreparation` 移入声明 `Session` 的模块、把子智能体进程级稳定标记移入 `markers.ts`，以及把线上准入实现移入拥有 `AttachmentStore` 的桶文件。

有两个集合完全无法拆分。在 `vendor/cordis` 中，八个核心模块——`Context`、`EventsService`、`Fiber`、`LoggerService`、`ReflectService`、`RegistryService`、`Service` 与 `utils`——都在公开签名中引用 `Context`，而 `Context` 又值导入并构造它们；`vendor/loader` 的递归条目核心（`Entry`、`EntryOptions`、`EntryGroup`、`EntryTree`、`Loader`、`isolate`）形状相同。在不改变公开签名或模块求值顺序的前提下无法删除任何一条边，因此两者各自把递归核心合并进一个模块，并保留其余路径为显式名称的重新导出外观模块。这两处偏离均记录在 [`vendor/README.md`](../../../../vendor/README.md) 的第 20、21 项，未来同步上游时需要重新应用该搬迁，而不只是本地补丁清单。

## 曾考虑的替代方案

**把类型导入改写为 `import type`。** 拒绝：检查器把纯类型导入计为边，因此该边依然存在。这些环大多已经使用了 `import type`。

**为 Cordis 服务引入窄接口（port）。** 用叶子接口配合声明合并可以在不合并文件的前提下消除该环，但公开位置（`Hook.ctx`、`LoggerService.ctx`、`Fiber.ctx`、`Plugin.*`、`getTraceable`）将改为引用该接口而非具体的 `Context`。这对使用方是实质性的收窄；而合并方案已用编译器 API 逐一验证，保留了每个导出的声明类型。

**用 `--baseline` 棘轮记录这些环。** 拒绝：那是接受环而不是消除环。该工具的 baseline 是遗留代码库的采用路径，而不是一种设计立场。

**为迁就解析器而改写源码。** 拒绝。检查器会丢弃任何解析失败文件的全部出边，而本仓库有 59 个文件解析失败（`export type * from`、`out T` 型变标注、作为成员名的 `accessor`、含多个调用签名的类型字面量）。把 `export type *` 改写为 `export *` 能让 374 条边显现并额外暴露两个环，但它同时把纯类型重新导出变成运行时重新导出。解析器缺陷应反馈给该工具，而不是在本仓库中绕开。

## 后果

桶文件重新成为聚合点：`index.ts` 从叶子模块导入名称并重新导出，任何模块都不再反向引用自己所属的桶文件。

声明获得了新的归属，包括若干包中只含类型的叶子模块，以及每个 vendored 框架包中一个合并后的内核。`vendor/cordis/src/context.ts` 必然成为检查器无法解析的文件，因为 `Service<out T = never>` 与 `ReflectService.accessor(...)` 类方法若不改变类型就无法改写——但它剩余的导入只有 npm 包，因此该盲区没有隐藏任何相对导入边。

指向合并内核的深层路径现在会额外导出该集合的名称；没有任何名称丢失或被重新定型，每个包的桶文件保持不变。

通过阅读导入图而非借助检查器发现的环，也以同样的方式修复。其中两个在 `export type *` 被临时改写为 `export *` 时显现（`client/file-upload`、`subagent/subagent`），另外三个则在检查器获得“从未能解析的文件中恢复边”的能力时显现（`client/ui-slots`、`core/tools`、`typert/protocol`）。两组都是真实存在的环；此后每发布一版检查器都会发现更多，因此“零环”是关于某个具体检查器版本的陈述，而不是可以假定稳定的性质。

## 验证

`cyclecheck . --lang typescript` 报告零个环。`pnpm run typecheck` 在整棵树上通过。

每条工作流都运行了覆盖模块边界发生变化的包的测试套件：`core/{scope,session,tools,agent}`、`llm`、`llm-deepseek`、`subagent/subagent`（693 个测试）、`subprocess-local`、`mcp-client`、`sandbox`、`session-persistence-jsonl`、`session-telemetry`、`attachment`、`client/file-upload` 以及 GUI 客户端套件。两个合并内核由 `packages/core/{scope,session,agent}`（1,037 个测试）、`packages/boot/app-boot`（141）、`packages/host/directory-picker-auto`、`packages/preset/agent-presets`（186，其中继承了 `EntryTree`）以及 `scripts/cordis-core-api.spec.ts` 覆盖。

## 相关

[事件溯源的原生 DAG 编排器](2026-08-29-event-sourced-native-dag-orchestrator.zh.md) 在主题上无关；本记录独立拥有模块图这一决策。

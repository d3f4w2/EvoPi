# 01 Trace 观测机制（Trace Observability Harness）

> 本模块是 EvoPi 底座，MVP 已实现（`.pi/extensions/evopi-trace/index.ts`，736 行）。

## Pi 现状 → EvoPi 增量 → 实现前后区别

> 补于 2026-07-01（README 规则 3）。本节讲清 Pi 已实现什么、EvoPi 补什么、实现前后区别。

### Pi 已经实现的

| 能力 | Pi 怎么实现的 | 说明 |
| --- | --- | --- |
| **生命周期钩子** | Pi 暴露 `pi.on(event, handler)`，事件含 session_start/agent_start/turn_start/turn_end/before_provider_request/after_provider_response/tool_call/tool_result/message_end/session_before_compact/session_compact/session_shutdown | EvoPi 观测的挂点全现成 |
| **观测层（被动）** | Pi 另有 `traceOperation`/`subscribePiObservability`（packages/agent/docs/observability.md），发 pi.agent.*/pi.ai.* 事件，可转 OTel/Sentry | 被动、不影响执行；EvoPi 未直接用，改用 hook 层 |
| **session 自定义条目** | `pi.appendEntry(type, data)` 写 session tree | EvoPi 的 anchor 写入靠它 |
| **上下文用量** | `ctx.getContextUsage()` → {tokens(估算)/contextWindow/percent} | EvoPi 直接读 |

### Pi 没有的（EvoPi 补的）

- **统一的 traceId + 事件模型**：Pi 的钩子是分散的，EvoPi 给每次运行一个 traceId，把所有钩子归一成 `EvoPiTraceEvent` 统一结构（schemaVersion/traceId/eventId/type/timestamp/model/contextUsage/data）。
- **JSONL 持久化**：Pi 钩子是瞬时的，EvoPi 落 append-only JSONL（`.pi/evopi/traces/<traceId>.jsonl`）供离线分析/grep/未来 OTLP。
- **隐私脱敏默认**：EvoPi 默认只记摘要（角色数/消息数/工具数/长度），不记原始 prompt/payload。
- **事件词表约定**：EvoPi 定义 `session.start`/`tool.call` 等事件名 + payload 形状，供 Cost/Memory/Execution/Tool/Eval 各模块复用（后续模块的 cost.*/skill.*/policy.*/tool.*/eval.* 都建在此约定上）。

### 实现前后区别

| 场景 | 实现前（裸 Pi） | 实现后（EvoPi Trace） |
| --- | --- | --- |
| agent 跑一次 | 钩子触发即逝，无留存 | 每次有 traceId，全过程写 JSONL |
| 想看「上次跑了啥」 | 无从查 | `/evopi-trace`/`last`/`path` 展示 |
| 后续模块要观测数据 | 各自造 | 复用统一事件词表 + JSONL 底座 |
| 敏感数据 | 钩子里有原始 payload | 默认只落摘要，脱敏 |

## 概述

Trace 观测是 EvoPi 的底座。它把 agent 的执行时间线捕获成结构化事件，供后续的成本看板、策略审计、记忆蒸馏、eval 门禁、回归重放消费。

MVP 是一个项目本地的 Pi 扩展 `.pi/extensions/evopi-trace/index.ts`。它不修改 Pi core，只订阅 Pi 生命周期钩子并写 append-only 的 trace 事件。

## 目标

- 给每次 agent 运行一个 `traceId`。
- 记录 turn、provider、tool、message、compaction、上下文用量事件。
- 事件双写：Pi session tree + JSONL 文件（供离线分析）。
- 默认不泄露敏感的 prompt 或 tool payload。
- 确立事件名与 payload 形状，供后续模块复用。

## 事件模型

Trace 事件用这个结构：

```ts
interface EvoPiTraceEvent {
  schemaVersion: 1;
  traceId: string;
  eventId: string;
  type: string;
  timestamp: string;
  sessionLeafId?: string;
  model?: {
    provider?: string;
    id?: string;
    name?: string;
  };
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  data?: Record<string, unknown>;
}
```

初始事件类型：

| 事件 | 钩子 | 数据 |
|---|---|---|
| `session.start` | `session_start` | reason, restored trace state |
| `agent.start` | `agent_start` | active tools count |
| `agent.end` | `agent_end` | message count |
| `turn.start` | `turn_start` | turn index |
| `turn.end` | `turn_end` | turn index, tool result count, final role |
| `provider.request` | `before_provider_request` | payload summary only |
| `provider.response` | `after_provider_response` | HTTP status, selected safe headers |
| `tool.call` | `tool_call` | tool name, input key summary |
| `tool.result` | `tool_result` | tool name, error flag, content summary |
| `message.end` | `message_end` | role/type and content summary |
| `compact.before` | `session_before_compact` | reason, branch entry count |
| `compact.after` | `session_compact` | reason, compaction entry id |
| `session.shutdown` | `session_shutdown` | reason |

## 存储

MVP 写两个存储：

- Session 自定义条目：用于分支感知的状态重建和未来的 UI 命令。
- `.pi/evopi/traces/<traceId>.jsonl`：用于 grep、离线评分、导入 Langfuse/Phoenix 类工具、未来 OTLP 导出。

第一版不需要 SQLite。SQLite 层可在事件词表稳定后再加。

## 对外接口

MVP 注册：

- `/evopi-trace`：显示当前 trace id 和 in-memory 事件计数。
- `/evopi-trace last`：显示最近 10 个事件类型。
- `/evopi-trace path`：显示当前 JSONL trace 文件路径。

同一扩展还为其它 Harness 模块注册了轻量命令（现已实现，非骨架）：

- `/evopi-cost`
- `/evopi-memory`
- `/evopi-job`
- `/evopi-tools`
- `/evopi-eval`

未来命令：

- `/evopi-trace export --openinference`
- `/evopi-trace score`
- `/evopi-trace replay`

## 隐私默认

扩展记录摘要而非原始 body：

- Provider payload：角色数、消息数、工具数、顶层 key。
- Tool 输入：key 名和安全的标量长度摘要。
- Tool 结果：内容项数、文本总长、图片数、错误标志。
- 消息：角色/类型、文本长度、片段数。

完整 payload 捕获只应在显式 opt-in 配置后开启。

## 验收检查

- 启动 Pi session 时扩展加载不抛错。
- 跑一个模型 turn 会在 `.pi/evopi/traces/` 下生成 JSONL 文件。
- 工具调用追加 `tool.call` 和 `tool.result` 事件。
- Provider 调用追加 `provider.request` 和 `provider.response`，不含原始 prompt 文本。
- `/evopi-trace`、`/evopi-trace last`、`/evopi-trace path` 返回有用状态。
- cost、memory、job、tools、eval 命令注册并写入各自的初始状态格式。


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

## Summary

Trace Observability is the foundation for EvoPi. It captures the agent execution timeline as structured events that can later feed cost dashboards, policy audits, memory distillation, eval gates, and regression replay.

The MVP is a project-local Pi extension at `.pi/extensions/evopi-trace/index.ts`. It does not modify Pi core. It subscribes to Pi lifecycle hooks and writes append-only trace events.

## Goals

- Give every agent run a `traceId`.
- Record turn, provider, tool, message, compaction, and context-usage events.
- Persist events both in the Pi session tree and in JSONL files for offline analysis.
- Avoid leaking sensitive prompt or tool payloads by default.
- Establish event names and payload shapes that later modules can reuse.

## Event Model

Trace events use this shape:

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

Initial event types:

| Event | Hook | Data |
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

## Storage

The MVP writes to two stores:

- Session custom entries: useful for branch-aware state reconstruction and future UI commands.
- `.pi/evopi/traces/<traceId>.jsonl`: useful for grep, offline scoring, import into Langfuse/Phoenix-style tools, and future OTLP export.

No SQLite database is required in the first implementation. A SQLite layer can be added after event vocabulary stabilizes.

## Public Interface

The MVP registers:

- `/evopi-trace`: show the current trace id and in-memory event counters.
- `/evopi-trace last`: show the last 10 recorded event types.
- `/evopi-trace path`: show the current JSONL trace file path.

The same extension also registers lightweight skeleton commands for the other Harness modules:

- `/evopi-cost`
- `/evopi-memory`
- `/evopi-job`
- `/evopi-tools`
- `/evopi-eval`

Future commands:

- `/evopi-trace export --openinference`
- `/evopi-trace score`
- `/evopi-trace replay`

## Privacy Defaults

The extension records summaries instead of raw bodies:

- Provider payloads: role counts, message count, tool count, top-level keys.
- Tool inputs: key names and safe scalar length summaries.
- Tool results: content item counts, text length totals, image counts, error flag.
- Messages: role/type, text length, part count.

Full payload capture should only be added behind an explicit opt-in config.

## Acceptance Checks

- Starting a Pi session loads the extension without throwing.
- Running a model turn creates a JSONL file under `.pi/evopi/traces/`.
- Tool calls append `tool.call` and `tool.result` events.
- Provider calls append `provider.request` and `provider.response` without raw prompt text.
- `/evopi-trace`, `/evopi-trace last`, and `/evopi-trace path` return useful status.
- Cost, memory, job, tools, and eval commands register and write their initial state formats.


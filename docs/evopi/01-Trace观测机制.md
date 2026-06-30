# Trace Observability Harness

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


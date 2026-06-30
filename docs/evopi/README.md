# EvoPi Module Index

EvoPi uses Pi as the base coding agent and adds governance harnesses around the model/tool loop. The open-source projects in `../Pi开源参考项目调研_2026-06-30.md` are treated as design references, not code to vendor.

## 文档规则（项目级约定）

1. **每个决策都要写明「为什么这么选」的理由**。不只写「做什么」，还要写「为什么这样而不是那样」——含权衡、被否方案、依据的事实。每个模块的「最终方案」文档必须包含：**决策 / 实现 / 架构优点 / 少量缺点**，其中「决策」一栏要带理由。
2. 逐模块讨论，讨论清楚再落文档；进度见 [进度.md](进度.md)（单一进度事实源）。
3. 文档用中文书写（代码标识符、API 名、路径可保留英文）。
4. 工作目录是 `D:\evopi`（内层 `pi/` 是只读参考仓库）。

## Module Stack

| Layer | Module | Purpose | First artifact |
|---|---|---|---|
| Foundation | Trace Observability Harness | Persist agent runs, provider calls, tools, costs, approvals, eval scores, and memory events in a replayable format. | `.pi/extensions/evopi-trace/index.ts` |
| Core | Context Cost Harness | Control context budget, prompt cache layout, retrieval injection, and model/cost reporting. | Design document |
| Core | Skill Memory Harness | Route skills and project memory with trust, usage stats, and controlled self-evolution. | Design document |
| Core | Execution Harness | Turn user requests into governed jobs with plan/act/review, checkpoints, approvals, and acceptance. | Design document |
| Core | Tool Runtime Harness | Govern MCP/tools with budget, structured errors, sandbox policies, and browser verification. | Design document |
| Core | Eval Collaboration Harness | Run subagents, regression datasets, score gates, and worktree-isolated reviews. | Design document |
| Product | Docs & Productization Harness | Keep architecture docs, demos, acceptance metrics, and resume narrative in sync. | This docs tree |

## Implementation Order

1. Build Trace Observability first because every other module needs a durable event stream.
2. Add Context Cost next because it gives fast measurable output: cache hit rate, token budget, and request cost.
3. Add Skill Memory after trace/cost so skill routing can be measured and memory writes can be audited.
4. Add Execution and Tool Runtime once the policy and trace vocabulary is stable.
5. Add Eval Collaboration last so eval gates can reuse trace, skill stats, and execution job records.

## Current MVP

The first implemented artifact is the project-local `evopi-trace` extension. It records lightweight trace events and exposes initial command skeletons for every Harness module.

Trace events are written to:

- Pi session custom entries via `pi.appendEntry("evopi.trace", ...)`
- JSONL files under `.pi/evopi/traces/`

The extension intentionally avoids storing full provider payloads, full prompts, or full tool results by default. It records counts, role/type summaries, tool names, status, and context usage.

Additional module state is written as:

- `evopi.job` session entries for governed job state.
- `evopi.memory` session entries plus `.pi/evopi/memory/*.md`.
- `evopi.eval` session entries plus `.pi/evopi/evals/runs.jsonl`.

## Document Set

- [01 Trace 观测机制](01-Trace观测机制.md)
- [02 上下文成本机制](02-上下文成本机制.md)
- [03 技能记忆机制](03-技能记忆机制.md)
- [04 执行治理机制](04-执行治理机制.md)
- [05 工具运行时机制](05-工具运行时机制.md)
- [06 评测协作机制](06-评测协作机制.md)
- [07 文档产品化机制](07-文档产品化机制.md)
- [模块待办清单](模块待办清单.md)
- [讨论进度表](进度.md)

## Using The Trace MVP

Run Pi from `D:\evopi` so the project-local extension is discovered from `.pi/extensions/evopi-trace/index.ts`.

Available commands:

- `/evopi-trace` shows the current trace id, JSONL path, and event counters.
- `/evopi-trace last` shows the last recorded event types.
- `/evopi-trace path` shows the trace JSONL file path.
- `/evopi-cost` shows model/context usage and provider request counters.
- `/evopi-memory` shows memory file counts.
- `/evopi-memory add <fact>` appends a project memory entry.
- `/evopi-job` shows the current governed job.
- `/evopi-job start <title>` starts a job bound to the current trace.
- `/evopi-job plan <text>` records a plan for the current job.
- `/evopi-job acceptance <text>` records acceptance criteria.
- `/evopi-job passed|failed|blocked|running|queued|waitingApproval` updates status.
- `/evopi-tools` shows tool call/error counts.
- `/evopi-eval` shows eval record count.
- `/evopi-eval record <name> <score> [notes]` appends an eval score.


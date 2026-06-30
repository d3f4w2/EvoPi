# EvoPi Module Index

EvoPi uses Pi as the base coding agent and adds governance harnesses around the model/tool loop. The open-source projects in `../Pi开源参考项目调研_2026-06-30.md` are treated as design references, not code to vendor.

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

- [Trace Observability Harness](trace-observability-harness.md)
- [Context Cost Harness](context-cost-harness.md)
- [Skill Memory Harness](skill-memory-harness.md)
- [Execution Harness](execution-harness.md)
- [Tool Runtime Harness](tool-runtime-harness.md)
- [Eval Collaboration Harness](eval-collaboration-harness.md)
- [Docs & Productization Harness](docs-productization-harness.md)
- [Module Backlog](module-backlog.md)

## Using The Trace MVP

Run Pi from `D:\pi-agent` so the project-local extension is discovered from `.pi/extensions/evopi-trace/index.ts`.

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


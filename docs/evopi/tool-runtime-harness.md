# Tool Runtime Harness

## Summary

Tool Runtime Harness governs external tools and execution backends. It starts with structured errors and budgets, then grows into MCP broker, sandbox profiles, and browser verification.

## First Version

- Normalize tool failures into categories: timeout, auth, schema, permission, rate_limit, tool_bug, unknown.
- Add tool budget counters per turn and per job.
- Add protected path policy shared with Execution Harness.
- Record latency, error class, and tool result summaries in trace.
- The MVP implements `/evopi-tools` with in-memory call/error counters.

## Pi Hooks

- `session_start`: initialize configured tool backends and MCP metadata.
- `registerTool`: expose brokered tools.
- `tool_call`: enforce budget, capability profile, and sandbox policy.
- `tool_result`: classify failures and update tool reliability stats.
- `ctx.ui`: display approval prompts, browser screenshots, and structured reports.

## Sandbox Direction

- OpenSandbox is the design reference for policy, network control, credential vault, and pluggable runtimes.
- AIO Sandbox is the integration reference for unified browser/shell/file workspace.
- First implementation should not require a remote sandbox. Add backend adapters after local policy is stable.

## Acceptance Checks

- Tool errors are classified consistently.
- Tool budget exhaustion blocks or degrades gracefully.
- Protected path writes are denied or require approval.
- Browser verification results can be attached to trace later without changing event vocabulary.


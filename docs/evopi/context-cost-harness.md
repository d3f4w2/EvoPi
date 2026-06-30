# Context Cost Harness

## Summary

Context Cost Harness controls what enters the model request, how stable prompt segments are laid out for cache reuse, and how cost is measured per task. It should be implemented after Trace Observability so every request can be measured before optimization.

## First Version

- Add a request summary event on top of `evopi.trace` with context usage, message count, tool count, model id, and cache-related payload markers.
- Add a `/evopi-cost` command that reports current context usage and recent provider request/response counts. The MVP command is implemented in `.pi/extensions/evopi-trace/index.ts`.
- Keep prompt rewriting minimal: only annotate or reorder stable sections when Pi's provider payload supports it safely.
- Do not add codebase RAG in the first version.

## Pi Hooks

- `context`: inject only bounded summaries and selected memory snippets.
- `before_provider_request`: summarize provider payload, identify stable prefix/cache markers, optionally apply cache hints.
- `after_provider_response`: record HTTP status and cache-related response headers when available.
- `ctx.getContextUsage()`: report token pressure and context-window percentage.

## Design Rules

- Stable content should appear before volatile task content.
- Tool definitions and system prompt should be treated as cache-friendly segments.
- Memory and retrieved code must carry a token budget and source.
- Every injected item must be attributable in trace.

## Acceptance Checks

- `/evopi-cost` reports model, context tokens, context percentage, and last request count.
- Provider request trace shows message count and tool count without raw prompt text.
- Context injection has a fixed max token budget.
- A before/after run can show token or cache-hit improvement.


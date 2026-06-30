# Skill Memory Harness

## Summary

Skill Memory Harness manages long-term project memory and large skill sets without polluting the prompt. It combines lifecycle hooks from claude-mem, local-first retrieval from mempalace, readable Markdown storage from memU, and ratcheted self-improvement from darwin-skill.

## First Version

- Create `.pi/evopi/memory/` with readable Markdown files:
  - `INDEX.md` for categories and sources.
  - `MEMORY.md` for project facts, preferences, commands, and decisions.
  - `SKILLS.md` for candidate workflows and reusable tool patterns.
- Add Top-K routing metadata for skills: name, tags, trust, source, last used, success count, failure count.
- Inject only selected summaries through `context`.
- Persist memory writes and skill routing decisions through `evopi.trace`.
- The MVP implements `/evopi-memory` and `/evopi-memory add <fact>` for project memory files and session entries.

## Pi Hooks

- `resources_discover`: discover project and user skill resources.
- `context`: inject Top-K skill summaries and relevant memory.
- `message_end` / `tool_result`: capture candidate facts, failures, and repeated workflows.
- `session_before_compact`: write durable memory candidates before context is summarized away.
- `appendEntry`: store routing decisions, memory candidates, and approvals.

## Safety Rules

- Third-party skills start as untrusted.
- Automatically generated skills are candidates, not active skills.
- Each candidate must include source trace id, evidence, risk scan result, and approval status.
- Memory entries need scope: project, user, or global.
- Entries must be editable and removable.

## Acceptance Checks

- A session can reconstruct memory state from Markdown plus session entries.
- Only Top-K summaries enter context.
- Skill usage stats update after tool/task outcomes.
- Generated skill candidates are not enabled without approval.


---
description: Implement a feature using durable isolated subagents
argument-hint: "<feature request>"
---
Implement the following feature end-to-end using the agent-work tools:

$@

Workflow:
1. Create a feature with `agent_feature_init` (bootstraps requirements package).
2. Run a requirements interview (`/requirements` or `agent_requirements`) until handoff-ready.
   - Structured state is source of truth; render handoff before building.
3. Decompose only when useful; delegate feature-sized tasks rather than tiny coding steps.
4. Use read-only scouts only where uncertainty justifies them.
5. Delegate writing tasks with isolated worktrees (blocked until requirements handoff is ready unless explicitly forced).
6. Inspect each handoff. Use `agent_ask` or inspect the persistent session when details are unclear.
7. Review writing tasks with multi-perspective `agent_review`.
8. Integrate only reviewed, satisfactory task commits with `agent_integrate`.
9. Run final project checks and summarize acceptance-criteria coverage.

Keep coordinator context lean: consume handoffs first and retrieve full child context only on demand.
Apply the Critical Feedback Protocol throughout.

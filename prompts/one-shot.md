---
description: Implement a feature using durable isolated subagents
argument-hint: "<feature request>"
---
Implement the following feature end-to-end using the agent-work tools:

$@

Workflow:
1. Create a feature with `agent_feature_init` (bootstraps requirements package).
2. Run a skeptical requirements interview (`/requirements` or `agent_requirements`) until the specification can unambiguously be built end to end without clarification or invented requirements.
   - Structured state is source of truth. Resolve every readiness domain, define structured acceptance tests, and render the handoff before building.
   - Continue clarifying after cursory answers; present one visible recommendation with rationale for every ambiguity.
3. Decompose only when useful; delegate feature-sized tasks rather than tiny coding steps.
4. Use read-only scouts only where uncertainty justifies them.
5. Delegate writing tasks with isolated worktrees. Medium+ readiness cannot be bypassed; tiny/small opt-out requires explicit user approval and fully disclosed interviewer-selected answers.
6. Inspect each handoff and its concrete test evidence. Use `agent_ask` or inspect the persistent session when details are unclear.
7. Review writing tasks with multi-perspective `agent_review`; independently rerun every feasible required acceptance test.
8. Integrate only when evidence and verification match the current requirements revision and commit, with no unresolved verified high/critical finding.
9. Run final project checks and summarize acceptance-test evidence, exceptions, and residual risk.
10. For long operations, use `agent_operation` to inspect/replay progress or cancel; never infer failure from silence alone.

Keep coordinator context lean: consume handoffs first and retrieve full child context only on demand.
Apply the Critical Feedback Protocol throughout.

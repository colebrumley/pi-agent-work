---
description: Run a deterministic-first requirements interview before building
argument-hint: "<feature description> [--tier tiny|small|medium|large|epic]"
---
Run a requirements interview for: **$@**

Use `/skill:requirements-interviewer`.

Outcome:
1. Create or update schema-v2 structured requirements state under `.agent-work/features/<feature-id>/requirements/`.
2. Interview skeptically with the smallest sufficient tier. Prefer `agent_questionnaire` for 1–5 high-impact questions in TUI; fall back to chat on `ui_unavailable`/`cancelled` or in non-TUI modes.
3. For every ambiguity, present exactly one visible recommendation with rationale. Do not silently choose or stop after a cursory round.
4. Apply only structured patches through the requirements CLI and repeat until all 14 readiness domains are resolved or explicitly not applicable.
5. Define structured acceptance tests, fidelity applicability, adversarial categories, required evidence, accepted-risk assumptions, and bailout conditions.
6. Render `spec.md` and `handoff.md` only when the state can answer unambiguously: “Can this be built end to end as-is without further clarification or invented requirements?”
7. Summarize the readiness attestation, test obligations, approved exceptions/risks, and whether write delegation is unblocked.

Tiny/small may use only an explicit, named, state-recorded non-attested opt-out that defines every remaining answer. Medium+ cannot bypass readiness, and `--force` alone is never approval.

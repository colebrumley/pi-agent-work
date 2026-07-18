---
description: Run a deterministic-first requirements interview before building
argument-hint: "<feature description> [--tier tiny|small|medium|large|epic]"
---
Run a requirements interview for: **$@**

Use `/skill:requirements-interviewer`.

Outcome:
1. Create or update structured requirements state for this feature under `.agent-work/features/<feature-id>/requirements/`.
2. Interview with the smallest sufficient tier. Prefer `agent_questionnaire` automatically for 1–5 question batches in TUI; fall back to conversational questions on `ui_unavailable`/`cancelled` or non-TUI modes.
3. Apply only structured patches through the requirements CLI.
4. Render `spec.md` and `handoff.md` only from validated state.
5. Summarize remaining risks/deferred questions and whether write delegation is unblocked.

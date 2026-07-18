---
description: Multi-perspective adversarial critique of code or a writing task
argument-hint: "<target or featureId/taskId> [--depth quick|standard|deep]"
---
Run an adversarial critique of: **$@**

If the argument is a feature/task id, use `agent_review` with multi-perspective mode against that writing task's worktree.
Otherwise critique the path/description with read-only researchers and attackers via `agent_delegate`.

Rules:
- Read-only only.
- Require evidence citations and inspect the builder's recorded acceptance-test evidence.
- Independently rerun every feasible required acceptance test and verify approved exceptions for non-runnable tests.
- Independently verify critical/high findings against the exact reviewed commit.
- Produce severity-grouped findings, separated false positives, consensus, and risk assessment.
- Do not approve integration with stale evidence or unresolved verified critical/high findings.
- Apply the Critical Feedback Protocol: lead with problems, not praise.

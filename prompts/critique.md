---
description: Multi-perspective adversarial critique of code or a writing task
argument-hint: "<target or featureId/taskId> [--depth quick|standard|deep]"
---
Run an adversarial critique of: **$@**

If the argument is a feature/task id, use `agent_review` with multi-perspective mode against that writing task's worktree.
Otherwise critique the path/description with read-only researchers and attackers via `agent_delegate`.

Rules:
- Read-only only.
- Require evidence citations.
- Independently verify critical/high findings.
- Produce severity-grouped findings, stuck false positives, consensus, and risk assessment.
- Apply the Critical Feedback Protocol: lead with problems, not praise.

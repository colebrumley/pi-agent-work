# pi-agent-work

Durable, file-backed subagent orchestration for [Pi](https://pi.dev), with a deterministic requirements gate and multi-perspective review.

## Baked-in assumptions

This package is intentionally opinionated around a specific development setup:

- **Codex subscription for coordination.** The interactive Pi session is expected to use a subscription-backed Codex model. The coordinator owns the requirements conversation, decomposition, routing, and final synthesis.
- **OpenRouter for delegated work.** Isolated scouts, builders, and reviewers default to metered OpenRouter models. This combines a strong subscription-backed coordinator with independently routed workers whose actual API spend can be measured and optimized. You therefore need both working Codex subscription authentication and an `OPENROUTER_API_KEY` for the intended setup.
- **One-shot development.** The target workflow is to give a builder a sufficiently complete handoff that it can implement a feature correctly in one bounded attempt—not to discover core product decisions while coding.
- **Specification effort is front-loaded.** Requirements are interviewed, challenged, stored as structured state, validated, and rendered into a builder handoff before writes are allowed. Acceptance criteria, non-goals, decisions, rejected alternatives, risks, and deferred questions should be explicit.
- **The workflow is automatic.** Ask for a feature in normal language. The coordinator should initialize the feature, load the requirements interviewer, present high-impact questions via `agent_questionnaire` in TUI (chat fallback otherwise), and advance the lifecycle without making you remember slash commands.
- **Review remains mandatory.** “One shot” does not mean blindly trusting the first result. Writing happens in an isolated worktree, then receives adversarial review before explicit integration.

Models and routing weights are configurable. The readiness gate has no force-flag bypass: only tiny/small features may use a state-recorded, explicitly user-approved, visibly non-attested opt-out that still defines every remaining answer. Medium and larger features must pass normal readiness.

## Install or test

```bash
# Install from GitHub
pi install git:github.com/colebrumley/pi-agent-work

# Or test a local checkout
pi -e .
# Load only the extension while developing
pi -e ./extensions/agent-work/index.ts
# Install from a local checkout
pi install /absolute/path/to/pi-agent-work
```

## Tools

- `agent_feature_init` — create feature + bootstrap requirements package
- `agent_requirements` — init/validate/gaps/apply/render requirements state
- `agent_questionnaire` — interactive 1–5 question requirements batch in TUI (tabs + review/submit); returns structured answers. In print/JSON/RPC modes returns `ui_unavailable` so the coordinator falls back to chat. Not available to isolated subagents (`--no-extensions`).
- `agent_delegate` — isolated read-only or writing child with automatic cost/latency/quality routing (writes are gated)
- `agent_run` — durable dependency-graph scheduling with bounded parallel delegation/review, serial gated integration, cancellation/resume/retry, and terminal reflection
- `agent_reflection_proposal` — list and explicitly approve/audit-apply recurring reflection proposals (never auto-mutates behavior)
- `agent_router` — inspect active profile/routing policy and outcomes, or record accepted/corrected/failed feedback
- `/agent-profile` — interactively select or activate a named coordinator+routing profile (`--agent-profile` at startup)
- `agent_operation` — inspect/replay durable progress, list active operations, or cancel one without automatic retry
- `agent_inspect` — retrieve handoffs, events, invocation data, or full sessions
- `agent_ask` — resume the exact child session for follow-up or revision
- `agent_review` — multi-perspective critique + independent high/critical verification
- `agent_integrate` — cherry-pick a reviewed task commit
- `agent_maintenance` — dry-run-first failed-diagnostic pruning, successful compaction, owned cleanup, and foreign Git diagnostics

The interactive footer keeps Pi's token/cache, context, model/thinking, session, and extension-status information, and adds repository/branch/SHA, dirty and upstream divergence state. Cost is labeled `OR` and includes only OpenRouter-reported spend: direct calls in the current session plus repository-lifetime delegated-agent telemetry (shown separately as `agents`). Subscription-backed usage is excluded.

Optional explicit prompts: `/one-shot`, `/critique`

Optional explicit skill command: `/skill:requirements-interviewer`

## Artifact layout

```text
.agent-work/
├── manifest.json
├── router.json                 # editable agent profiles + delegated routing (schema v2)
├── routing-decisions.jsonl     # routes, actual usage/cost/latency, corrections
├── progress/<operation-id>.jsonl # correlated durable progress for TUI/API/resume
├── proposals/<proposal-id>.json  # recurring findings; operator approval required
└── features/<feature-id>/
    ├── brief.md
    ├── feature.json
    ├── decisions.jsonl
    ├── requirements/
    │   ├── requirements.json
    │   ├── decision-log.json
    │   ├── spec.md
    │   └── handoff.md
    ├── runs/<run-id>/           # graph.json, state.json, events.jsonl, reflection.json
    └── tasks/<task-id>/
        ├── task.json
        ├── status.json
        ├── current.json
        ├── critique/           # multi-perspective review outputs
        ├── verification-report.json # schema-v2 independent report bound to exact commit
        └── attempts/001/
            ├── invocation.json
            ├── handoff.json
            ├── evidence.json   # sanitized bounded builder evidence + artifact hashes
            ├── evidence-manifest.json # hashed lineage-aware evidence records
            ├── integrity.json, ownership.json, retention-audit.jsonl
            ├── events.jsonl
            ├── session.json
            ├── sessions/
            └── worktree/       # writing tasks only
```

## Lifecycle

```text
requirements interview → handoff-ready
pending → running → review → integrated
                 ↘ done | blocked | failed | cancelled
```

Write delegation requires a schema-v2 handoff-ready requirements package. `forceRequirements` is retained for API compatibility but never constitutes risk acceptance or bypasses validation. Existing schema-v1 packages remain loadable, migrate without losing prior content, and intentionally remain not-ready until re-interviewed.

## Parallel runs and reflection

Submit a complete graph with `agent_run`. The graph is validated atomically (duplicates, missing/self dependencies, and cycles) before launch. Ready builders, scouts, and pipelined reviewers share a repository-configurable cap (`.agent-work/config.json` → `runConcurrency`, default 3); a run may override it. Writing tasks still require exact-commit review and verification, and integration remains deterministic and serial. Runs can be inspected, cancelled, resumed after restart, and explicitly retried; failures never retry automatically.

Every settled run records one non-blocking reflection or an evidence-insufficient skip. Reflection reads only allowlisted structured lifecycle state and numeric telemetry—not sessions, prompts, raw prose, environment values, credentials, or source files. Recurring findings become proposals, but approval/application is an auditable acknowledgement and never changes code, prompts, routing, or configuration automatically.

## Progress and cancellation

Delegation, review, verification, follow-up, and integration emit an immediate start update, meaningful phase/milestone updates, and a heartbeat every 20 seconds. A task is marked stalled only after ten minutes without model, tool, command-output, or heartbeat progress. There is no default total-duration kill; optional `hardTimeoutMs` remains an explicit override.

Every update carries feature/task/attempt/operation IDs and is appended to `.agent-work/progress/` before best-effort live delivery. Use `agent_operation` to inspect, replay, list, or cancel. Cancellation terminates the child process tree, keeps artifacts/diagnostics, records one terminal event, and never automatically retries.

Progress distinguishes active work from inactivity by monitoring structured child events, tool activity, commands, tests, file changes, and lifecycle status. Routine activity is coalesced into heartbeats; raw assistant text, hidden reasoning, and secrets are never used as progress output. Reload Pi after updating the extension so existing sessions pick up these hooks.

## Verification gate

Every requirements package defines structured acceptance tests using the preferred fidelity order: real end-to-end, realistic smoke, integration, unit, then static checks. Higher-fidelity omissions require an explicit rationale; legitimately untestable cases require a test-specific user approval tied to the exact requirements revision, substitute verification, and residual risk.

A writing task records bounded, sanitized evidence including commands, environment, scenarios, results, and artifact hashes. Review reruns every feasible required test and writes `verification-report.json` for the exact implementation commit and requirements revision. Integration refuses stale evidence, failed/non-runnable non-exempt tests, missing adversarial coverage, or unresolved verified high/critical findings. Any code change requires fresh review.

The default review cadence is broad for the initial writing-task review, focused after a narrow `agent_ask(allowChanges=true)` amendment, and broad again only when the recorded changed surface expands architecture, trust/security boundaries, public contracts, or acceptance scope. `agent_review(mode="broad"|"focused"|"final-gate")` provides explicit overrides. Focused and final gates use one reviewer rather than a critique panel; high-risk final gates rerun exact-current checks and record fresh evidence.

Successful integrated attempts compact raw event/query diagnostics after ownership and integrity checks. Failed, blocked, cancelled, and stalled diagnostics remain for 30 days and are only removed through `agent_maintenance(action="prune", dryRun=true)` followed by the returned token. Cleanup removes only clean, reachable, registered cbpi worktrees; foreign Git anomalies are report-only and repair plans never mutate them.

## Design contracts

- Requirements are structured state, not chat prose
- Builder handoff refuses unless every readiness domain is resolved and end-to-end buildability is explicitly attested (or an eligible explicit tiny/small opt-out is recorded)
- Schema-v1 requirements migrate losslessly to incomplete schema v2 and require re-interview
- Structured acceptance tests, bounded sanitized builder evidence, exact requirements/commit hashes, and fresh machine-readable independent verification gate integration
- Do build / Do NOT build + decisions with rejected alternatives
- Multi-perspective critique with independent verification of critical/high findings
- Always-on Critical Feedback Protocol for coordinator and children
- Interactive questionnaire is coordinator-only; subagents block on ambiguity instead of guessing

## Model routing and agent profiles

Named **agent profiles** swap the interactive coordinator model and delegated-agent routing together. Profiles live in repository-local `.agent-work/router.json` (schema version 2) and can be edited without changing plugin source.

### Seeded profiles

| Profile | Coordinator | Delegated routing |
| --- | --- | --- |
| **Pro** (default) | `openai-codex/gpt-5.6-sol` | Luna for trivial scouts; Terra for ordinary builders, non-trivial scouts, and reviewers; automatic Terra→Sol escalation only when the quality floor requires it |
| **Economy** | `openai-codex/gpt-5.6-sol` | Strict pins: GLM for builders and scouts, Sol for reviewers (complexity/risk/retry ignored unless overridden) |

Fresh repositories default to **Pro**. An untouched schema-version-1 default migrates to Pro; a customized v1 router is preserved field-for-field as an editable **Legacy** profile (active) while Pro and Economy are added. Migration is idempotent.

### Activation

- Interactive selector: `/agent-profile`
- Named command: `/agent-profile Economy`
- Startup flag: `pi --agent-profile Pro` (takes precedence for that startup and persists on success)

The last **successfully** activated profile is remembered per repository. Activation is atomic: every referenced coordinator and delegated model must be known and have configured authentication before anything changes. Failures restore prior coordinator, routing, status, and persisted selection and show an actionable error. The active profile is visible via the `agent-profile` status line and `agent_router(action="status")`.

Pass `model` to `agent_delegate` for an explicit per-delegation override; it still wins over the active profile without changing it. Optional `complexity`, `risk`, and `prefer` hints refine utility-mode profiles. Run `agent_router(action="report")` to compare route count, corrections, failures, cost, and elapsed time by model.

`route.json` beside each invocation captures the active profile, classification, minimum quality, candidate scores, and selection rationale. Actual token usage, API cost, and duration are saved in `invocation.json` and the append-only global telemetry log.

Example custom profile entry (pinned mode):

```json
{
  "name": "Lab",
  "coordinatorModel": "openai-codex/gpt-5.6-sol",
  "routing": {
    "mode": "pinned",
    "pins": {
      "builder": "openrouter/z-ai/glm-5.2",
      "scout": "openrouter/z-ai/glm-5.2",
      "reviewer": "openai-codex/gpt-5.6-sol"
    }
  }
}
```

## Git behavior

- `.agent-work/` is added to repository-local `.git/info/exclude`
- Writing tasks need a clean coordinator worktree
- Each writing attempt gets a dedicated branch/worktree and task commit
- Integration is explicit cherry-pick

## Requirements CLI

```bash
node --experimental-strip-types requirements/src/cli.ts --help
node --experimental-strip-types requirements/src/cli.ts init "Feature" --tier medium --dir .agent-work/features/<id>/requirements
node --experimental-strip-types requirements/src/cli.ts gaps --dir .agent-work/features/<id>/requirements
node --experimental-strip-types requirements/src/cli.ts validate --dir .agent-work/features/<id>/requirements
node --experimental-strip-types requirements/src/cli.ts migrate --dir .agent-work/features/<id>/requirements
node --experimental-strip-types requirements/src/cli.ts render-handoff --dir .agent-work/features/<id>/requirements
```

`render-handoff` fails closed until all 14 readiness domains are resolved or explicitly not applicable with rationale, structured acceptance tests exist, accepted risks have assumptions and bailout conditions, and the end-to-end buildability answer is unambiguously yes. Tiny/small opt-outs must be explicit and state-recorded; `--force` does not bypass these rules.

Schemas: `requirements/requirements.schema.json` and `schemas/agent-work.schema.json`.

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
- `agent_router` — inspect routing policy and outcomes, or record accepted/corrected/failed feedback
- `agent_operation` — inspect/replay durable progress, list active operations, or cancel one without automatic retry
- `agent_inspect` — retrieve handoffs, events, invocation data, or full sessions
- `agent_ask` — resume the exact child session for follow-up or revision
- `agent_review` — multi-perspective critique + independent high/critical verification
- `agent_integrate` — cherry-pick a reviewed task commit

The interactive footer keeps Pi's token/cache, context, model/thinking, session, and extension-status information, and adds repository/branch/SHA, dirty and upstream divergence state. Cost is labeled `OR` and includes only OpenRouter-reported spend: direct calls in the current session plus repository-lifetime delegated-agent telemetry (shown separately as `agents`). Subscription-backed usage is excluded.

Optional explicit prompts: `/one-shot`, `/requirements`, `/critique`

Optional explicit skill command: `/skill:requirements-interviewer`

## Artifact layout

```text
.agent-work/
├── manifest.json
├── router.json                 # editable model utility policy
├── routing-decisions.jsonl     # routes, actual usage/cost/latency, corrections
├── progress/<operation-id>.jsonl # correlated durable progress for TUI/API/resume
└── features/<feature-id>/
    ├── brief.md
    ├── feature.json
    ├── decisions.jsonl
    ├── requirements/
    │   ├── requirements.json
    │   ├── decision-log.json
    │   ├── spec.md
    │   └── handoff.md
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

## Progress and cancellation

Delegation, review, verification, follow-up, and integration emit an immediate start update, meaningful phase/milestone updates, and a heartbeat every 20 seconds. After 60 seconds without child output or structured-event activity, the monitor checks liveness and warns every 60 seconds until activity resumes. Silence does not abort a live child; optional `hardTimeoutMs` is disabled by default.

Every update carries feature/task/attempt/operation IDs and is appended to `.agent-work/progress/` before best-effort live delivery. Use `agent_operation` to inspect, replay, list, or cancel. Cancellation terminates the child process tree, keeps artifacts/diagnostics, records one terminal event, and never automatically retries.

Progress distinguishes active work from inactivity by monitoring structured child events, tool activity, commands, tests, file changes, and lifecycle status. Routine activity is coalesced into heartbeats; raw assistant text, hidden reasoning, and secrets are never used as progress output. Reload Pi after updating the extension so existing sessions pick up these hooks.

## Verification gate

Every requirements package defines structured acceptance tests using the preferred fidelity order: real end-to-end, realistic smoke, integration, unit, then static checks. Higher-fidelity omissions require an explicit rationale; legitimately untestable cases require a test-specific user approval tied to the exact requirements revision, substitute verification, and residual risk.

A writing task records bounded, sanitized evidence including commands, environment, scenarios, results, and artifact hashes. Review reruns every feasible required test and writes `verification-report.json` for the exact implementation commit and requirements revision. Integration refuses stale evidence, failed/non-runnable non-exempt tests, missing adversarial coverage, or unresolved verified high/critical findings. Any code change requires fresh review.

## Design contracts

- Requirements are structured state, not chat prose
- Builder handoff refuses unless every readiness domain is resolved and end-to-end buildability is explicitly attested (or an eligible explicit tiny/small opt-out is recorded)
- Schema-v1 requirements migrate losslessly to incomplete schema v2 and require re-interview
- Structured acceptance tests, bounded sanitized builder evidence, exact requirements/commit hashes, and fresh machine-readable independent verification gate integration
- Do build / Do NOT build + decisions with rejected alternatives
- Multi-perspective critique with independent verification of critical/high findings
- Always-on Critical Feedback Protocol for coordinator and children
- Interactive questionnaire is coordinator-only; subagents block on ambiguity instead of guessing

## Model routing

The interactive coordinator remains on the model you selected (for example, subscription-backed `openai-codex/gpt-5.6-sol`). Delegated tasks are routed independently. The default policy favors `openrouter/z-ai/glm-5.2`, promotes medium/high-risk work to faster or stronger models, applies a scarcity penalty to subscription models, and raises the quality floor after each retry.

Pass `model` to `agent_delegate` for an explicit override. Otherwise, optional `complexity`, `risk`, and `prefer` hints refine the explainable heuristic. Edit `.agent-work/router.json` to calibrate model quality, speed, relative cost, objective weights, and subscription scarcity. Run `agent_router(action="report")` to compare route count, corrections, failures, cost, and elapsed time by model; writing follow-ups are automatically counted as corrections.

`route.json` beside each invocation captures the classification, minimum quality, every candidate score, and selection rationale. Actual token usage, API cost, and duration are saved in `invocation.json` and the append-only global telemetry log.

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

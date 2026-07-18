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

Models and routing weights are configurable, and the requirements gate can be forcibly bypassed, but doing so departs from the workflow this package is designed to support.

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
        └── attempts/001/
            ├── invocation.json
            ├── handoff.json
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

Write delegation requires a handoff-ready requirements package (or explicit `forceRequirements`).

## Design contracts

- Requirements are structured state, not chat prose
- Builder handoff refuses unless valid/ready
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
```

Schema: `requirements/requirements.schema.json` and `schemas/agent-work.schema.json`.

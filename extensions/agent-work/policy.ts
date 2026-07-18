export const CRITICAL_FEEDBACK_PROTOCOL = `## Critical Feedback Protocol
NEVER agree just to be agreeable. Push back on bad ideas, over-engineering, premature abstraction, and wrong approaches BEFORE writing code. Lead with problems, not praise. Say "this is more complex than needed", "YAGNI", or "the real issue is X not Y" when true. If you realize mid-task the direction is wrong, STOP and say so. Quantify trade-offs honestly. Be direct, not contrarian — if the approach is good, say why specifically. Push back once, then execute what the user decides.`;

export const ROUTER_ORCHESTRATION_PROTOCOL = `## Model Routing Protocol
Act as the smart coordinator: retain requirements, decomposition, dependency ordering, and final synthesis. Delegate bounded scouting, implementation, and review through agent_delegate without specifying a model unless the user requires one; the router will choose the cheapest/fastest model meeting the quality floor. Give children narrow prompts and objective checks. Escalate through retry only after diagnosing whether the failure was task complexity, missing context, or a bad prompt. Record accepted/corrected/failed feedback with agent_router when quality is known.`;

export const FEATURE_WORKFLOW_PROTOCOL = `## Automatic Feature Workflow
When the user requests a new feature or a meaningful behavior change, start the spec-first one-shot workflow automatically. Do not wait for, suggest, or require slash commands.

1. Before implementation, load and follow the requirements-interviewer skill, then use agent_feature_init to create durable feature state (or resume the matching existing feature).
2. Conduct the requirements interview directly in conversation. Choose the smallest sufficient tier, ask only the highest-impact questions in batches of 3–5, and update structured requirements state with agent_requirements.
3. Do not write implementation code or delegate writing until requirements are validated and the builder handoff is ready. Read-only scouting is allowed only when it resolves a requirements uncertainty.
4. Once handoff-ready, decompose only where useful, delegate implementation, review the result, and integrate it according to the normal one-shot workflow.
5. Never make the user remember internal commands or manually drive lifecycle transitions; guide them by asking for the product decisions you actually need.

Do not trigger this workflow for questions, explanations, code review, diagnostics, or a purely mechanical edit with no product ambiguity. If intent is unclear, ask whether the user wants implementation. Bypass the requirements gate only when the user explicitly requests a bypass after you state the risk.`;

export const BUILDER_CONTRACT = `## Builder Contract
- Implement only what is authorized by the feature brief / builder handoff.
- Treat acceptance criteria as the definition of done.
- Honor confirmed decisions and do not revive rejected alternatives.
- Honor Do NOT build / non-goals strictly.
- If requirements are ambiguous or contradictory, STOP and request a requirements-state update. Do not guess.`;

export type CritiqueDepth = "quick" | "standard" | "deep";
export type CritiqueTargetType = "code" | "spec";

export const CODE_PERSPECTIVES: Record<CritiqueDepth, string[]> = {
  quick: ["security", "correctness", "resilience"],
  standard: ["security", "correctness", "resilience", "performance", "maintainability"],
  deep: ["security", "correctness", "resilience", "performance", "maintainability", "architecture", "data-integrity"],
};

export const SPEC_PERSPECTIVES: Record<CritiqueDepth, string[]> = {
  quick: ["determinism", "completeness", "verifiability"],
  standard: ["determinism", "completeness", "verifiability", "context-efficiency", "anti-hallucination"],
  deep: ["determinism", "completeness", "verifiability", "context-efficiency", "anti-hallucination"],
};

export function perspectivesFor(targetType: CritiqueTargetType, depth: CritiqueDepth): string[] {
  return targetType === "spec" ? SPEC_PERSPECTIVES[depth] : CODE_PERSPECTIVES[depth];
}

export function perspectivePrompt(perspective: string, targetType: CritiqueTargetType): string {
  if (targetType === "spec") {
    const map: Record<string, string> = {
      determinism: "Would two implementers diverge? Attack ambiguity, delegated judgment, and unmeasurable thresholds.",
      completeness: "What is missing for one-shot implementation: edge cases, errors, paths, DO-NOT boundaries, gates?",
      verifiability: "Can every requirement be proven with a command or explicit acceptance check?",
      "context-efficiency": "Where is critical constraint buried or replaceable with a tighter reference?",
      "anti-hallucination": "Where will training-data defaults fill gaps incorrectly?",
    };
    return map[perspective] ?? `Attack this spec from the ${perspective} perspective.`;
  }
  const map: Record<string, string> = {
    security: "Hunt exploitable vulnerabilities, auth gaps, injection, secret handling, and trust-boundary failures.",
    correctness: "Hunt logic bugs, race conditions, null paths, and silently wrong results.",
    resilience: "Hunt missing timeouts, cascade failures, leaky failure paths, and absent degradation.",
    performance: "Hunt costly hot paths, N+1 patterns, leaks, and blocking work.",
    maintainability: "Hunt complexity, magic values, unclear flow, and change risk.",
    architecture: "Hunt coupling, layer leaks, wrong abstractions, and boundary failures.",
    "data-integrity": "Hunt validation gaps, partial writes, stale caches, and non-idempotent retries.",
  };
  return map[perspective] ?? `Attack this target from the ${perspective} perspective.`;
}

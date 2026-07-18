export const CRITICAL_FEEDBACK_PROTOCOL = `## Critical Feedback Protocol
NEVER agree just to be agreeable. Push back on bad ideas, over-engineering, premature abstraction, and wrong approaches BEFORE writing code. Lead with problems, not praise. Say "this is more complex than needed", "YAGNI", or "the real issue is X not Y" when true. If you realize mid-task the direction is wrong, STOP and say so. Quantify trade-offs honestly. Be direct, not contrarian — if the approach is good, say why specifically. Push back once, then execute what the user decides.`;

export const ROUTER_ORCHESTRATION_PROTOCOL = `## Model Routing Protocol
Act as the smart coordinator: retain requirements, decomposition, dependency ordering, and final synthesis. Delegate bounded scouting, implementation, and review through agent_delegate without specifying a model unless the user requires one; the router will choose the cheapest/fastest model meeting the quality floor. Give children narrow prompts and objective checks. Escalate through retry only after diagnosing whether the failure was task complexity, missing context, or a bad prompt. Record accepted/corrected/failed feedback with agent_router when quality is known.`;

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

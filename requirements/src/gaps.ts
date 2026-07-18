/**
 * Deterministic gap analysis.
 *
 * This is the boundary between deterministic tooling and LLM judgment:
 * the CLI computes *what is missing or unresolved* (a fact about the state);
 * the interviewer skill turns those gaps into a small batch of high-leverage
 * questions (judgment). The CLI does not write questions.
 */

import type { RequirementsState, Tier } from "./types.ts";
import { validateRequirements } from "./validate-requirements.ts";

export interface Gap {
  area: string;
  impact: "high" | "medium" | "low";
  detail: string;
}

export interface GapReport {
  tier: Tier;
  handoffReady: boolean;
  gaps: Gap[];
}

export function analyzeGaps(state: RequirementsState): GapReport {
  const report = validateRequirements(state);
  const gaps: Gap[] = [];

  // Errors are the highest-leverage gaps — they block validity outright.
  for (const e of report.errors) {
    gaps.push({ area: e.path ?? e.code, impact: "high", detail: e.message });
  }
  // Unresolved blockers (blocking questions, proposed assumptions).
  for (const b of report.blockers) {
    if (!report.errors.includes(b))
      gaps.push({ area: b.path ?? b.code, impact: "high", detail: b.message });
  }

  // Softer, judgment-worthy gaps that are not hard errors:
  if (state.tier !== "tiny" && state.goals.length > 0 && state.nonGoals.length === 0)
    gaps.push({ area: "nonGoals", impact: "medium", detail: "Goals exist but no non-goals — scope boundary is undefined." });

  if (state.acceptanceCriteria.length === 0 && state.goals.length > 0)
    gaps.push({ area: "acceptanceCriteria", impact: "high", detail: "Goals exist with no acceptance criteria — 'done' is undefined." });

  const decisionsNeedingRationale = state.decisions.filter(
    (d) => d.status === "confirmed" && !d.rationale?.trim()
  );
  for (const d of decisionsNeedingRationale)
    gaps.push({ area: "decisions", impact: "medium", detail: `Decision "${d.id}" is confirmed without a rationale.` });

  // Functional requirements with no acceptance criterion pointing at them.
  const coveredReqs = new Set(
    state.acceptanceCriteria.map((ac) => ac.linkedRequirement).filter(Boolean) as string[]
  );
  for (const r of state.functionalRequirements) {
    if (!coveredReqs.has(r.id))
      gaps.push({ area: "coverage", impact: "low", detail: `Requirement "${r.id}" has no acceptance criterion verifying it.` });
  }

  // Warnings surface as low-impact gaps (testability, dangling refs, etc.).
  for (const w of report.warnings) {
    if (!report.blockers.includes(w))
      gaps.push({ area: w.path ?? w.code, impact: "low", detail: w.message });
  }

  const order = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => order[a.impact] - order[b.impact]);

  return { tier: state.tier, handoffReady: report.handoffReady, gaps };
}

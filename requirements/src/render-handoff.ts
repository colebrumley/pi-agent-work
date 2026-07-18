/**
 * Renderer: builder handoff package.
 *
 * Stricter and more operational than the spec. Refuses to render unless the
 * state validates and has no unresolved blockers — a builder agent must never
 * receive a handoff generated from invalid or under-specified state.
 *
 * Returns either { ok: true, markdown } or { ok: false, report } so the caller
 * can surface exactly why the handoff was withheld.
 */

import type { RequirementsState } from "./types.ts";
import type { ValidationReport } from "./validate-requirements.ts";
import { validateRequirements } from "./validate-requirements.ts";

export type HandoffResult =
  | { ok: true; markdown: string }
  | { ok: false; report: ValidationReport };

function h(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}
function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "- _(none)_";
}

export function renderHandoff(
  state: RequirementsState,
  opts: { force?: boolean } = {}
): HandoffResult {
  const report = validateRequirements(state);
  if (!opts.force && !report.handoffReady) {
    return { ok: false, report };
  }

  const out: string[] = [];

  out.push(h(1, `Builder Handoff: ${state.featureName}`));
  out.push(`> Tier: **${state.tier}** · Source of truth: \`requirements.json\` + \`decision-log.json\`.`);
  if (opts.force && !report.handoffReady)
    out.push(`> ⚠️ FORCED handoff: emitted with ${report.errors.length} error(s) and ${report.blockers.length} blocker(s). Builders proceed at risk.`);
  out.push("");

  out.push("**Contract:** Builders MUST NOT reinterpret, expand, or narrow these requirements. If reality contradicts them, STOP and update the requirements state (re-run the interviewer) before writing code. This document is downstream of structured state, not a license to improvise.");
  out.push("");

  out.push(h(2, "Do build"));
  const doBuild = [
    ...state.functionalRequirements.filter((r) => r.priority !== "could").map((r) => `[${r.id}] ${r.text}`),
    ...state.goals.map((g) => `Goal: ${g.text}`),
  ];
  out.push(bullets(doBuild));
  out.push("");

  out.push(h(2, "Do NOT build"));
  const doNot = [
    ...state.nonGoals.map((g) => g.text),
    ...state.outOfScope.map((o) => o.text),
  ];
  out.push(bullets(doNot));
  out.push("");

  out.push(h(2, "Required behavior"));
  out.push(bullets(state.functionalRequirements.map((r) => `[${r.id}] (${r.priority}) ${r.text}`)));
  if (state.nonFunctionalRequirements.length) {
    out.push("");
    out.push("Non-functional:");
    out.push(bullets(state.nonFunctionalRequirements.map((r) => `[${r.id}] ${r.text}`)));
  }
  out.push("");

  out.push(h(2, "Acceptance criteria (definition of done)"));
  if (state.acceptanceCriteria.length) {
    out.push("| ID | Criterion | Verifies | Priority | Testability |");
    out.push("| --- | --- | --- | --- | --- |");
    out.push(
      state.acceptanceCriteria
        .map((ac) => `| ${ac.id} | ${ac.criterion} | ${ac.linkedRequirement ?? ac.linkedGoal ?? "—"} | ${ac.priority} | ${ac.testability} |`)
        .join("\n")
    );
  } else out.push("- _(none)_");
  out.push("");

  out.push(h(2, "Relevant decisions"));
  const confirmed = state.decisions.filter((d) => d.status === "confirmed").sort((a, b) => a.sequence - b.sequence);
  if (confirmed.length)
    out.push(
      confirmed
        .map((d) => `- **[${d.id}]** ${d.decision}\n  - Why: ${d.rationale ?? "—"}\n  - Rejected/alternatives: ${d.alternatives.join("; ") || "none recorded"}`)
        .join("\n")
    );
  else out.push("- _(none confirmed)_");
  out.push("");

  out.push(h(2, "Known risks"));
  if (state.risks.length)
    out.push(bullets(state.risks.map((r) => `${r.text} — ${r.likelihood}/${r.impact}, ${r.status}${r.mitigation ? `; mitigation: ${r.mitigation}` : ""}`)));
  else out.push("- _(none recorded)_");
  out.push("");

  out.push(h(2, "Known assumptions"));
  out.push(bullets(state.assumptions.map((a) => `${a.text} _(${a.status})_`)));
  out.push("");

  out.push(h(2, "Deferred / accepted-risk questions"));
  const deferred = state.openQuestions.filter((q) => q.status === "deferred" || q.status === "accepted-risk");
  out.push(bullets(deferred.map((q) => `${q.question} → ${q.status}${q.possibleDefault ? ` (default if forced: ${q.possibleDefault})` : ""}`)));
  out.push("");

  if (state.dependencies.length) {
    out.push(h(2, "Dependencies"));
    out.push(bullets(state.dependencies.map((d) => `${d.name} (${d.kind}) — ${d.status}`)));
    out.push("");
  }

  // Operational sections, emitted with their not-applicable rationale preserved.
  for (const [title, sec] of [
    ["Rollout / migration", state.rollout],
    ["Observability", state.observability],
    ["Security & privacy", state.security],
    ["Operational readiness", state.operational],
  ] as const) {
    if (sec.applicable && sec.notes.length === 0 && !("phases" in sec && (sec as any).phases.length)) continue;
    out.push(h(2, title));
    if (!sec.applicable) out.push(`- Not applicable: ${sec.notApplicableReason ?? "unspecified"}`);
    else {
      if ("phases" in sec && (sec as any).phases.length)
        out.push((sec as any).phases.map((p: string, i: number) => `${i + 1}. ${p}`).join("\n"));
      out.push(bullets(sec.notes));
    }
    out.push("");
  }

  out.push(h(2, "Boundaries for planner/builder agents"));
  out.push(bullets([
    "Implement only what is in *Do build* and *Required behavior*.",
    "Anything in *Do NOT build* is out of scope — do not add it even if it seems helpful.",
    "Treat acceptance criteria as the definition of done; do not mark complete until each is satisfiable.",
    "Honor confirmed decisions exactly; do not revisit rejected alternatives without updating the decision log.",
    ...state.handoffNotes,
  ]));
  out.push("");

  out.push("---");
  out.push("_If you find a requirement ambiguous or contradictory, do not guess. Halt and request a requirements-state update._");
  out.push("");

  return { ok: true, markdown: out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n" };
}

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
  // `force` is retained for CLI compatibility but is never an implicit bypass.
  // A bypass is represented in state and validates only for explicit tiny/small opt-out.
  if (!report.handoffReady) return { ok: false, report };

  const out: string[] = [];

  out.push(h(1, `Builder Handoff: ${state.featureName}`));
  out.push(`> Tier: **${state.tier}** · Source of truth: \`requirements.json\` + \`decision-log.json\`.`);
  if (state.readinessOptOut)
    out.push(`> ⚠️ READINESS OPT-OUT (NON-ATTESTED): explicitly requested by ${state.readinessOptOut.approvedBy}. This is not a normal readiness attestation.`);
  out.push("");

  out.push("**Contract:** Builders MUST NOT reinterpret, expand, or narrow these requirements. If reality contradicts them, STOP immediately, preserve work, report the blocking discovery, and return the feature to requirements clarification. Never guess. This document is downstream of structured state, not a license to improvise.");
  out.push("");

  out.push(h(2, "Build-readiness contract"));
  if (state.readinessOptOut) {
    out.push(`- **NON-ATTESTED tiny/small opt-out:** ${state.readinessOptOut.requestText}`);
    out.push(bullets(state.readinessOptOut.choices.map((c) => `[${c.questionId}] ${c.answer} — Rationale: ${c.rationale}`)));
  } else {
    out.push("- **READINESS ATTESTATION: YES.** This specification can be built hands-off end to end as-is without further clarification or invented requirements, within the listed assumptions and stop conditions.");
  }
  out.push(`- **Requirements revision:** \`${state.requirementsRevision}\``);
  out.push(`- **Working parameters:** ${state.readiness.workingParameters}`);
  out.push(`- **Assessment rationale:** ${state.readiness.rationale}`);
  out.push("- **Assumptions:**");
  out.push(bullets(state.readiness.assumptions));
  out.push("- **Bailout stop conditions:**");
  out.push(bullets(state.readiness.stopConditions));
  out.push("- **Mandatory domain assessment:**");
  out.push(bullets(state.readiness.domains.map((d) => `${d.domain}: ${d.status} — ${d.rationale}`)));
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

  out.push(h(2, "Acceptance tests and verification standards"));
  out.push("Use every applicable layer in order: **real end-to-end → realistic smoke → integration → unit → static checks**. Any skipped higher-fidelity layer requires the rationale below or a valid named user-approved exception.");
  out.push("");
  out.push("Testing applicability:");
  out.push(bullets(state.testingStandards.fidelity.map((x) => `${x.name}: ${x.applicable ? "applicable" : "not applicable"} — ${x.rationale}`)));
  out.push("");
  out.push("Adversarial coverage:");
  out.push(bullets(state.testingStandards.adversarial.map((x) => `${x.name}: ${x.applicable ? "applicable" : "not applicable"} — ${x.rationale}`)));
  out.push("");
  for (const test of state.acceptanceTests) {
    out.push(h(3, `[${test.id}] ${test.name}`));
    out.push(`- Setup: ${test.setup}`);
    out.push(`- Action: ${test.action}`);
    out.push(`- Expected result: ${test.expectedResult}`);
    out.push(`- Fidelity layer: ${test.fidelityLayer}`);
    out.push(`- Linked requirement/criterion: ${test.linkedRequirement}`);
    out.push(`- Categories: ${test.categories.join(", ") || "none"}`);
    out.push(`- Required evidence: ${test.requiredEvidence}`);
    const exception = state.testExceptions.find((x) => x.testId === test.id);
    if (exception) out.push(`- Approved exception: ${exception.reason}; substitute: ${exception.substituteVerification}; residual risk: ${exception.residualRisk}; approved by ${exception.approvedBy}`);
    out.push("");
  }

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
  out.push(bullets(deferred.map((q) => `${q.question} → ${q.status}${q.acceptedRiskAssumption ? `; assumption: ${q.acceptedRiskAssumption}; stop condition: ${q.stopCondition}` : ""}`)));
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
    "Treat acceptance tests and evidence as deliverables. Record sanitized bounded evidence with commands, results, environment, scenarios, relevant output, artifact paths, and hashes.",
    "Do not claim completion while any required test fails or cannot run. Continue, bail to clarification, or obtain a valid named user-approved exception.",
    "Review and integration require fresh independent verification tied to this requirements revision and the exact current implementation commit; any code change invalidates approval.",
    "A guarantee-breaking unknown requires status=blocked: stop, preserve work, report it, and return to clarification without integration.",
    ...state.handoffNotes,
  ]));
  out.push("");

  out.push("---");
  out.push("_If you find a requirement ambiguous or contradictory, do not guess. Halt and request a requirements-state update._");
  out.push("");

  return { ok: true, markdown: out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n" };
}

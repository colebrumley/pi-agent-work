/**
 * Renderer: human-readable requirements spec, generated *from structured data*.
 *
 * The LLM never freewrites this document. Stable ordering and headings make the
 * output diff-friendly for version control.
 */

import type {
  RequirementsState,
  Decision,
  OpenQuestion,
  Priority,
} from "./types.ts";

function h(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "_None._";
}

function priorityRank(p: Priority): number {
  return { must: 0, should: 1, could: 2 }[p];
}

export function renderSpec(state: RequirementsState): string {
  const out: string[] = [];

  out.push(h(1, `Requirements: ${state.featureName}`));
  out.push(`> Tier: **${state.tier}** · Generated from \`requirements.json\` — do not edit by hand.`);
  out.push("");

  out.push(h(2, "Problem"));
  out.push(state.problemStatement.trim() || "_Not stated._");
  out.push("");

  out.push(h(2, "Goals"));
  out.push(bullets(state.goals.map((g) => `(${g.id}) ${g.text}`)));
  out.push("");

  out.push(h(2, "Non-goals"));
  out.push(bullets(state.nonGoals.map((g) => `(${g.id}) ${g.text}`)));
  out.push("");

  if (state.actors.length) {
    out.push(h(2, "Actors"));
    out.push(bullets(state.actors.map((a) => `**${a.name}** — ${a.description ?? ""}`.trim())));
    out.push("");
  }

  const confirmed = state.decisions
    .filter((d) => d.status === "confirmed")
    .sort((a, b) => a.sequence - b.sequence);
  out.push(h(2, "Confirmed decisions"));
  if (confirmed.length) out.push(renderDecisions(confirmed));
  else out.push("_None confirmed yet._");
  out.push("");

  out.push(h(2, "Requirements"));
  out.push(h(3, "Functional"));
  out.push(renderRequirements(state.functionalRequirements));
  out.push("");
  out.push(h(3, "Non-functional"));
  out.push(renderRequirements(state.nonFunctionalRequirements));
  out.push("");

  if (state.userJourneys.length) {
    out.push(h(2, "User workflows"));
    for (const j of state.userJourneys) {
      const actor = j.actor ? ` _(actor: ${j.actor})_` : "";
      out.push(`**${j.name}**${actor}`);
      out.push(j.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
      out.push("");
    }
  }

  out.push(h(2, "Acceptance criteria"));
  if (state.acceptanceCriteria.length) {
    const rows = state.acceptanceCriteria
      .slice()
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
      .map((ac) => {
        const link = ac.linkedRequirement ?? ac.linkedGoal ?? "—";
        return `| ${ac.id} | ${ac.criterion} | ${link} | ${ac.priority} | ${ac.testability} |`;
      });
    out.push("| ID | Criterion | Verifies | Priority | Testability |");
    out.push("| --- | --- | --- | --- | --- |");
    out.push(rows.join("\n"));
  } else out.push("_None._");
  out.push("");

  out.push(h(2, "Structured acceptance tests"));
  if (!state.acceptanceTests.length) out.push("_None._");
  for (const test of state.acceptanceTests) {
    out.push(`### [${test.id}] ${test.name}`);
    out.push(`- Setup: ${test.setup}`);
    out.push(`- Action: ${test.action}`);
    out.push(`- Expected: ${test.expectedResult}`);
    out.push(`- Fidelity: ${test.fidelityLayer}`);
    out.push(`- Verifies: ${test.linkedRequirement}`);
    out.push(`- Evidence: ${test.requiredEvidence}`);
    out.push(`- Scenarios: ${test.categories.join(", ") || "none"}`);
  }
  out.push("");

  out.push(h(2, "End-to-end build readiness"));
  out.push(`- Buildable as-is without clarification or invented requirements: **${state.readiness.buildableEndToEnd}**`);
  out.push(`- Requirements revision: \`${state.requirementsRevision}\``);
  out.push(`- Rationale: ${state.readiness.rationale || "not supplied"}`);
  out.push(`- Working parameters: ${state.readiness.workingParameters || "not supplied"}`);
  out.push(`- Stop conditions: ${state.readiness.stopConditions.join("; ") || "none supplied"}`);
  out.push(bullets(state.readiness.domains.map((d) => `${d.domain}: ${d.status} — ${d.rationale || "no rationale"}`)));
  if (state.readinessOptOut) out.push(`- **NON-ATTESTED opt-out:** ${state.readinessOptOut.requestText} (approved by ${state.readinessOptOut.approvedBy})`);
  out.push("");

  if (state.constraints.length) {
    out.push(h(2, "Constraints"));
    out.push(bullets(state.constraints.map((c) => `${c.text}${c.kind ? ` _(${c.kind})_` : ""}`)));
    out.push("");
  }

  out.push(h(2, "Risks"));
  if (state.risks.length) {
    out.push("| Risk | Likelihood | Impact | Status | Mitigation |");
    out.push("| --- | --- | --- | --- | --- |");
    out.push(
      state.risks
        .map((r) => `| ${r.text} | ${r.likelihood} | ${r.impact} | ${r.status} | ${r.mitigation ?? "—"} |`)
        .join("\n")
    );
  } else out.push("_None recorded._");
  out.push("");

  out.push(h(2, "Assumptions"));
  out.push(
    bullets(state.assumptions.map((a) => `${a.text} _(${a.status})_`))
  );
  out.push("");

  const openQs = state.openQuestions.filter((q) => q.status === "open");
  if (openQs.length) {
    out.push(h(2, "Open questions"));
    out.push(renderQuestions(openQs));
    out.push("");
  }

  const deferred = state.openQuestions.filter(
    (q) => q.status === "deferred" || q.status === "accepted-risk"
  );
  if (deferred.length) {
    out.push(h(2, "Explicitly deferred"));
    out.push(
      bullets(deferred.map((q) => `${q.question} _(${q.status}${q.acceptedRiskAssumption ? `; assumption: ${q.acceptedRiskAssumption}; stop: ${q.stopCondition}` : ""})_`))
    );
    out.push("");
  }

  if (state.dependencies.length) {
    out.push(h(2, "Dependencies"));
    out.push(bullets(state.dependencies.map((d) => `${d.name} _(${d.kind}, ${d.status})_`)));
    out.push("");
  }

  // Operational sections only when relevant.
  for (const [title, sec] of [
    ["Rollout / migration", state.rollout],
    ["Observability", state.observability],
    ["Security & privacy", state.security],
    ["Operational readiness", state.operational],
  ] as const) {
    const hasContent = sec.notes.length > 0 || ("phases" in sec && (sec as any).phases.length) || !sec.applicable;
    if (!hasContent) continue;
    out.push(h(2, title));
    if (!sec.applicable) out.push(`_Not applicable: ${sec.notApplicableReason ?? "unspecified"}._`);
    else {
      if ("phases" in sec && (sec as any).phases.length)
        out.push("Phases:\n" + (sec as any).phases.map((p: string, i: number) => `${i + 1}. ${p}`).join("\n"));
      if (sec.notes.length) out.push(bullets(sec.notes));
    }
    out.push("");
  }

  out.push(h(2, "Handoff notes"));
  out.push(bullets(state.handoffNotes));
  out.push("");

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderRequirements(reqs: RequirementsState["functionalRequirements"]): string {
  if (!reqs.length) return "_None._";
  return reqs
    .slice()
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .map((r) => `- **[${r.id}]** (${r.priority}) ${r.text}${r.rationale ? ` — _${r.rationale}_` : ""}`)
    .join("\n");
}

function renderDecisions(decisions: Decision[]): string {
  return decisions
    .map((d) => {
      const alts = d.alternatives.length ? `\n  - Alternatives: ${d.alternatives.join("; ")}` : "";
      return `- **[${d.id}]** ${d.decision}\n  - Rationale: ${d.rationale ?? "—"}\n  - Source: ${d.source}, confidence: ${d.confidence}${alts}`;
    })
    .join("\n");
}

function renderQuestions(qs: OpenQuestion[]): string {
  return qs
    .map(
      (q) =>
        `- **[${q.id}]** (${q.blocking}) ${q.question}\n  - Why: ${q.whyItMatters}${q.recommendation ? `\n  - Recommendation: ${q.recommendation}\n  - Rationale: ${q.recommendationRationale}` : ""}`
    )
    .join("\n");
}

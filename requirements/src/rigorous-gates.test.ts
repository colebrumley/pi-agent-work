import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newState, migrateState, requirementsRevision } from "./state.ts";
import { validateRequirements } from "./validate-requirements.ts";
import { renderHandoff } from "./render-handoff.ts";
import { ADVERSARIAL_CATEGORIES, FIDELITY_LAYERS, READINESS_DOMAINS, type RequirementsState, type Tier } from "./types.ts";
import { integrationBlockers, rerunAcceptanceTests, sanitizeSummary, validateBuilderEvidence } from "../../extensions/agent-work/verification.ts";

function complete(tier: Tier): RequirementsState {
  const s = newState("Ready feature", tier);
  s.problemStatement = "A fully specified product behavior is required.";
  s.goals = [{ id: "g-1", text: "Deliver behavior" }];
  s.nonGoals = [{ id: "ng-1", text: "No unrelated behavior" }];
  s.actors = [{ id: "act-1", name: "User" }];
  s.userJourneys = [{ id: "uj-1", name: "Use feature", actor: "act-1", steps: ["Invoke", "Observe"] }];
  s.constraints = [{ id: "con-1", text: "Preserve entry points" }];
  s.functionalRequirements = [{ id: "fr-1", text: "Produce defined output", priority: "must" }];
  s.risks = [{ id: "risk-1", text: "Regression", likelihood: "low", impact: "high", status: "mitigated", mitigation: "Tests" }];
  s.dependencies = [{ id: "dep-1", name: "Runtime", kind: "internal", status: "available" }];
  s.acceptanceCriteria = [{ id: "ac-1", criterion: "Output is defined", linkedRequirement: "fr-1", testability: "testable", priority: "must" }];
  s.acceptanceTests = [{ id: "at-1", name: "CLI behavior", setup: "Create fixture", action: "Run command", expectedResult: "Expected output and exit status", fidelityLayer: "real-end-to-end", linkedRequirement: "ac-1", requiredEvidence: "Command, environment, scenarios, output", categories: [...ADVERSARIAL_CATEGORIES] }];
  s.testingStandards = {
    fidelity: FIDELITY_LAYERS.map((name) => ({ name, applicable: name === "real-end-to-end", rationale: name === "real-end-to-end" ? "Direct CLI behavior is applicable" : "Lower layer adds no distinct behavior for this fixture" })),
    adversarial: ADVERSARIAL_CATEGORIES.map((name) => ({ name, applicable: true, rationale: `${name} is covered by the acceptance flow` })),
  };
  s.readiness = {
    buildableEndToEnd: "yes",
    rationale: "Every observable decision and proof obligation is defined.",
    workingParameters: "Implement only fr-1; preserve entry points; execute all applicable tests.",
    assumptions: [],
    stopConditions: ["Stop, preserve work, and return to clarification if defined output cannot be produced."],
    domains: READINESS_DOMAINS.map((domain) => ({ domain, status: "resolved", rationale: `${domain} behavior is explicitly covered.` })),
    assessedBy: "interviewer",
  };
  s.security = { applicable: false, notApplicableReason: "No sensitive boundary", notes: [] };
  s.observability = { applicable: false, notApplicableReason: "Local command", notes: [] };
  s.operational = { applicable: false, notApplicableReason: "No service", notes: [] };
  s.rollout = { applicable: true, notes: ["Immediate local rollout"], phases: tier === "epic" ? ["Phase one"] : [] };
  s.riskReviews = [{ reviewedAt: new Date(0).toISOString(), reviewer: "user", summary: "Risk reviewed" }];
  s.requirementsRevision = requirementsRevision(s);
  return s;
}

for (const tier of ["tiny", "small", "medium", "large", "epic"] as Tier[]) {
  const report = validateRequirements(complete(tier));
  assert.equal(report.handoffReady, true, `${tier}: ${[...report.errors, ...report.blockers].map((x) => x.message).join("; ")}`);
}

{
  const s = complete("medium");
  s.readiness.domains.find((x) => x.domain === "ux")!.status = "open";
  s.requirementsRevision = requirementsRevision(s);
  assert.ok(validateRequirements(s).blockers.some((x) => x.code === "readiness.domain"));
  s.readiness.domains.find((x) => x.domain === "ux")!.status = "resolved";
  s.readiness.buildableEndToEnd = "no";
  s.requirementsRevision = requirementsRevision(s);
  assert.equal(renderHandoff(s).ok, false, "normal handoff requires unambiguous yes");
  assert.equal(renderHandoff(s, { force: true }).ok, false, "force flag is not risk acceptance");
}

{
  const s = complete("small");
  s.readiness.buildableEndToEnd = "unanswered";
  s.openQuestions = [{ id: "q-1", question: "Which output?", category: "behavior", whyItMatters: "Defines behavior", blocking: "blocking", recommendation: "Use the documented output", recommendationRationale: "Stable contract", status: "answered", answer: "Use the documented output", answerSource: "interviewer" }];
  s.readinessOptOut = { requestedByUser: true, approvedBy: "requester", requestText: "I explicitly accept the non-attested opt-out", choices: [{ questionId: "q-1", answer: "Use the documented output", rationale: "Small and bounded" }] };
  s.requirementsRevision = requirementsRevision(s);
  const handoff = renderHandoff(s);
  assert.equal(handoff.ok, true);
  if (handoff.ok) assert.match(handoff.markdown, /NON-ATTESTED/);
  const medium = structuredClone(s); medium.tier = "medium"; medium.requirementsRevision = requirementsRevision(medium);
  assert.ok(validateRequirements(medium).errors.some((x) => x.code === "readiness.optOutTier"));
}

{
  const s = complete("tiny");
  s.openQuestions.push({ id: "q-1", question: "What error is shown?", category: "errors", whyItMatters: "Changes behavior", blocking: "non-blocking", status: "open", recommendation: "Return a concise error", recommendationRationale: "Actionable and stable" });
  s.requirementsRevision = requirementsRevision(s);
  assert.ok(validateRequirements(s).blockers.some((x) => x.code === "question.unresolved"), "every material ambiguity blocks regardless of legacy blocking label");
  s.openQuestions[0].status = "accepted-risk";
  assert.ok(validateRequirements(s).errors.some((x) => x.code === "question.acceptedRisk"));
  s.openQuestions[0].acceptedRiskAssumption = "The error path is unavailable";
  s.openQuestions[0].stopCondition = "Stop if the error path is reached";
  s.readiness.assumptions.push("The error path is unavailable");
  s.readiness.stopConditions.push("Stop if the error path is reached");
  s.requirementsRevision = requirementsRevision(s);
  assert.equal(validateRequirements(s).errors.some((x) => x.code === "question.acceptedRisk"), false);
  const handoff = renderHandoff(s);
  assert.equal(handoff.ok, true);
  if (handoff.ok) assert.match(handoff.markdown, /stop immediately, preserve work, report the blocking discovery/i);
}

{
  const s = complete("tiny");
  s.testExceptions = [{ testId: "at-1", reason: "External service is prohibitively costly", substituteVerification: "Deterministic fixture", residualRisk: "Real service may differ", explicitUserApproval: false, requirementsRevision: s.requirementsRevision }];
  assert.ok(validateRequirements(s).errors.some((x) => x.code === "tests.exception"));
  s.testExceptions[0].explicitUserApproval = true;
  s.testExceptions[0].approvedBy = "requester";
  assert.equal(validateRequirements(s).errors.some((x) => x.code === "tests.exception"), false);
  s.goals[0].text = "Changed requirement";
  s.requirementsRevision = requirementsRevision(s);
  assert.ok(validateRequirements(s).errors.some((x) => x.code === "tests.exception"), "requirements changes invalidate exception approval");
}

{
  const current = complete("medium");
  const legacy: any = structuredClone(current);
  legacy.schemaVersion = 1;
  for (const key of ["acceptanceTests", "testingStandards", "testExceptions", "readiness", "readinessOptOut", "requirementsRevision"]) delete legacy[key];
  const migrated = migrateState(legacy, current.decisions);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.featureName, current.featureName);
  assert.equal(migrated.readiness.buildableEndToEnd, "unanswered");
  assert.equal(migrated.acceptanceTests.length, 0);
  assert.equal(validateRequirements(migrated).handoffReady, false);
}

{
  const secret = `token=super-secret-${"x".repeat(5000)}`;
  const clean = sanitizeSummary(secret);
  assert.equal(clean.includes("super-secret"), false);
  assert.ok(clean.length <= 4000);
  const s = complete("tiny");
  const malformed = structuredClone(s);
  malformed.acceptanceTests[0].setup = "";
  assert.ok(validateRequirements(malformed).errors.some((x) => x.code === "schema.field"));
  const evidence = { schemaVersion: 2 as const, requirementsRevision: s.requirementsRevision, implementationCommit: "abc", tests: [{ testId: "at-1", command: "true", result: "passed" as const, environment: "node test", scenarios: [...ADVERSARIAL_CATEGORIES], summary: secret }] };
  const checked = await validateBuilderEvidence(s, evidence, "abc");
  assert.equal(checked.valid, true, checked.issues.join("; "));
  assert.equal(checked.evidence!.tests[0].summary.includes("super-secret"), false);
  const progress: string[] = [];
  const rerun = await rerunAcceptanceTests(s, checked.evidence!, process.cwd(), "abc", [], { onProgress: (item) => { progress.push(`${item.testId}:${item.status}`); } });
  assert.equal(rerun.approved, true);
  assert.deepEqual(progress, ["at-1:running", "at-1:passed"], "independent acceptance reruns expose durable progress milestones");
  const failed = structuredClone(evidence); failed.tests[0].result = "failed";
  assert.equal((await validateBuilderEvidence(s, failed, "abc")).valid, false, "failed required evidence blocks completion");
  const report = { schemaVersion: 2 as const, requirementsRevision: s.requirementsRevision, reviewedCommit: "abc", generatedAt: new Date().toISOString(), tests: [{ testId: "at-1", status: "passed" as const, evidenceAssessment: "rerun passed" }], findings: [], evidenceComplete: true, approved: true };
  assert.deepEqual(integrationBlockers(s, "abc", report), []);
  assert.ok(integrationBlockers(s, "changed", report).some((x) => /commit/.test(x)));
  report.findings.push({ severity: "high" as const, status: "open" as const, summary: "verified defect" });
  assert.ok(integrationBlockers(s, "abc", report).some((x) => /high\/critical/.test(x)));
}

console.log("rigorous gate tests passed");

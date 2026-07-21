import assert from "node:assert/strict";
import { ancestorEvidence, commandIdentity, createEvidenceManifest, finalGateBlockers, intermediateEvidencePlan, mayExecuteCommand, validateEvidenceManifest, type EvidenceRecord } from "./evidence.ts";
import { classifyChangedSurface, classifyChangedSurfaceFromDiff, consolidateFindings, recordReviewCompletion, reviewPlan, type ReviewLifecycleState } from "./review-lifecycle.ts";
import { createPromptSlice, renderPromptSlice } from "./prompt-slice.ts";
import type { RequirementsState } from "../../requirements/src/types.ts";

const state: ReviewLifecycleState = { requirementsRevision: "rev-1", broadReviews: 1, findings: [] };
const narrow = classifyChangedSurface({ files: ["src/ui.ts"], affectedRequirementIds: ["fr-ui"] });
const expanded = classifyChangedSurface({ files: ["src/api.ts"], publicContractChanged: true });
const detectedExpansion = classifyChangedSurfaceFromDiff({ files: ["extensions/agent-work/index.ts"], diff: "+pi.registerTool({ name: 'public-api' })\n+acceptanceTests.push('at-new')" });
assert.ok(detectedExpansion.kinds.includes("public-contract"));
assert.ok(detectedExpansion.kinds.includes("acceptance-scope"));

assert.equal(reviewPlan(state, { phase: "amendment", requirementsRevision: "rev-1", commit: "a", highRisk: true, changedSurface: narrow }).mode, "focused");
assert.equal(reviewPlan(state, { phase: "amendment", requirementsRevision: "rev-1", commit: "b", highRisk: true, changedSurface: narrow }).panel, false);
const rerun = reviewPlan(state, { phase: "amendment", requirementsRevision: "rev-1", commit: "c", highRisk: true, changedSurface: expanded });
assert.deepEqual({ mode: rerun.mode, panel: rerun.panel }, { mode: "broad", panel: true });
assert.equal(recordReviewCompletion(state, rerun, "c", []).broadReviews, 2, "only the selected broad rerun changes durable panel count");
assert.equal(reviewPlan({ ...state, broadReviews: 2 }, { phase: "amendment", requirementsRevision: "rev-1", commit: "d", highRisk: true, changedSurface: expanded }).mode, "focused", "only one risk-expansion broad rerun is scheduled");
const operatorRequestedBroad = reviewPlan({ ...state, broadReviews: 2 }, { phase: "amendment", requirementsRevision: "rev-1", commit: "d", highRisk: true, changedSurface: narrow, explicitBroad: true });
assert.deepEqual({ mode: operatorRequestedBroad.mode, panel: operatorRequestedBroad.panel, reason: operatorRequestedBroad.reason }, { mode: "broad", panel: true, reason: "operator requested broad review" }, "explicit operator broad review is never capped as an automatic risk-expansion rerun");
const finalPlan = reviewPlan(state, { phase: "final", requirementsRevision: "rev-1", commit: "e", highRisk: true });
assert.deepEqual({ mode: finalPlan.mode, panel: finalPlan.panel }, { mode: "final-gate", panel: false });

const consolidated = consolidateFindings(state, "a", [{ severity: "high", location: "src/ui.ts:4", description: "missing validation", sourceReviewId: "broad:1" }]);
const repeated = consolidateFindings(consolidated, "b", [{ severity: "high", location: "src/ui.ts:4", description: "missing validation", sourceReviewId: "focused:1" }]);
assert.equal(repeated.findings.length, 1);
assert.deepEqual(repeated.findings[0].reviewIds, ["broad:1", "focused:1"]);
assert.equal(repeated.findings[0].firstSeenCommit, "a");
assert.equal(repeated.findings[0].lastSeenCommit, "b");

const full: EvidenceRecord = {
  id: "full-a", command: "npm   test", commandIdentity: commandIdentity("npm test"), kind: "full-suite", requirementsRevision: "rev-1", commit: "a", environment: "node", result: "passed", artifactHash: "sha256:artifact", fidelity: "integration", scenarios: ["regression"], freshness: "same-commit",
};
const manifest = createEvidenceManifest({ requirementsRevision: "rev-1", commit: "a", records: [full] });
assert.deepEqual(validateEvidenceManifest(manifest), []);
assert.equal(manifest.manifestHash, createEvidenceManifest({ requirementsRevision: "rev-1", commit: "a", records: [full] }).manifestHash, "manifest hashing is deterministic");
assert.equal(commandIdentity("npm test"), commandIdentity(" npm   test "), "equivalent commands have stable identities");
assert.equal(mayExecuteCommand({ records: [full], command: "npm test", expensive: true, finalGate: false }).allowed, false);
const override = mayExecuteCommand({ records: [full], command: "npm test", expensive: true, finalGate: false, overrideRationale: "diagnose flaky environment" });
assert.equal(override.allowed, true);
assert.equal(override.overrideRationale, "diagnose flaky environment");
const intermediate = intermediateEvidencePlan([full], "a");
assert.equal(intermediate.reused.length, 1);
assert.deepEqual(intermediate.executeKinds, ["targeted"], "same-commit intermediate review does not rerun the full suite");
const ancestor = ancestorEvidence([full], "b");
assert.equal(ancestor[0].freshness, "ancestor");
assert.equal(ancestor[0].lineage?.sourceCommit, "a");
assert.ok(finalGateBlockers(ancestor, "b", "rev-1", true).length > 0, "ancestor evidence cannot approve an exact-current final gate");
const freshFull = { ...full, id: "full-b", commit: "b", freshness: "fresh" as const };
const freshFlow = { ...full, id: "flow-b", kind: "flow" as const, commit: "b", freshness: "fresh" as const };
assert.deepEqual(finalGateBlockers([freshFull, freshFlow], "b", "rev-1", true), []);
assert.ok(finalGateBlockers([{ ...freshFull, requirementsRevision: "old-rev" }, { ...freshFlow, requirementsRevision: "old-rev" }], "b", "rev-1", true).length > 0, "stale-revision current-commit evidence cannot approve an exact-current final gate");
assert.ok(finalGateBlockers([freshFull, freshFlow], "b", "rev-1", true, { fullCommandIdentities: [commandIdentity("other full suite")] }).some((blocker) => /missing/.test(blocker)));

const requirements = {
  requirementsRevision: "rev-1",
  functionalRequirements: [{ id: "fr-ui", text: "Render the focused UI" }, { id: "fr-engine", text: "Rebuild the engine" }],
  acceptanceCriteria: [{ id: "ac-ui", criterion: "UI updates", linkedRequirement: "fr-ui" }, { id: "ac-engine", criterion: "Engine updates", linkedRequirement: "fr-engine" }],
  constraints: [{ id: "con-ui", text: "Preserve public UI contract" }, { id: "con-engine", text: "Preserve engine protocol" }],
  nonGoals: [{ id: "ng-ui", text: "Do not redesign UI" }, { id: "ng-engine", text: "Do not change engine storage" }],
} as unknown as RequirementsState;
const slice = createPromptSlice(requirements, { role: "focused-reviewer", sourcePath: ".agent-work/features/x/requirements/handoff.md", sourceHash: "sha256:source", requirementIds: ["fr-ui"], criterionIds: [], boundaryIds: ["con-ui", "ng-ui"], findings: repeated.findings, changedSurface: narrow, checks: ["npm test -- ui"] });
const snapshot = renderPromptSlice(slice);
assert.match(snapshot, /Render the focused UI/);
assert.match(snapshot, /Preserve public UI contract/);
assert.match(snapshot, /sha256:source/);
assert.doesNotMatch(snapshot, /Rebuild the engine|engine protocol|engine storage/);
assert.equal(requirements.functionalRequirements.length, 2, "slicing never mutates immutable requirements");

console.log("workflow efficiency tests passed");

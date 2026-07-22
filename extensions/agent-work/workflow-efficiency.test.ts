import assert from "node:assert/strict";
import { ancestorEvidence, canonicalAcceptanceProvenance, commandIdentity, createEvidenceManifest, finalGateBlockers, intermediateEvidencePlan, mayExecuteCommand, validateEvidenceManifest, type EvidenceRecord } from "./evidence.ts";
import { classifyChangedSurface, classifyChangedSurfaceFromDiff, consolidateFindings, recordReviewCompletion, reviewPlan, type ReviewLifecycleState } from "./review-lifecycle.ts";
import { createPromptSlice, renderPromptSlice } from "./prompt-slice.ts";
import { selectCheckpointReview, selectSealedCheckpointReview, type CheckpointReviewTrigger } from "./runs.ts";
import { checkpointWorkspaceMetadataIssues } from "./checkpoint-workspace.ts";
import { assessFidelityLayers, evidenceResultForLayerStatus, evidenceResultForVerificationStatus } from "./verification.ts";
import type { RequirementsState } from "../../requirements/src/types.ts";

const state: ReviewLifecycleState = { requirementsRevision: "rev-1", broadReviews: 1, findings: [] };
const canonicalTests = [
  { id: "at-1", fidelityLayer: "unit", categories: ["boundaries", "malformed-input", "abuse"] },
  { id: "at-2", fidelityLayer: "integration", categories: ["happy-path", "failure-recovery", "regression"] },
  { id: "at-3", fidelityLayer: "unit", categories: ["boundaries", "regression"] },
  { id: "at-4", fidelityLayer: "integration", categories: ["failure-recovery", "regression"] },
  { id: "at-5", fidelityLayer: "realistic-smoke", categories: ["happy-path", "regression"] },
  { id: "at-6", fidelityLayer: "integration", categories: ["failure-recovery", "abuse"] },
  { id: "at-7", fidelityLayer: "integration", categories: ["happy-path", "failure-recovery", "regression"] },
  { id: "at-8", fidelityLayer: "static", categories: ["malformed-input", "regression"] },
] as any;
for (const test of canonicalTests) assert.deepEqual(canonicalAcceptanceProvenance(canonicalTests, test.id), { recordId: test.id, fidelity: test.fidelityLayer, scenarios: test.categories }, `${test.id} manifest provenance derives from its exact acceptance declaration`);
const narrow = classifyChangedSurface({ files: ["src/ui.ts"], affectedRequirementIds: ["fr-ui"] });
const expanded = classifyChangedSurface({ files: ["src/api.ts"], publicContractChanged: true });
const detectedExpansion = classifyChangedSurfaceFromDiff({ files: ["extensions/agent-work/index.ts"], diff: "+pi.registerTool({ name: 'public-api' })\n+acceptanceTests.push('at-new')" });
assert.ok(detectedExpansion.kinds.includes("public-contract"));
assert.ok(detectedExpansion.kinds.includes("acceptance-scope"));

for (const trigger of ["public-contract", "architecture", "security-trust-boundary", "data-migration", "concurrency", "expanded-acceptance-scope", "uncertain"] as CheckpointReviewTrigger[]) {
  const selected = selectCheckpointReview([trigger]);
  assert.equal(selected.mode, "broad", `${trigger} requires broad checkpoint review`);
  assert.match(selected.rationale, new RegExp(trigger));
}
assert.deepEqual(selectCheckpointReview(), { mode: "focused", rationale: "focused review: no broad-review trigger declared" }, "low-risk checkpoint defaults to focused review");
const sealedEscalation = selectSealedCheckpointReview([], ["public-contract"], true);
assert.equal(sealedEscalation.mode, "broad", "sealed diff escalation cannot be bypassed by a low-risk declaration");
assert.match(sealedEscalation.rationale, /sealed diff.*public-contract/);
assert.equal(selectSealedCheckpointReview([], [], false).mode, "broad", "uncertain sealed-diff classification is conservatively broad");
for (const candidate of [
  { files: ["db/001.sql"], diff: "+ALTER TABLE users ADD COLUMN role text", kind: "data-migration" },
  { files: ["src/cache.ts"], diff: "+const guard = new Mutex()", kind: "concurrency" },
  { files: ["src/sign.ts"], diff: "+crypto.sign(privateKey, payload)", kind: "trust-security-boundary" },
  { files: ["src/opaque.ts"], diff: "+frobnicate(value)", kind: "uncertain" },
]) {
  const classified = classifyChangedSurfaceFromDiff(candidate);
  assert.ok(classified.kinds.includes(candidate.kind as any), `unlabeled ${candidate.kind} abuse is detected from sealed content`);
  const selected = selectSealedCheckpointReview([], classified.kinds, true);
  assert.equal(selected.mode, "broad"); assert.match(selected.rationale, new RegExp(candidate.kind === "trust-security-boundary" ? "security-trust-boundary" : candidate.kind));
}
for (const lowRisk of [
  classifyChangedSurfaceFromDiff({ files: ["docs/usage.md"], diff: "+clarification" }),
  classifyChangedSurfaceFromDiff({ files: ["src/widget.test.ts"], diff: "+assert.equal(result, expected)" }),
  classifyChangedSurfaceFromDiff({ files: ["package-lock.json"], diff: "+metadata" }),
]) assert.equal(selectSealedCheckpointReview([], lowRisk.kinds, true).mode, "focused", "structurally known low-risk sealed diff remains focused");

const persistedWorkspace = { schemaVersion: 1 as const, worktree: "/tmp/run/checkpoint/worktree", branch: "agent-work/f/run-r-c", baseCommit: "a".repeat(40) };
assert.deepEqual(checkpointWorkspaceMetadataIssues(persistedWorkspace, { worktree: persistedWorkspace.worktree, branch: persistedWorkspace.branch }, { worktree: persistedWorkspace.worktree, branch: persistedWorkspace.branch }), [], "persisted workspace metadata reopens with the exact identity");
assert.ok(checkpointWorkspaceMetadataIssues(persistedWorkspace, { worktree: persistedWorkspace.worktree, branch: persistedWorkspace.branch }, { worktree: persistedWorkspace.worktree, branch: "other" }).length, "restart refuses a mismatched checkpoint branch");

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
const unavailableManifest = createEvidenceManifest({ requirementsRevision: "rev-1", commit: "a", records: [{ ...full, id: "final-layer-real-end-to-end", result: "not-run", declaredStatus: "approved-unavailable" }] });
assert.equal(unavailableManifest.records[0].declaredStatus, "approved-unavailable", "unavailable layer declaration survives canonical manifest creation");
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
const exceptionRequirements = { testingStandards: { fidelity: [{ name: "integration", applicable: true, rationale: "approved substitute" }] }, acceptanceTests: [{ id: "at-exception", fidelityLayer: "integration" }] } as unknown as RequirementsState;
const exceptionLayers = assessFidelityLayers(exceptionRequirements, [{ testId: "at-exception", status: "approved-exception", evidenceAssessment: "approved" }]);
assert.deepEqual(exceptionLayers.blockers, []); assert.equal(exceptionLayers.layers[0].status, "approved-unavailable", "approved exceptions produce internally consistent unavailable layer status");
assert.equal(evidenceResultForVerificationStatus("approved-exception"), "not-run"); assert.equal(evidenceResultForLayerStatus("approved-unavailable"), "not-run", "exception test and layer manifest records remain consistently unavailable");

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

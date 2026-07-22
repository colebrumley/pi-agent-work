import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import agentWorkExtension, { executeDirectFinalIntegration, executeFeatureFinalGate, executorForRoot } from "./index.ts";
import { acceptRun, startRun, suspendRuns, type RunDeclaration } from "./runs.ts";
import { atomicJson, attemptDir, createTask, featureDir, readJson, readStatus, taskDir, writeStatus } from "./storage.ts";
import { rerunAcceptanceTests, validateBuilderEvidence, writeVerificationReport, type BuilderEvidence } from "./verification.ts";
import { validateEvidenceManifest } from "./evidence.ts";
import { newState, saveState } from "../../requirements/src/state.ts";
import { FIDELITY_LAYERS, type RequirementsState } from "../../requirements/src/types.ts";

const execFileAsync = promisify(execFile);
const publicTools: any[] = [];
let directFinalFindings: any[] = [];
agentWorkExtension({
  __agentWorkTestHooks: { directFinalReviewer: async () => directFinalFindings },
  registerFlag() {}, registerTool(tool: any) { publicTools.push(tool); }, registerCommand() {}, registerEntryRenderer() {}, on() {}, getFlag() { return undefined; }, setModel() {},
} as any);
const publicIntegrate = publicTools.find((tool) => tool.name === "agent_integrate");
const git = async (cwd: string, args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();

async function fixture(unitMutation?: "--mutate-tracked" | "--create-untracked", finalMutation?: "--mutate-restore" | "--ignored-probe"): Promise<{ root: string; requirements: RequirementsState; commit: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-production-gates-"));
  await git(root, ["init", "-q"]); await git(root, ["config", "user.email", "fixture@example.invalid"]); await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(join(root, ".gitignore"), ".agent-work/\nignored-probe.tmp\n"); await writeFile(join(root, "base.txt"), "base\n");
  await writeFile(join(root, "fixture-assert.js"), "import fs from 'node:fs'; if (process.argv.includes('--mutate-tracked')) fs.appendFileSync('base.txt','mutation'); if (process.argv.includes('--create-untracked')) fs.writeFileSync('generated-by-check.txt','mutation'); if (process.argv.includes('--mutate-restore')) { const prior=fs.readFileSync('base.txt'); fs.writeFileSync('base.txt','temporary'); fs.writeFileSync('base.txt',prior); } if (process.argv.includes('--ignored-probe')) { fs.writeFileSync('ignored-probe.tmp','temporary'); fs.unlinkSync('ignored-probe.tmp'); } if (!fs.existsSync('base.txt') || (process.argv[2] === 'integration' && fs.existsSync('.agent-work/fail-integration'))) process.exit(1);\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { smoke: "node fixture-assert.js smoke", integration: "node fixture-assert.js integration", unit: `node fixture-assert.js unit${unitMutation ? ` ${unitMutation}` : ""}`, static: `node fixture-assert.js static${finalMutation ? ` ${finalMutation}` : ""}` } }));
  await git(root, ["add", ".gitignore", "base.txt", "fixture-assert.js", "package.json"]); await git(root, ["commit", "-qm", "base"]);
  const requirements = newState("Production gate fixture", "medium");
  requirements.acceptanceTests = [
    { id: "at-2", name: "Integration", setup: "fixture", action: "run", expectedResult: "pass", fidelityLayer: "integration", linkedRequirement: "fr-1", requiredEvidence: "exit zero", categories: ["regression"] },
    { id: "at-5", name: "Standalone smoke", setup: "fixture", action: "run", expectedResult: "pass", fidelityLayer: "realistic-smoke", linkedRequirement: "fr-1", requiredEvidence: "exit zero", categories: ["happy-path", "regression"] },
    { id: "at-8", name: "Static surface", setup: "fixture", action: "load", expectedResult: "pass", fidelityLayer: "static", linkedRequirement: "fr-1", requiredEvidence: "exit zero", categories: ["regression"] },
  ];
  requirements.testingStandards.fidelity = FIDELITY_LAYERS.map((name) => ({ name, applicable: ["realistic-smoke", "integration", "static"].includes(name), rationale: ["realistic-smoke", "integration", "static"].includes(name) ? `${name} is exercised by this production harness` : `${name} is unavailable for this local fixture` }));
  const dir = join(featureDir(root, "feature"), "requirements"); await mkdir(dir, { recursive: true }); saveState(dir, requirements);
  await atomicJson(join(featureDir(root, "feature"), "feature.json"), { schemaVersion: 1, id: "feature" });
  return { root, requirements, commit: await git(root, ["rev-parse", "HEAD"]) };
}

function task(id = "write"): RunDeclaration["tasks"][number] {
  return { id, title: id, prompt: `perform ${id}`, mode: "write", profile: "worker", dependsOn: [], outcome: `complete ${id}`, surface: [`${id}.txt`], nonGoals: ["Do not modify unrelated paths"], verificationCommands: ["git diff --check"], affectedAcceptanceTestIds: ["at-2", "at-5", "at-8"], acceptanceChecks: [{ testId: "at-2", command: "npm run integration" }, { testId: "at-5", command: "npm run smoke" }, { testId: "at-8", command: "npm run static" }] };
}

function evidence(requirements: RequirementsState, commit: string): BuilderEvidence {
  return { schemaVersion: 2, requirementsRevision: requirements.requirementsRevision, implementationCommit: commit, tests: requirements.acceptanceTests.map((test) => ({ testId: test.id, command: "true", result: "passed", environment: "production fixture", scenarios: test.categories, summary: `${test.fidelityLayer} fixture passed` })) };
}

async function seedFinalRun(root: string, requirements: RequirementsState, runId: string, commit: string): Promise<void> {
  const declaration: RunDeclaration = { schemaVersion: 1, id: runId, featureId: "feature", tasks: [task()] };
  await atomicJson(join(featureDir(root, "feature"), "runs", runId, "graph.json"), declaration);
  await atomicJson(join(taskDir(root, "feature", "write"), "status.json"), { schemaVersion: 1, featureId: "feature", taskId: "write", state: "integrated", currentAttempt: 1, commit, updatedAt: new Date().toISOString() });
  await atomicJson(join(attemptDir(root, "feature", "write", 1), "evidence.json"), evidence(requirements, commit));
}

async function productionFinalGate(): Promise<void> {
  const { root, requirements, commit } = await fixture();
  try {
    await seedFinalRun(root, requirements, "final", commit);
    const context = { runId: "final", featureId: "feature", combinedCoordinatorCommit: commit, signal: new AbortController().signal };
    const clean = await executeFeatureFinalGate(root, context, { independentReview: async () => [] });
    assert.equal(clean.passed, true); assert.equal(clean.combinedCoordinatorCommit, commit);
    const persisted = await readJson<any>(clean.reportPath);
    assert.equal(persisted.approved, true); assert.deepEqual(persisted.layers.filter((layer: any) => layer.applicable).map((layer: any) => [layer.layer, layer.status]), [["realistic-smoke", "passed"], ["integration", "passed"], ["static", "passed"]]);
    assert.ok(persisted.tests.some((test: any) => test.testId === "at-8" && test.status === "passed"), "AT-8 supplies static final evidence");
    const manifest = await readJson<any>(persisted.evidenceManifest.path);
    assert.deepEqual(validateEvidenceManifest(manifest), []); assert.equal(persisted.evidenceManifest.sha256, manifest.manifestHash);
    const expectedProvenance: Record<string, [string, string[]]> = { "at-2": ["integration", ["regression"]], "at-5": ["realistic-smoke", ["happy-path", "regression"]], "at-8": ["static", ["regression"]] };
    for (const [testId, [fidelity, categories]] of Object.entries(expectedProvenance)) { const record = manifest.records.find((item: any) => item.id === `final-${testId}`); assert.ok(record, `${testId} uses a stable ID`); assert.equal(record.fidelity, fidelity); assert.deepEqual(record.scenarios, [...categories].sort()); }
    assert.ok(FIDELITY_LAYERS.every((layer) => manifest.records.some((record: any) => record.id === `final-layer-${layer}`)), "synthetic manifest records every fidelity layer");
    for (const layer of manifest.records.filter((record: any) => record.id.startsWith("final-layer-") && record.result === "not-run")) assert.equal(layer.declaredStatus, "approved-unavailable", "unavailable layer retains its declared status");

    const graphPath = join(featureDir(root, "feature"), "runs", "final", "graph.json");
    const graph = await readJson<any>(graphPath); graph.tasks[0].acceptanceChecks = [{ testId: "at-2", command: "npm test" }, { testId: "at-5", command: "npm test" }, { testId: "at-8", command: "npm test" }]; await atomicJson(graphPath, graph);
    const canonicalFailure = await executeFeatureFinalGate(root, context, { independentReview: async () => [] });
    assert.equal(canonicalFailure.passed, false, "worker true metadata cannot replace failing canonical acceptance commands");
    graph.tasks[0].acceptanceChecks = [{ testId: "at-2", command: "npm run integration" }, { testId: "at-5", command: "npm run smoke" }, { testId: "at-8", command: "npm run static" }]; await atomicJson(graphPath, graph);
    const stale = await executeFeatureFinalGate(root, { ...context, combinedCoordinator: "f".repeat(40), combinedCoordinatorCommit: "f".repeat(40) }, { independentReview: async () => [] });
    assert.equal(stale.passed, false); assert.match(stale.reason ?? "", /HEAD|commit/);
    await writeFile(join(root, "base.txt"), "dirty\n");
    const dirty = await executeFeatureFinalGate(root, context, { independentReview: async () => [] });
    assert.equal(dirty.passed, false); assert.match(dirty.reason ?? "", /dirty/); await git(root, ["checkout", "--", "base.txt"]);
    const severe = await executeFeatureFinalGate(root, context, { independentReview: async () => [{ severity: "high", status: "open", summary: "verified production defect" }] });
    assert.equal(severe.passed, false); assert.ok(severe.findings.some((finding) => finding.severity === "high" && finding.status === "open"));
    assert.equal((await readJson<any>(severe.reportPath)).approved, false, "blocked production result is persisted");
    const critical = await executeFeatureFinalGate(root, context, { independentReview: async () => [{ severity: "critical", status: "open", summary: "verified critical production defect" }] });
    assert.equal(critical.passed, false); assert.ok(critical.findings.some((finding) => finding.severity === "critical" && finding.status === "open"), "critical findings independently block final completion");
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function productionFinalMutationIsolation(): Promise<void> {
  for (const probe of ["--mutate-restore", "--ignored-probe"] as const) {
    const { root, requirements, commit } = await fixture(undefined, probe);
    try {
      await seedFinalRun(root, requirements, `final-${probe.slice(2)}`, commit);
      const result = await executeFeatureFinalGate(root, { runId: `final-${probe.slice(2)}`, featureId: "feature", combinedCoordinatorCommit: commit, signal: new AbortController().signal }, { independentReview: async () => [] });
      assert.equal(result.passed, false, `${probe} is rejected even when final filesystem contents are restored`);
      const report = await readJson<any>(result.reportPath); const staticResult = report.tests.find((item: any) => item.testId === "at-8");
      assert.equal(staticResult.status, "failed"); assert.equal(staticResult.mutationDetected, true); assert.equal(staticResult.startingCommit, commit); assert.match(staticResult.startingSnapshotHash, /^sha256:/); assert.equal(staticResult.isolatedWorktree, "disposable-exact-commit");
      assert.equal(await git(root, ["rev-parse", "HEAD"]), commit); assert.equal(await git(root, ["status", "--porcelain"]), "");
      assert.equal(await readFile(join(root, "ignored-probe.tmp"), "utf8").then(() => true, () => false), false, "probe worktree is discarded before returning");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

async function productionStandaloneCompatibility(): Promise<void> {
  const { root, requirements } = await fixture();
  const declaration: RunDeclaration = { schemaVersion: 1, id: "standalone", featureId: "feature", concurrency: 1, tasks: [task()] };
  const taskRunner: any = async (_root: string, input: any) => {
    const worktree = join(attemptDir(root, "feature", input.taskId, 1), "worktree"); const branch = "fixture-standalone";
    await createTask(root, { schemaVersion: 1, id: input.taskId, featureId: "feature", title: input.title, prompt: input.prompt, mode: "write", profile: "worker", dependsOn: [], createdAt: new Date().toISOString() });
    await git(root, ["worktree", "add", "-q", "-b", branch, worktree]); await writeFile(join(worktree, "standalone.txt"), "integrated\n");
    await git(worktree, ["add", "standalone.txt"]); await git(worktree, ["commit", "-qm", "standalone"]); const commit = await git(worktree, ["rev-parse", "HEAD"]);
    await atomicJson(join(attemptDir(root, "feature", input.taskId, 1), "evidence.json"), evidence(requirements, commit));
    await writeStatus(root, { schemaVersion: 1, featureId: "feature", taskId: input.taskId, state: "review", currentAttempt: 1, branch, worktree, commit, updatedAt: new Date().toISOString() });
    return { receipt: "fixture", finalText: "fixture", attemptPath: attemptDir(root, "feature", input.taskId, 1), operationId: "fixture" };
  };
  const checkpointReviewer: any = async (item: any) => {
    const status = await readStatus(root, "feature", item.id); const raw = await readJson<unknown>(join(attemptDir(root, "feature", item.id, status.currentAttempt), "evidence.json"));
    const checked = await validateBuilderEvidence(requirements, raw, status.commit); assert.equal(checked.valid, true);
    const report = await rerunAcceptanceTests(requirements, checked.evidence!, status.worktree!, status.commit!, []);
    await writeVerificationReport(join(taskDir(root, "feature", item.id), "verification-report.json"), report); return { approved: report.approved };
  };
  try {
    await acceptRun(root, declaration);
    const executor = executorForRoot(root, "feature", { taskRunner, checkpointReviewer, finalReviewer: async () => [] });
    const state = await (await startRun(root, "feature", "standalone", executor)).completion;
    assert.equal(state.outcome, "success"); assert.equal(state.finalGate.status, "passed");
    assert.equal(await readFile(join(root, "standalone.txt"), "utf8"), "integrated\n", "production integration cherry-picks standalone output");
    assert.equal((await readStatus(root, "feature", "write")).state, "integrated");
  } finally { await suspendRuns(root); await rm(root, { recursive: true, force: true }); }
}

async function productionMultiTurnCheckpoint(): Promise<void> {
  const { root, requirements } = await fixture();
  const shared = { checkpoint: "shared", checkpointOutcome: "deliver shared files", checkpointSurface: ["first.txt", "second.txt"] };
  const first = { ...task("first"), ...shared, surface: ["first.txt"], verificationCommands: ["git diff --check"], affectedAcceptanceTestIds: ["at-2"], acceptanceChecks: [{ testId: "at-2", command: "npm run integration" }] };
  const second = { ...task("second"), ...shared, surface: ["second.txt"], verificationCommands: ["git diff --check"], affectedAcceptanceTestIds: ["at-5", "at-8"], acceptanceChecks: [{ testId: "at-5", command: "npm run smoke" }, { testId: "at-8", command: "npm run static" }] };
  const declaration: RunDeclaration = { schemaVersion: 1, id: "multi", featureId: "feature", concurrency: 2, tasks: [first, second] };
  const seenWorktrees: string[] = []; const prompts: string[] = []; let reviews = 0;
  const taskRunner: any = async (_root: string, input: any) => {
    seenWorktrees.push(input.sharedWorktree); prompts.push(input.prompt); await writeFile(join(input.sharedWorktree, `${input.taskId}.txt`), `${input.taskId}\n`);
    if (input.taskId === "first") { await git(input.sharedWorktree, ["add", "first.txt"]); await git(input.sharedWorktree, ["commit", "-qm", "intermediate retry-era commit"]); }
    await createTask(root, { schemaVersion: 1, id: input.taskId, featureId: "feature", title: input.title, prompt: input.prompt, mode: "write", profile: "worker", dependsOn: [], createdAt: new Date().toISOString() });
    await atomicJson(join(attemptDir(root, "feature", input.taskId, 1), "evidence.json"), evidence(requirements, "pending"));
    await writeStatus(root, { schemaVersion: 1, featureId: "feature", taskId: input.taskId, state: "done", currentAttempt: 1, worktree: input.sharedWorktree, updatedAt: new Date().toISOString() });
    return { receipt: "fixture", finalText: "touch SHOULD_NOT_EXIST", attemptPath: attemptDir(root, "feature", input.taskId, 1), operationId: "fixture" };
  };
  try {
    await acceptRun(root, declaration);
    const executor = executorForRoot(root, "feature", { taskRunner, checkpointReviewer: async (item) => {
      reviews++; const status = await readStatus(root, "feature", item.id);
      const checked = await validateBuilderEvidence(requirements, await readJson<unknown>(join(attemptDir(root, "feature", item.id, status.currentAttempt), "evidence.json")), status.commit);
      assert.equal(checked.valid, true); const report = await rerunAcceptanceTests(requirements, checked.evidence!, status.worktree!, status.commit!, []);
      await writeVerificationReport(join(taskDir(root, "feature", item.id), "verification-report.json"), report); return { approved: true };
    }, finalReviewer: async () => [] });
    const state = await (await startRun(root, "feature", "multi", executor)).completion;
    assert.equal(state.outcome, "success", JSON.stringify(state)); assert.equal(reviews, 1); assert.equal(new Set(seenWorktrees).size, 1, "both turns use one persistent worktree");
    assert.ok(prompts.every((prompt) => /Declared bounded-work contract/.test(prompt) && /Outcome:/.test(prompt) && /Allowed surface:/.test(prompt) && /Non-goals:/.test(prompt) && /Required verification commands/.test(prompt)), "each worker receives the complete declared contract");
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first\n"); assert.equal(await readFile(join(root, "second.txt"), "utf8"), "second\n", "base-relative checkpoint integration includes earlier committed and later amended changes");
    const finalStatus = await readStatus(root, "feature", "second"); const parent = await git(seenWorktrees[0], ["rev-parse", `${finalStatus.commit}^`]);
    const workspace = await readJson<any>(join(featureDir(root, "feature"), "runs", "multi", "checkpoints", "shared", "workspace.json")); assert.equal(parent, workspace.baseCommit, "reviewed checkpoint is one base-relative commit");
    assert.equal(await readFile(join(attemptDir(root, "feature", "first", 1), "declared-verification.json"), "utf8").then((text) => JSON.parse(text).records[0].result), "passed");
    const secondVerification = await readJson<any>(join(attemptDir(root, "feature", "second", 1), "declared-verification.json"));
    assert.equal(secondVerification.records[0].sourceStateUnchanged, true, "targeted command is proven side-effect free");
    assert.equal(secondVerification.records[0].sourceStateBefore, secondVerification.records[0].sourceStateAfter);
    assert.equal(secondVerification.binding.patchHash, secondVerification.records.at(-1).sourceStateAfter, "preseal evidence binds the unchanged post-check state including untracked path contents");
    const checkpointManifest = await readJson<any>(join(attemptDir(root, "feature", "second", 1), "evidence-manifest.json"));
    for (const [testId, fidelity] of [["at-2", "integration"], ["at-5", "realistic-smoke"], ["at-8", "static"]]) assert.equal(checkpointManifest.records.find((record: any) => record.id === `builder-${testId}`)?.fidelity, fidelity, `checkpoint manifest derives ${testId} provenance from requirements`);
    assert.equal(await readFile(join(root, "SHOULD_NOT_EXIST"), "utf8").then(() => true, () => false), false, "worker output is never executed as shell text");
  } finally { await suspendRuns(root); await rm(root, { recursive: true, force: true }); }
}

async function productionDeclaredVerificationFailure(): Promise<void> {
  const { root, requirements } = await fixture(); let reviews = 0;
  const failing = { ...task("failing"), checkpoint: "failing-checkpoint", verificationCommands: ["npm test", "git diff --check"] };
  const declaration: RunDeclaration = { schemaVersion: 1, id: "verification-failure", featureId: "feature", tasks: [failing] };
  const taskRunner: any = async (_root: string, input: any) => {
    await createTask(root, { schemaVersion: 1, id: input.taskId, featureId: "feature", title: input.title, prompt: input.prompt, mode: "write", profile: "worker", dependsOn: [], createdAt: new Date().toISOString() });
    await atomicJson(join(attemptDir(root, "feature", input.taskId, 1), "evidence.json"), evidence(requirements, "pending"));
    await writeStatus(root, { schemaVersion: 1, featureId: "feature", taskId: input.taskId, state: "done", currentAttempt: 1, worktree: input.sharedWorktree, updatedAt: new Date().toISOString() });
    return { receipt: "fixture", finalText: "fixture", attemptPath: attemptDir(root, "feature", input.taskId, 1), operationId: "fixture" };
  };
  try {
    await acceptRun(root, declaration);
    const state = await (await startRun(root, "feature", "verification-failure", executorForRoot(root, "feature", { taskRunner, checkpointReviewer: async () => { reviews++; return { approved: true }; } }))).completion;
    assert.equal(state.outcome, "failed"); assert.equal(reviews, 0, "failed declared command blocks review");
    const persisted = await readJson<any>(join(attemptDir(root, "feature", "failing", 1), "declared-verification.json"));
    assert.equal(persisted.records[0].command, "npm test"); assert.equal(persisted.records[0].result, "failed"); assert.equal(persisted.records[1].result, "passed", "every declared command executes even after an earlier failure"); assert.equal(persisted.requirementsRevision, requirements.requirementsRevision); assert.equal(persisted.binding.kind, "commit");
  } finally { await suspendRuns(root); await rm(root, { recursive: true, force: true }); }
}

async function productionVerificationMutationGuards(): Promise<void> {
  const cases = [
    { id: "mutate-tracked", command: "npm run unit", changed: "base.txt", argument: "--mutate-tracked" as const },
    { id: "create-untracked", command: "npm run unit", changed: "generated-by-check.txt", argument: "--create-untracked" as const },
  ];
  for (const scenario of cases) {
    const { root, requirements } = await fixture(scenario.argument); let reviews = 0;
    const declaration: RunDeclaration = { schemaVersion: 1, id: scenario.id, featureId: "feature", tasks: [{ ...task(scenario.id), checkpoint: scenario.id, verificationCommands: [scenario.command, "git diff --check"] }] };
    const taskRunner: any = async (_root: string, input: any) => {
      await writeFile(join(input.sharedWorktree, `${input.taskId}.txt`), "intended\n");
      await createTask(root, { schemaVersion: 1, id: input.taskId, featureId: "feature", title: input.title, prompt: input.prompt, mode: "write", profile: "worker", dependsOn: [], createdAt: new Date().toISOString() });
      await atomicJson(join(attemptDir(root, "feature", input.taskId, 1), "evidence.json"), evidence(requirements, "pending"));
      await writeStatus(root, { schemaVersion: 1, featureId: "feature", taskId: input.taskId, state: "done", currentAttempt: 1, worktree: input.sharedWorktree, updatedAt: new Date().toISOString() });
      return { receipt: "fixture", finalText: "fixture", attemptPath: attemptDir(root, "feature", input.taskId, 1), operationId: "fixture" };
    };
    try {
      await acceptRun(root, declaration);
      const state = await (await startRun(root, "feature", scenario.id, executorForRoot(root, "feature", { taskRunner, checkpointReviewer: async () => { reviews++; return { approved: true }; } }))).completion;
      assert.equal(state.outcome, "failed"); assert.equal(reviews, 0, "source mutation blocks checkpoint review and sealing");
      const record = await readJson<any>(join(attemptDir(root, "feature", scenario.id, 1), "declared-verification.json"));
      assert.equal(record.records[0].result, "failed"); assert.equal(record.records[0].sourceStateUnchanged, false); assert.notEqual(record.records[0].sourceStateBefore, record.records[0].sourceStateAfter); assert.equal(record.records[1].result, "passed", "all declared commands still run with their own before/after state binding");
      assert.equal(await readFile(join(record.worktree, scenario.changed), "utf8").then(() => true, () => false), true, "mutated source remains auditable for explicit repair");
      assert.equal((await readStatus(root, "feature", scenario.id)).commit, undefined, "mutating command cannot seal a checkpoint commit");
    } finally { await suspendRuns(root); await rm(root, { recursive: true, force: true }); }
  }
}

async function seedDirectTask(root: string, requirements: RequirementsState, id: string, conflict = false): Promise<{ sourceCommit: string; worktree: string }> {
  const worktree = join(attemptDir(root, "feature", id, 1), "worktree"); const branch = `fixture-${id}`;
  const mappings = [{ testId: "at-2", command: "npm run integration" }, { testId: "at-5", command: "npm run smoke" }, { testId: "at-8", command: "npm run static" }];
  await createTask(root, { schemaVersion: 1, id, featureId: "feature", title: id, prompt: id, mode: "write", profile: "worker", dependsOn: [], affectedAcceptanceTestIds: mappings.map((item) => item.testId), acceptanceChecks: mappings, createdAt: new Date().toISOString() });
  await git(root, ["worktree", "add", "-q", "-b", branch, worktree]); await writeFile(join(worktree, `${id}.txt`), `${id}\n`); if (conflict) await writeFile(join(worktree, "base.txt"), "source\n"); await git(worktree, ["add", `${id}.txt`, ...(conflict ? ["base.txt"] : [])]); await git(worktree, ["commit", "-qm", id]);
  const sourceCommit = await git(worktree, ["rev-parse", "HEAD"]); await atomicJson(join(attemptDir(root, "feature", id, 1), "evidence.json"), evidence(requirements, sourceCommit));
  const verification = await rerunAcceptanceTests(requirements, evidence(requirements, sourceCommit), worktree, sourceCommit, [], { canonicalCommands: new Map(mappings.map((item) => [item.testId, item.command])), requireCanonicalCommands: true });
  await writeVerificationReport(join(taskDir(root, "feature", id), "verification-report.json"), verification);
  await writeStatus(root, { schemaVersion: 1, featureId: "feature", taskId: id, state: "review", currentAttempt: 1, branch, worktree, commit: sourceCommit, updatedAt: new Date().toISOString() });
  return { sourceCommit, worktree };
}

async function productionDirectFinalGate(): Promise<void> {
  const passing = await fixture();
  try {
    const seeded = await seedDirectTask(passing.root, passing.requirements, "direct-pass");
    const result = await executeDirectFinalIntegration(passing.root, "feature", "direct-pass", new AbortController().signal, { independentReview: async () => [] });
    assert.equal(result.gate.status, "passed"); assert.equal(result.gate.sourceCommit, seeded.sourceCommit); assert.equal(result.gate.coordinatorCommit, result.coordinatorCommit);
    assert.equal(result.gate.canonicalMappings.length, 3); assert.equal(result.gate.reportRef?.commit, result.coordinatorCommit); assert.equal(result.gate.manifestRef?.commit, result.coordinatorCommit);
    assert.equal((await readStatus(passing.root, "feature", "direct-pass")).state, "integrated");
  } finally { await rm(passing.root, { recursive: true, force: true }); }

  const retrying = await fixture();
  try {
    await seedDirectTask(retrying.root, retrying.requirements, "direct-retry");
    directFinalFindings = [{ severity: "high", status: "open", summary: "transient verified final finding" }];
    await assert.rejects(publicIntegrate.execute("direct-failure", { featureId: "feature", taskId: "direct-retry" }, undefined, undefined, { cwd: retrying.root }), /blocked integration/);
    const blocked = await readJson<any>(join(attemptDir(retrying.root, "feature", "direct-retry", 1), "direct-final-gate.json"));
    assert.equal(blocked.status, "blocked"); assert.match(blocked.retryGuidance, /not be repeated/); assert.equal((await readStatus(retrying.root, "feature", "direct-retry")).state, "review");
    const afterFirstPick = await git(retrying.root, ["rev-parse", "HEAD"]); directFinalFindings = [];
    const resumed = await publicIntegrate.execute("direct-resume", { featureId: "feature", taskId: "direct-retry" }, undefined, undefined, { cwd: retrying.root });
    assert.equal(resumed.details.finalGate.status, "passed"); assert.equal(resumed.details.coordinatorCommit, afterFirstPick, "public retry reuses the exact coordinator commit and never duplicates cherry-pick");
  } finally { await rm(retrying.root, { recursive: true, force: true }); }
}

async function productionIntegrationConflictRecovery(): Promise<void> {
  for (const mode of ["direct", "run"] as const) {
    const { root, requirements } = await fixture(); const id = `${mode}-conflict`;
    try {
      await seedDirectTask(root, requirements, id, true);
      await writeFile(join(root, "base.txt"), "coordinator\n"); await git(root, ["add", "base.txt"]); await git(root, ["commit", "-qm", `${id}-coordinator-conflict`]);
      const conflictingHead = await git(root, ["rev-parse", "HEAD"]);
      const invoke = async () => {
        if (mode === "direct") return publicIntegrate.execute(`${id}-integrate`, { featureId: "feature", taskId: id }, undefined, undefined, { cwd: root });
        return executorForRoot(root, "feature").integrate(task(id), { runId: id, signal: new AbortController().signal, affectedAcceptanceTestIds: ["at-2", "at-5", "at-8"] });
      };
      await assert.rejects(invoke(), /restored cleanly/);
      assert.equal(await git(root, ["rev-parse", "HEAD"]), conflictingHead, `${mode} conflict restores the exact pre-integration HEAD`);
      assert.equal(await git(root, ["status", "--porcelain"]), "", `${mode} conflict leaves a clean coordinator worktree`);
      assert.equal(await readFile(join(root, "base.txt"), "utf8"), "coordinator\n");
      assert.equal((await readStatus(root, "feature", id)).state, "review", `${mode} conflict has no integration-success task effect`);
      const blocked = await readJson<any>(join(attemptDir(root, "feature", id, 1), "integration-attempt.json"));
      assert.equal(blocked.status, "blocked"); assert.match(blocked.retryGuidance, /retry/i);
      if (mode === "direct") { const gate = await readJson<any>(join(attemptDir(root, "feature", id, 1), "direct-final-gate.json")); assert.equal(gate.status, "blocked"); assert.equal(gate.coordinatorCommit, undefined); }

      await writeFile(join(root, "base.txt"), "base\n"); await git(root, ["add", "base.txt"]); await git(root, ["commit", "-qm", `${id}-resolve-base`]);
      const result: any = await invoke();
      const integratedHead = await git(root, ["rev-parse", "HEAD"]);
      assert.equal((await readStatus(root, "feature", id)).state, "integrated");
      const applied = await readJson<any>(join(attemptDir(root, "feature", id, 1), "integration-attempt.json")); assert.equal(applied.status, "applied");
      const subjects = (await git(root, ["log", "--format=%s"])).split(/\r?\n/).filter((subject) => subject === id);
      assert.equal(subjects.length, 1, `${mode} retry applies the reviewed patch exactly once`);
      if (mode === "direct") assert.equal(result.details.coordinatorCommit, integratedHead);
      else {
        assert.equal(result.combinedCoordinatorCommit, integratedHead);
        const retryStatus = await readStatus(root, "feature", id); retryStatus.state = "review"; retryStatus.message = "simulated interrupted post-pick persistence"; await writeStatus(root, retryStatus);
        const reused: any = await invoke();
        assert.equal(reused.combinedCoordinatorCommit, integratedHead); assert.equal(await git(root, ["rev-parse", "HEAD"]), integratedHead);
        assert.equal((await git(root, ["log", "--format=%s"])).split(/\r?\n/).filter((subject) => subject === id).length, 1, "run retry detects the patch-equivalent ancestor and never duplicates cherry-pick");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

async function productionNoImplementationCheckpoint(): Promise<void> {
  const { root, requirements } = await fixture(); let reviews = 0; let finalGates = 0;
  const empty = { ...task("empty"), checkpoint: "empty-checkpoint", verificationCommands: ["git diff --check"] };
  const declaration: RunDeclaration = { schemaVersion: 1, id: "empty-checkpoint-run", featureId: "feature", tasks: [empty] };
  const taskRunner: any = async (_root: string, input: any) => {
    await createTask(root, { schemaVersion: 1, id: input.taskId, featureId: "feature", title: input.title, prompt: input.prompt, mode: "write", profile: "worker", dependsOn: [], createdAt: new Date().toISOString() });
    await atomicJson(join(attemptDir(root, "feature", input.taskId, 1), "evidence.json"), evidence(requirements, "pending"));
    await writeStatus(root, { schemaVersion: 1, featureId: "feature", taskId: input.taskId, state: "done", currentAttempt: 1, worktree: input.sharedWorktree, updatedAt: new Date().toISOString() });
    return { receipt: "fixture", finalText: "no changes", attemptPath: attemptDir(root, "feature", input.taskId, 1), operationId: "fixture" };
  };
  try {
    await acceptRun(root, declaration);
    const executor = executorForRoot(root, "feature", { taskRunner, checkpointReviewer: async () => { reviews++; return { approved: true }; }, finalReviewer: async () => { finalGates++; return []; } });
    const state = await (await startRun(root, "feature", "empty-checkpoint-run", executor)).completion;
    assert.equal(state.outcome, "blocked"); assert.equal(reviews, 0); assert.equal(finalGates, 0); assert.notEqual(state.finalGate.status, "passed");
    assert.match((await readStatus(root, "feature", "empty")).message ?? "", /no implementation commit/i);
  } finally { await suspendRuns(root); await rm(root, { recursive: true, force: true }); }
}

await productionFinalGate();
await productionFinalMutationIsolation();
await productionStandaloneCompatibility();
await productionMultiTurnCheckpoint();
await productionDeclaredVerificationFailure();
await productionVerificationMutationGuards();
await productionDirectFinalGate();
await productionIntegrationConflictRecovery();
await productionNoImplementationCheckpoint();
console.log("production final-gate and standalone compatibility tests passed");

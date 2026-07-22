import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicJson, exists, featureDir } from "./storage.ts";
import {
  acceptRun,
  applyProposal,
  approveProposal,
  buildReflection,
  cancelRun,
  chooseFeatureWorkflow,
  getRun,
  listProposals,
  retryRunTask,
  retryRunFinalGate,
  runReflection,
  startRun,
  stableTopologicalOrder,
  suspendRuns,
  validateRunDeclaration,
  type ReflectionEvidence,
  type RunDeclaration,
  type RunExecutor,
  type RunRecord,
} from "./runs.ts";

const execFileAsync = promisify(execFile);

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-runs-test-"));
  await atomicJson(join(featureDir(value, "feature"), "feature.json"), { schemaVersion: 1, id: "feature" });
  return value;
}
function declaration(id: string, tasks: RunDeclaration["tasks"], concurrency = 2): RunDeclaration {
  const grouped = new Map<string, RunDeclaration["tasks"]>();
  for (const item of tasks) if (item.checkpoint) grouped.set(item.checkpoint, [...(grouped.get(item.checkpoint) ?? []), item]);
  const normalized = tasks.map((item) => {
    const members = item.checkpoint ? grouped.get(item.checkpoint)! : [];
    if (members.length < 2) return item;
    return { ...item, checkpointOutcome: item.checkpointOutcome ?? `complete checkpoint ${item.checkpoint}`, checkpointSurface: item.checkpointSurface ?? [...new Set(members.flatMap((member) => member.surface))] };
  });
  return { schemaVersion: 1, id, featureId: "feature", concurrency, tasks: normalized };
}
function task(id: string, dependsOn: string[] = [], mode: "read" | "write" = "read") {
  return {
    id, title: id, prompt: `perform ${id}`, mode, profile: mode === "write" ? "worker" : "scout", dependsOn,
    outcome: `complete ${id}`, surface: [`${id}.ts`], nonGoals: ["Do not modify unrelated paths"], verificationCommands: ["git diff --check"],
  };
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
async function poll(rootPath: string, runId: string, predicate: (state: RunRecord) => boolean, timeout = 3_000): Promise<RunRecord> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await getRun(rootPath, "feature", runId);
    if (predicate(state)) return state;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${runId}`);
}

async function graphValidationAndAtomicity(): Promise<void> {
  const rootPath = await root();
  try {
    const invalid = declaration("invalid", [
      task("dup", ["missing", "dup"]),
      task("dup", ["cycle-a"]),
      task("cycle-a", ["cycle-b"]),
      task("cycle-b", ["cycle-a"]),
    ]);
    const bounded = declaration("bounded", [task("valid")]);
    assert.deepEqual(validateRunDeclaration(bounded), [], "a structurally bounded declaration is valid");
    for (const [field, code, value] of [
      ["outcome", "invalid-outcome", ""],
      ["surface", "invalid-surface", []],
      ["nonGoals", "invalid-non-goals", []],
      ["verificationCommands", "invalid-verification-commands", []],
    ] as const) {
      const invalidBound = declaration(`missing-${field}`, [{ ...task("bounded"), [field]: value }]);
      const boundIssues = validateRunDeclaration(invalidBound);
      assert.ok(boundIssues.some((issue) => issue.code === code), `${field} is rejected before scheduling`);
      await assert.rejects(acceptRun(rootPath, invalidBound), new RegExp(code));
      assert.equal(await exists(join(featureDir(rootPath, "feature"), "runs", `missing-${field}`)), false);
    }
    const strictBounds = [
      ["zero-surface", { surface: [] }, "invalid-surface"],
      ["nine-surface", { surface: Array.from({ length: 9 }, (_, index) => `surface-${index}.ts`) }, "invalid-surface"],
      ["thousand-surface", { surface: Array.from({ length: 1_000 }, (_, index) => `surface-${index}.ts`) }, "invalid-surface"],
      ["repo-surface", { surface: ["."] }, "invalid-surface"],
      ["wildcard-surface", { surface: ["src/**"] }, "invalid-surface"],
      ["list-outcome", { outcome: "implement parser, add tests" }, "invalid-outcome"],
      ["and-outcome", { outcome: "implement parser and add tests" }, "invalid-outcome"],
      ["none-non-goal", { nonGoals: ["N/A"] }, "invalid-non-goals"],
      ["echo-check", { verificationCommands: ["echo pass"] }, "invalid-verification-commands"],
      ["printf-check", { verificationCommands: ["printf pass"] }, "invalid-verification-commands"],
      ["true-check", { verificationCommands: ["true"] }, "invalid-verification-commands"],
      ["exit-zero", { verificationCommands: ["exit 0"] }, "invalid-verification-commands"],
      ["truthiness-test", { verificationCommands: ["test value"] }, "invalid-verification-commands"],
      ["false-or-true", { verificationCommands: ["false || true"] }, "invalid-verification-commands"],
      ["shell-true", { verificationCommands: ["sh -c true"] }, "invalid-verification-commands"],
      ["empty-node", { verificationCommands: ["node -e ''"] }, "invalid-verification-commands"],
      ["inline-node-no-check", { verificationCommands: ["node -e 'console.log(1)'"] }, "invalid-verification-commands"],
      ["trivial-pipeline", { verificationCommands: ["true | cat"] }, "invalid-verification-commands"],
      ["all-files-alias", { surface: ["ALL-FILES"] }, "invalid-surface"],
      ["whole-repository-alias", { surface: ["whole-repository"] }, "invalid-surface"],
      ["traversal-surface", { surface: ["../outside.ts"] }, "invalid-surface"],
      ["none-phrase", { nonGoals: ["None beyond this task"] }, "invalid-non-goals"],
      ["env-true", { verificationCommands: ["env true"] }, "invalid-verification-commands"],
      ["assert-true", { verificationCommands: ["node -e 'const assert=require(\"assert\"); assert.ok(true)'"] }, "invalid-verification-commands"],
      ["fallback-control", { verificationCommands: ["npm test || true"] }, "invalid-verification-commands"],
      ["plus-outcome", { outcome: "implement parser plus tests" }, "invalid-outcome"],
      ["equivalent-outcome", { outcome: "implement parser along with tests" }, "invalid-outcome"],
      ["not-excluding", { nonGoals: ["Do not exclude any changes"] }, "invalid-non-goals"],
      ["no-unrelated", { nonGoals: ["No unrelated changes"] }, "invalid-non-goals"],
      ["help-noop", { verificationCommands: ["npm test --help"] }, "invalid-verification-commands"],
      ["slash-outcome", { outcome: "implement parser/tests" }, "invalid-outcome"],
      ["pipe-outcome", { outcome: "implement parser | tests" }, "invalid-outcome"],
      ["while-outcome", { outcome: "implement parser while testing" }, "invalid-outcome"],
      ["before-outcome", { outcome: "implement parser before tests" }, "invalid-outcome"],
      ["with-outcome", { outcome: "implement parser with tests" }, "invalid-outcome"],
      ["inverted-non-goal", { nonGoals: ["Avoid having any non-goals"] }, "invalid-non-goals"],
      ["outside-scope-non-goal", { nonGoals: ["Do not exclude changes outside scope"] }, "invalid-non-goals"],
      ["everything-scope-non-goal", { nonGoals: ["Leave everything in scope"] }, "invalid-non-goals"],
      ["collect-only", { verificationCommands: ["pytest --collect-only"] }, "invalid-verification-commands"],
      ["cargo-no-run", { verificationCommands: ["cargo test --no-run"] }, "invalid-verification-commands"],
      ["tsc-show-config", { verificationCommands: ["npx tsc --showConfig"] }, "invalid-verification-commands"],
      ["go-list", { verificationCommands: ["go test -list x"] }, "invalid-verification-commands"],
      ["bare-test", { verificationCommands: ["test -f package.json"] }, "invalid-verification-commands"],
      ["absolute-test", { verificationCommands: ["/usr/bin/test -f /tmp"] }, "invalid-verification-commands"],
    ] as const;
    for (const [name, patch, code] of strictBounds) {
      const candidate = declaration(name, [{ ...task("bounded"), ...patch }]);
      const boundIssues = validateRunDeclaration(candidate);
      assert.ok(boundIssues.some((issue) => issue.code === code && /split|specific|meaningful|objective/.test(issue.message)), `${name} receives an actionable strict-bound reason`);
      await assert.rejects(acceptRun(rootPath, candidate), new RegExp(code));
      assert.equal(await exists(join(featureDir(rootPath, "feature"), "runs", name)), false, `${name} is rejected before scheduling side effects`);
    }
    for (const command of ["npm test", "npm run lint", "npx tsc --noEmit", "git diff --check", "cargo test", "go test ./pkg"]) {
      assert.deepEqual(validateRunDeclaration(declaration(`valid-${command.replace(/[^a-z]/gi, "").toLowerCase()}`, [{ ...task("bounded"), verificationCommands: [command] }])), [], `${command} remains an objective verification command`);
    }
    for (const [name, surface] of [["one-specific-surface", ["extensions/agent-work/runs.ts"]], ["directory-prefix-surface", ["extensions/agent-work/"]], ["eight-specific-surfaces", Array.from({ length: 8 }, (_, index) => `component-${index}.ts`)]] as const) {
      const candidate = declaration(name, [{ ...task("bounded"), surface }]);
      assert.deepEqual(validateRunDeclaration(candidate), [], `${name} remains a valid bounded declaration`);
    }
    const overlapBase = { ...task("overlap"), affectedAcceptanceTestIds: ["at-1"], acceptanceChecks: [{ testId: "at-1", command: "git diff --check" }] };
    assert.deepEqual(validateRunDeclaration(declaration("overlap-ok", [overlapBase, { ...overlapBase, id: "overlap-two" }])), [], "identical canonical acceptance mappings coalesce");
    assert.ok(validateRunDeclaration(declaration("overlap-conflict", [overlapBase, { ...overlapBase, id: "overlap-two", acceptanceChecks: [{ testId: "at-1", command: "npm test" }] }])).some((issue) => issue.code === "conflicting-acceptance-check"), "conflicting canonical mappings reject before launch");
    const issues = validateRunDeclaration(invalid);
    assert.ok(issues.some((issue) => issue.code === "duplicate-task-id"));
    assert.ok(issues.some((issue) => issue.code === "missing-dependency"));
    assert.ok(issues.some((issue) => issue.code === "self-dependency"));
    assert.ok(issues.some((issue) => issue.code === "dependency-cycle"));
    await assert.rejects(acceptRun(rootPath, invalid), /rejected/);
    assert.equal(await exists(join(featureDir(rootPath, "feature"), "runs", "invalid")), false, "invalid graph has no side effects");
    assert.equal(chooseFeatureWorkflow([task("one")]), "serial");
    assert.equal(chooseFeatureWorkflow([task("one"), task("two", ["one"])]), "serial");
    assert.equal(chooseFeatureWorkflow([task("one"), task("two")]), "run");
    assert.ok(validateRunDeclaration(declaration("large", Array.from({ length: 201 }, (_, index) => task(`task-${index}`)))).some((issue) => issue.code === "graph-too-large"));
    const reversed = declaration("reversed", [
      { ...task("first", ["second"], "write"), checkpoint: "ordered" },
      { ...task("second", [], "write"), checkpoint: "ordered" },
    ]);
    assert.ok(validateRunDeclaration(reversed).some((issue) => issue.code === "checkpoint-order-dependency"), "a turn cannot explicitly depend on a later checkpoint turn");
    const unrelated = declaration("unrelated", [
      { ...task("one", [], "write"), checkpoint: "shared", checkpointOutcome: "one outcome", checkpointSurface: ["one.ts", "two.ts"] },
      { ...task("two", [], "write"), checkpoint: "shared", checkpointOutcome: "different outcome", checkpointSurface: ["two.ts", "one.ts"] },
    ]);
    const groupingIssues = validateRunDeclaration(unrelated);
    assert.ok(groupingIssues.some((issue) => issue.code === "checkpoint-outcome-mismatch"), "declared unrelated outcomes cannot share a checkpoint");
    assert.ok(groupingIssues.some((issue) => issue.code === "checkpoint-surface-mismatch"), "shared allowed surfaces must agree exactly");
    const outside = declaration("outside", [
      { ...task("one", [], "write"), checkpoint: "shared", checkpointOutcome: "shared", checkpointSurface: ["one.ts"] },
      { ...task("two", [], "write"), checkpoint: "shared", checkpointOutcome: "shared", checkpointSurface: ["one.ts"] },
    ]);
    assert.ok(validateRunDeclaration(outside).some((issue) => issue.code === "turn-surface-outside-checkpoint"), "turn scope cannot escape the checkpoint surface");
    const externalIntermediateDependency = declaration("external-intermediate", [
      { ...task("first", [], "write"), checkpoint: "shared" },
      { ...task("final", [], "write"), checkpoint: "shared" },
      task("consumer", ["first"], "write"),
    ]);
    const externalDependencyIssues = validateRunDeclaration(externalIntermediateDependency);
    assert.ok(externalDependencyIssues.some((issue) => issue.code === "external-dependency-nonfinal-checkpoint-member"), "external dependents cannot target an intermediate checkpoint turn");
    await assert.rejects(acceptRun(rootPath, externalIntermediateDependency), /external-dependency-nonfinal-checkpoint-member/);
    const finalDependency = declaration("external-final", [
      { ...task("first", [], "write"), checkpoint: "shared" },
      { ...task("final", [], "write"), checkpoint: "shared" },
      task("consumer", ["final"], "write"),
    ]);
    assert.deepEqual(validateRunDeclaration(finalDependency), []); assert.deepEqual(stableTopologicalOrder(finalDependency.tasks), ["first", "final", "consumer"]);
    const implicitCycle = declaration("implicit-cycle", [
      { ...task("first", ["outside"], "write"), checkpoint: "ordered" },
      { ...task("second", [], "write"), checkpoint: "ordered" },
      task("outside", ["second"]),
    ]);
    assert.ok(validateRunDeclaration(implicitCycle).some((issue) => issue.code === "dependency-cycle"), "implicit checkpoint order participates in cycle validation");
    const externalBeforeCheckpoint = [
      { ...task("first", ["external"], "write"), checkpoint: "ordered" },
      { ...task("second", [], "write"), checkpoint: "ordered" },
      task("external", [], "write"),
    ];
    assert.deepEqual(stableTopologicalOrder(externalBeforeCheckpoint), ["external", "first", "second"], "integration order includes implicit checkpoint edges when an earlier member depends on a later-declared external write");
    const acceptedOrder = await acceptRun(rootPath, declaration("external-order", externalBeforeCheckpoint));
    assert.deepEqual(acceptedOrder.integrationOrder, ["external", "second"], "checkpoint integration waits for the external write before its sealed final member");
  } finally { await rm(rootPath, { recursive: true, force: true }); }
}

async function realisticGitSmoke(): Promise<void> {
  const rootPath = await root();
  const worktrees = new Map<string, string>(); const commits = new Map<string, string>(); const integrated: string[] = [];
  const git = async (args: string[], cwd = rootPath) => (await execFileAsync("git", args, { cwd })).stdout.trim();
  try {
    await git(["init", "-q"]); await git(["config", "user.email", "fixture@example.invalid"]); await git(["config", "user.name", "Fixture"]);
    await writeFile(join(rootPath, "base.txt"), "base\n"); await git(["add", "base.txt"]); await git(["commit", "-qm", "base"]);
    for (const id of ["one", "two"]) {
      const path = join(rootPath, ".worktrees", id); await git(["worktree", "add", "-q", "-b", `fixture-${id}`, path]); worktrees.set(id, path);
    }
    const executor: RunExecutor = {
      async delegate(item) {
        const cwd = worktrees.get(item.id)!; await writeFile(join(cwd, `${item.id}.txt`), `${item.id}\n`);
        await git(["add", `${item.id}.txt`], cwd); await git(["commit", "-qm", item.id], cwd); commits.set(item.id, await git(["rev-parse", "HEAD"], cwd));
        return { outcome: "review", durationMs: 10 };
      },
      async review(item) {
        assert.equal(await git(["rev-parse", "HEAD"], worktrees.get(item.id)!), commits.get(item.id), "review binds the exact task commit");
        return { approved: true };
      },
      async integrate(item) { await git(["cherry-pick", commits.get(item.id)!]); integrated.push(item.id); return { combinedCoordinatorCommit: await git(["rev-parse", "HEAD"]) }; },
      async finalGate({ combinedCoordinatorCommit }) { return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [], reportPath: "final-report.json" }; },
    };
    await acceptRun(rootPath, declaration("git-smoke", [task("one", [], "write"), task("two", [], "write")], 2));
    const state = await (await startRun(rootPath, "feature", "git-smoke", executor)).completion;
    assert.equal(state.outcome, "success"); assert.deepEqual(integrated, ["one", "two"]);
    assert.equal(await readFile(join(rootPath, "one.txt"), "utf8"), "one\n"); assert.equal(await readFile(join(rootPath, "two.txt"), "utf8"), "two\n");
    await poll(rootPath, "git-smoke", (candidate) => candidate.reflection.status === "complete");
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function concurrencyCapReviewAndIntegration(): Promise<void> {
  const rootPath = await root();
  let activeAgents = 0; let maxAgents = 0;
  const starts: Record<string, number> = {}; const ends: Record<string, number> = {}; const integrated: string[] = [];
  const executor: RunExecutor = {
    async delegate(item, { signal }) {
      starts[item.id] = Date.now(); activeAgents++; maxAgents = Math.max(maxAgents, activeAgents);
      await delay(40, signal); activeAgents--; ends[item.id] = Date.now();
      return { outcome: item.mode === "write" ? "review" : "completed", durationMs: 40 };
    },
    async review(_item, { signal }) { activeAgents++; maxAgents = Math.max(maxAgents, activeAgents); await delay(20, signal); activeAgents--; return { approved: true }; },
    async integrate(item) { integrated.push(item.id); await delay(2); return { combinedCoordinatorCommit: "a".repeat(40) }; },
    async finalGate({ combinedCoordinatorCommit }) { return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [] }; },
  };
  try {
    const graph = declaration("parallel", [task("a", [], "write"), task("b", [], "write"), task("c", ["a", "b"])], 2);
    if (!(await exists(join(featureDir(rootPath, "feature"), "runs", "parallel")))) await acceptRun(rootPath, graph);
    const handle = await startRun(rootPath, "feature", "parallel", executor);
    const state = await handle.completion;
    assert.equal(state.outcome, "success");
    assert.equal(maxAgents, 2, "builders and reviewers share the cap");
    assert.ok(starts.a < ends.b && starts.b < ends.a, "independent work overlaps");
    assert.ok(starts.c >= Math.max(ends.a, ends.b), "dependent waits for both prerequisites to fully complete");
    assert.deepEqual(integrated, ["a", "b"], "writing tasks integrate serially in stable order");
    assert.equal(state.maxActiveCount, 2);
    const reflected = await poll(rootPath, "parallel", (candidate) => candidate.reflection.status === "complete");
    assert.ok(reflected.reflection.path);
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function checkpointLifecycle(): Promise<void> {
  const rootPath = await root();
  const events: string[] = []; const reviews: string[] = []; const integrated: string[] = [];
  const executor: RunExecutor = {
    async delegate(item, context) {
      events.push(`delegate:${item.id}:${context.checkpointId ?? "none"}:${context.checkpointFinal}`);
      return { outcome: item.mode === "write" ? "review" : "completed", durationMs: 1 };
    },
    async review(item) { reviews.push(item.id); events.push(`review:${item.id}`); return { approved: true }; },
    async integrate(item) { integrated.push(item.id); events.push(`integrate:${item.id}`); return { combinedCoordinatorCommit: "b".repeat(40) }; },
    async finalGate({ combinedCoordinatorCommit }) { return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [] }; },
  };
  try {
    const scout = task("scout");
    const first = { ...task("first", [], "write"), checkpoint: "feature-change", affectedAcceptanceTestIds: ["at-1"] };
    const second = { ...task("second", [], "write"), checkpoint: "feature-change", affectedAcceptanceTestIds: ["at-2"] };
    await acceptRun(rootPath, declaration("checkpoint", [scout, first, second], 2));
    const state = await (await startRun(rootPath, "feature", "checkpoint", executor)).completion;
    assert.equal(state.outcome, "success");
    assert.deepEqual(state.checkpoints["feature-change"].members, ["first", "second"], "checkpoint membership is persisted");
    assert.deepEqual(state.checkpoints["feature-change"].affectedAcceptanceTestIds, ["at-1", "at-2"], "declared affected acceptance subset is persisted");
    assert.deepEqual({ mode: state.checkpoints["feature-change"].reviewMode, rationale: state.checkpoints["feature-change"].reviewRationale }, { mode: "focused", rationale: "focused review: no broad-review trigger declared" }, "low-risk checkpoint review selection is persisted");
    assert.equal(events.some((event) => event.startsWith("review:scout")), false, "read-only turn starts no review");
    assert.deepEqual(reviews, ["second"], "one review occurs only after the final checkpoint turn");
    assert.deepEqual(integrated, ["second"], "only the sealed final checkpoint turn integrates");
    assert.ok(events.indexOf("delegate:first:feature-change:false") < events.indexOf("delegate:second:feature-change:true"), "writing turns are serial");
    assert.ok(events.indexOf("delegate:second:feature-change:true") < events.indexOf("review:second"), "review follows the final turn");
    assert.ok(events.indexOf("review:second") < events.indexOf("integrate:second"), "integration follows checkpoint review");
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function sealedReviewOverridePersists(): Promise<void> {
  const rootPath = await root(); let reviewedMode = "";
  const executor: RunExecutor = {
    async delegate() { return { outcome: "review", checkpointReview: { mode: "broad", rationale: "broad review required: sealed diff triggers: public-contract" } }; },
    async review(_task, context) { reviewedMode = context.mode; assert.match(context.rationale, /sealed diff/); return { approved: true }; },
    async integrate() { return { combinedCoordinatorCommit: "9".repeat(40) }; },
    async finalGate({ combinedCoordinatorCommit }) { return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [] }; },
  };
  try {
    await acceptRun(rootPath, declaration("sealed-review", [task("write", [], "write")], 1));
    const state = await (await startRun(rootPath, "feature", "sealed-review", executor)).completion;
    assert.equal(reviewedMode, "broad");
    assert.equal(state.checkpoints.write.reviewMode, "broad", "sealed-diff escalation is persisted before review");
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function failedCheckpointTurnBlocksImplicitFollowers(): Promise<void> {
  for (const outcome of ["failed", "cancelled"] as const) {
    const rootPath = await root(); const launches: string[] = [];
    const executor: RunExecutor = {
      async delegate(item) { launches.push(item.id); return { outcome: item.id === "first" ? outcome : "review" }; },
      async review() { return { approved: true }; }, async integrate() {},
    };
    try {
      const first = { ...task("first", [], "write"), checkpoint: "ordered" };
      const second = { ...task("second", [], "write"), checkpoint: "ordered" };
      await acceptRun(rootPath, declaration(`checkpoint-${outcome}`, [first, second], 1));
      const state = await (await startRun(rootPath, "feature", `checkpoint-${outcome}`, executor)).completion;
      assert.deepEqual(launches, ["first"], `${outcome} predecessor prevents later implicit turn launch`);
      assert.equal(state.tasks.second.state, "blocked");
      assert.equal(state.tasks.second.waitReason, "dependency-failed");
      assert.equal(state.state, "terminal", "blocked implicit followers permit run settlement");
    } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
  }
}

async function repositoryDefaultCap(): Promise<void> {
  const rootPath = await root();
  let active = 0; let maximum = 0;
  const executor: RunExecutor = {
    async delegate(_item, { signal }) { active++; maximum = Math.max(maximum, active); await delay(25, signal); active--; return { outcome: "completed", durationMs: 25 }; },
    async review() { return { approved: true }; }, async integrate() {},
  };
  try {
    const graph = declaration("default-cap", [task("a"), task("b"), task("c"), task("d")]);
    delete graph.concurrency;
    const accepted = await acceptRun(rootPath, graph);
    assert.equal(accepted.effectiveCap, 3);
    await (await startRun(rootPath, "feature", "default-cap", executor)).completion;
    assert.equal(maximum, 3);
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function failureIsolationRetryAndCancellation(): Promise<void> {
  const rootPath = await root();
  const launches = new Map<string, number>();
  const executor: RunExecutor = {
    async delegate(item, { retry, signal }) {
      launches.set(item.id, (launches.get(item.id) ?? 0) + 1);
      await delay(item.id === "bad" ? 15 : 25, signal);
      if (item.id === "bad" && !retry) return { outcome: "failed", durationMs: 15 };
      return { outcome: "completed", durationMs: 25 };
    },
    async review() { return { approved: true }; }, async integrate() {},
  };
  try {
    await acceptRun(rootPath, declaration("failure", [task("bad"), task("dependent", ["bad"]), task("unrelated")]));
    await (await startRun(rootPath, "feature", "failure", executor)).completion;
    let state = await getRun(rootPath, "feature", "failure");
    assert.equal(state.tasks.bad.state, "failed");
    assert.equal(state.tasks.dependent.state, "blocked");
    assert.equal(state.tasks.unrelated.state, "completed");
    assert.equal(launches.get("bad"), 1, "no automatic retry");
    assert.equal(launches.has("dependent"), false);
    await startRun(rootPath, "feature", "failure", executor);
    await retryRunTask(rootPath, "feature", "failure", "bad");
    state = await poll(rootPath, "failure", (candidate) => candidate.state === "terminal" && candidate.outcome === "success");
    assert.equal(launches.get("bad"), 2);
    assert.equal(launches.get("dependent"), 1);

    await acceptRun(rootPath, declaration("cancel", [task("live"), task("child", ["live"]), task("other")]));
    await startRun(rootPath, "feature", "cancel", executor);
    await poll(rootPath, "cancel", (candidate) => candidate.tasks.live.state === "running");
    await cancelRun(rootPath, "feature", "cancel", "live");
    const cancelled = await poll(rootPath, "cancel", (candidate) => candidate.state === "terminal");
    assert.equal(cancelled.tasks.live.state, "cancelled");
    assert.equal(cancelled.tasks.child.state, "blocked");
    assert.equal(cancelled.tasks.other.state, "completed");

    await acceptRun(rootPath, declaration("cancel-all", [task("first"), task("second")], 1));
    await startRun(rootPath, "feature", "cancel-all", executor);
    await poll(rootPath, "cancel-all", (candidate) => candidate.tasks.first.state === "running");
    await cancelRun(rootPath, "feature", "cancel-all");
    const allCancelled = await poll(rootPath, "cancel-all", (candidate) => candidate.state === "terminal");
    assert.equal(allCancelled.outcome, "cancelled");
    assert.deepEqual(Object.values(allCancelled.tasks).map((item) => item.state), ["cancelled", "cancelled"]);
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function conflictRemainsBlocked(): Promise<void> {
  const rootPath = await root(); const integrated: string[] = [];
  const executor: RunExecutor = {
    async delegate() { return { outcome: "review", durationMs: 10 }; }, async review() { return { approved: true }; },
    async integrate(item) { if (item.id === "second") throw new Error("fixture conflict with secret=not-persisted"); integrated.push(item.id); return { combinedCoordinatorCommit: "c".repeat(40) }; },
    async finalGate({ combinedCoordinatorCommit }) { return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [] }; },
  };
  try {
    await acceptRun(rootPath, declaration("conflict", [task("first", [], "write"), task("second", [], "write")], 2));
    const state = await (await startRun(rootPath, "feature", "conflict", executor)).completion;
    assert.equal(state.outcome, "blocked"); assert.deepEqual(integrated, ["first"]); assert.equal(state.tasks.second.waitReason, "integration-conflict");
    assert.equal(JSON.stringify(state).includes("not-persisted"), false);
    await poll(rootPath, "conflict", (candidate) => candidate.reflection.status === "complete");
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function restartAndIdempotency(): Promise<void> {
  const rootPath = await root();
  let launches = 0; let integrations = 0;
  const executor: RunExecutor = {
    async delegate(_item, { signal }) { launches++; await delay(80, signal); return { outcome: "review", durationMs: 80 }; },
    async review(_item, { signal }) { await delay(10, signal); return { approved: true }; },
    async integrate() { integrations++; return { combinedCoordinatorCommit: "d".repeat(40) }; },
    async finalGate({ combinedCoordinatorCommit }) { return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [] }; },
  };
  try {
    await acceptRun(rootPath, declaration("restart", [task("write", [], "write")], 1));
    await startRun(rootPath, "feature", "restart", executor);
    await poll(rootPath, "restart", (state) => state.tasks.write.state === "running");
    await suspendRuns(rootPath);
    let state = await getRun(rootPath, "feature", "restart");
    assert.equal(state.tasks.write.state, "queued");
    const resumed = await startRun(rootPath, "feature", "restart", executor);
    await resumed.completion;
    state = await poll(rootPath, "restart", (candidate) => candidate.reflection.status === "complete");
    await startRun(rootPath, "feature", "restart", executor);
    await runReflection(rootPath, "feature", "restart");
    assert.equal((await getRun(rootPath, "feature", "restart")).reflection.path, state.reflection.path);
    assert.equal(integrations, 1, "integration is not duplicated by resume/status/reflection requests");
    assert.equal(launches, 2, "only interrupted nonterminal work relaunches");
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function legacyWritingRunMigrationResume(): Promise<void> {
  const rootPath = await root();
  try {
    const run = declaration("legacy-resume", [task("write", [], "write")], 1);
    const accepted = await acceptRun(rootPath, run);
    const legacy: any = structuredClone(accepted);
    delete legacy.checkpoints; delete legacy.integrationOrder; delete legacy.finalGate; delete legacy.integrated;
    for (const runtime of Object.values(legacy.tasks) as any[]) { delete runtime.stageAttempt; delete runtime.retryCount; delete runtime.durationMs; delete runtime.cost; delete runtime.corrections; }
    await atomicJson(join(featureDir(rootPath, "feature"), "runs", "legacy-resume", "state.json"), legacy);
    const commit = "e".repeat(40);
    const executor: RunExecutor = {
      async delegate() { return { outcome: "review" }; }, async review() { return { approved: true }; },
      async integrate() { return { combinedCoordinatorCommit: commit }; },
      async finalGate({ combinedCoordinatorCommit }) { return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [] }; },
    };
    const resumed = await (await startRun(rootPath, "feature", "legacy-resume", executor)).completion;
    assert.equal(resumed.outcome, "success"); assert.deepEqual(resumed.integrationOrder, ["write"]);
    assert.deepEqual(resumed.checkpoints.write.members, ["write"]); assert.equal(resumed.checkpoints.write.finalTaskId, "write");
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function writingNoCommitCannotComplete(): Promise<void> {
  const rootPath = await root(); let finalCalls = 0;
  try {
    await acceptRun(rootPath, declaration("no-commit", [task("write", [], "write")], 1));
    const executor: RunExecutor = {
      async delegate() { return { outcome: "completed" }; }, async review() { throw new Error("review must not run"); }, async integrate() { throw new Error("integration must not run"); },
      async finalGate({ combinedCoordinatorCommit }) { finalCalls++; return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [] }; },
    };
    const state = await (await startRun(rootPath, "feature", "no-commit", executor)).completion;
    assert.equal(state.outcome, "blocked"); assert.equal(state.tasks.write.waitReason, "missing-implementation-commit"); assert.equal(finalCalls, 0); assert.notEqual(state.finalGate.status, "passed");
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function finalGateExactBindingAndCancellation(): Promise<void> {
  const rootPath = await root();
  const commit = "e".repeat(40); let finalEffects = 0;
  const executor: RunExecutor = {
    async delegate() { return { outcome: "review" }; }, async review() { return { approved: true }; },
    async integrate() { return { combinedCoordinatorCommit: commit }; },
    async finalGate(context) { finalEffects++; return { combinedCoordinatorCommit: context.combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [], reportPath: "reports/final.json" }; },
  };
  try {
    await acceptRun(rootPath, declaration("final-pass", [task("write", [], "write")], 1));
    const passed = await (await startRun(rootPath, "feature", "final-pass", executor)).completion;
    assert.equal(passed.finalGate.status, "passed"); assert.equal(passed.combinedCoordinatorCommit, commit);
    assert.equal(passed.finalGate.reportPath, "reports/final.json"); assert.equal(finalEffects, 1);
    await startRun(rootPath, "feature", "final-pass", executor);
    assert.equal(finalEffects, 1, "a passed final gate is not duplicated on resume");

    await acceptRun(rootPath, declaration("final-stale", [task("write", [], "write")], 1));
    const stale = await (await startRun(rootPath, "feature", "final-stale", { ...executor, async finalGate() { return { combinedCoordinatorCommit: "f".repeat(40), passed: true, evidenceComplete: true, findings: [] }; } })).completion;
    assert.equal(stale.outcome, "blocked"); assert.equal(stale.finalGate.status, "blocked"); assert.match(stale.finalGate.reason ?? "", /stale|mismatched/);

    for (const [id, finalGate, reason] of [
      ["final-missing", async () => ({ combinedCoordinatorCommit: commit, passed: true, evidenceComplete: false, findings: [] }), /missing|incomplete/],
      ["final-severe", async () => ({ combinedCoordinatorCommit: commit, passed: true, evidenceComplete: true, findings: [{ severity: "high" as const, status: "open" as const }] }), /critical|high/],
      ["final-infrastructure", async () => { throw new Error("runner unavailable"); }, /executor|infrastructure/],
    ] as const) {
      await acceptRun(rootPath, declaration(id, [task("write", [], "write")], 1));
      const blocked = await (await startRun(rootPath, "feature", id, { ...executor, finalGate })).completion;
      assert.equal(blocked.outcome, "blocked"); assert.match(blocked.finalGate.reason ?? "", reason);
    }
    await startRun(rootPath, "feature", "final-infrastructure", executor);
    await retryRunFinalGate(rootPath, "feature", "final-infrastructure");
    const recovered = await poll(rootPath, "final-infrastructure", (state) => state.state === "terminal" && state.outcome === "success");
    assert.equal(recovered.finalGate.status, "passed", "an explicit rerun recovers without reintegration");

    let started = false;
    await acceptRun(rootPath, declaration("final-cancel", [task("write", [], "write")], 1));
    await startRun(rootPath, "feature", "final-cancel", { ...executor, async finalGate({ signal, combinedCoordinatorCommit }) { started = true; await delay(100, signal); return { combinedCoordinatorCommit, passed: true, evidenceComplete: true, findings: [] }; } });
    await poll(rootPath, "final-cancel", (state) => state.finalGate.status === "running");
    await cancelRun(rootPath, "feature", "final-cancel");
    const cancelled = await poll(rootPath, "final-cancel", (state) => state.state === "terminal");
    assert.equal(started, true); assert.equal(cancelled.outcome, "cancelled"); assert.notEqual(cancelled.finalGate.status, "passed");
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function reflectionSecurityFailureAndProposals(): Promise<void> {
  const evidence: ReflectionEvidence = {
    schemaVersion: 1, runId: "safe", outcome: "success", elapsedMs: 100, cap: 2, maxActiveCount: 1,
    tasks: [{ id: "task", state: "completed", durationMs: 90, cost: 1, retryCount: 1, corrections: 1 }],
    transitionCounts: { "task-transition": 2 }, integrationOrder: [],
  };
  const report = buildReflection("feature", evidence);
  assert.equal(report.conclusions.length, 6);
  for (const conclusion of report.conclusions) {
    assert.ok(conclusion.evidence);
    assert.ok(conclusion.confidence);
    assert.ok(conclusion.recommendation);
  }
  assert.equal(JSON.stringify(report).includes("authorization=Bearer secret-value"), false);
  const malicious = buildReflection("secret=feature-value", { ...evidence, runId: "token=raw-secret", tasks: [{ ...evidence.tasks[0], id: "api_key=do-not-emit" }] });
  assert.equal(JSON.stringify(malicious).includes("do-not-emit"), false);
  assert.equal(JSON.stringify(malicious).includes("raw-secret"), false);
  assert.equal(JSON.stringify(malicious).includes("feature-value"), false);

  const rootPath = await root();
  const executor: RunExecutor = {
    async delegate() { return { outcome: "completed", durationMs: 10 }; },
    async review() { return { approved: true }; }, async integrate() {},
  };
  try {
    await acceptRun(rootPath, declaration("insufficient", [task("never-started")]));
    const insufficient = await getRun(rootPath, "feature", "insufficient");
    insufficient.state = "terminal"; insufficient.outcome = "cancelled"; insufficient.terminalAt = new Date().toISOString();
    insufficient.tasks["never-started"].state = "cancelled"; insufficient.reflection = { status: "pending", attempt: 1 };
    await atomicJson(join(featureDir(rootPath, "feature"), "runs", "insufficient", "state.json"), insufficient);
    const skipped = await runReflection(rootPath, "feature", "insufficient");
    assert.equal(skipped.reflection.status, "skipped"); assert.equal(skipped.reflection.reason, "insufficient-evidence");

    for (const id of ["reflect-a", "reflect-b"]) {
      const secret = "api_key=do-not-emit";
      await acceptRun(rootPath, declaration(id, [{ ...task("task"), prompt: secret }]));
      await (await startRun(rootPath, "feature", id, executor)).completion;
      await poll(rootPath, id, (state) => state.reflection.status === "complete");
      const output = await readFile(join(featureDir(rootPath, "feature"), "runs", id, "reflection.json"), "utf8");
      assert.equal(output.includes(secret), false, "reflection does not consume graph prompt prose");
    }
    const prior = await getRun(rootPath, "feature", "reflect-a");
    await runReflection(rootPath, "feature", "reflect-a", true, () => { throw new Error("password=never-persist"); });
    let state = await getRun(rootPath, "feature", "reflect-a");
    assert.equal(state.outcome, prior.outcome);
    assert.equal(state.reflection.status, "failed");
    assert.equal(JSON.stringify(state).includes("never-persist"), false);
    await runReflection(rootPath, "feature", "reflect-a", true);
    state = await getRun(rootPath, "feature", "reflect-a");
    assert.equal(state.reflection.status, "complete");

    const proposals = await listProposals(rootPath);
    assert.ok(proposals.length > 0, "recurring findings create a proposal");
    const proposal = proposals[0];
    await assert.rejects(applyProposal(rootPath, proposal.id, "operator"), /approval/);
    await approveProposal(rootPath, proposal.id, "operator");
    const applied = await applyProposal(rootPath, proposal.id, "operator");
    assert.equal(applied.state, "applied");
    assert.deepEqual(applied.audit.map((item) => item.action), ["approved", "applied"]);
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

async function speedTarget(): Promise<void> {
  const duration = 100;
  const serialStarted = Date.now(); await delay(duration); await delay(duration); const serial = Date.now() - serialStarted;
  const rootPath = await root();
  const executor: RunExecutor = {
    async delegate(_item, { signal }) { await delay(duration, signal); return { outcome: "completed", durationMs: duration }; },
    async review() { return { approved: true }; }, async integrate() {},
  };
  try {
    await acceptRun(rootPath, declaration("speed", [task("a"), task("b")], 2));
    const concurrentStarted = Date.now(); await (await startRun(rootPath, "feature", "speed", executor)).completion; const concurrent = Date.now() - concurrentStarted;
    assert.ok(concurrent <= serial * 0.70, `concurrent ${concurrent}ms must be <= 70% of serial ${serial}ms`);
  } finally { await suspendRuns(rootPath); await rm(rootPath, { recursive: true, force: true }); }
}

await graphValidationAndAtomicity();
await realisticGitSmoke();
await concurrencyCapReviewAndIntegration();
await checkpointLifecycle();
await sealedReviewOverridePersists();
await failedCheckpointTurnBlocksImplicitFollowers();
await repositoryDefaultCap();
await failureIsolationRetryAndCancellation();
await conflictRemainsBlocked();
await restartAndIdempotency();
await legacyWritingRunMigrationResume();
await writingNoCommitCannotComplete();
await finalGateExactBindingAndCancellation();
await reflectionSecurityFailureAndProposals();
await speedTarget();
console.log("run orchestration/reflection tests passed");

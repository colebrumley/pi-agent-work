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
  runReflection,
  startRun,
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
  return { schemaVersion: 1, id, featureId: "feature", concurrency, tasks };
}
function task(id: string, dependsOn: string[] = [], mode: "read" | "write" = "read") {
  return { id, title: id, prompt: `perform ${id}`, mode, profile: mode === "write" ? "worker" : "scout", dependsOn };
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
      async integrate(item) { await git(["cherry-pick", commits.get(item.id)!]); integrated.push(item.id); },
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
    async integrate(item) { integrated.push(item.id); await delay(2); },
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
    async integrate(item) { if (item.id === "second") throw new Error("fixture conflict with secret=not-persisted"); integrated.push(item.id); },
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
    async integrate() { integrations++; },
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
await repositoryDefaultCap();
await failureIsolationRetryAndCancellation();
await conflictRemainsBlocked();
await restartAndIdempotency();
await reflectionSecurityFailureAndProposals();
await speedTarget();
console.log("run orchestration/reflection tests passed");

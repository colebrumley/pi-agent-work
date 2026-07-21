import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicJson, exists, readJson, rootDir } from "./storage.ts";
import { diagnoseGitAnomalies, planGitRepair, reconcileCbpiLifecycle, registerCbpiWorktree } from "./lifecycle.ts";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd })).stdout.trim(); }
async function branchFixture(root: string, id: string, dirty = false): Promise<{ path: string; branch: string; commit: string }> {
  const path = join(rootDir(root), "worktrees", id); const branch = `cbpi-${id}`;
  await git(root, ["worktree", "add", "-b", branch, path]); await writeFile(join(path, `${id}.txt`), id);
  await git(path, ["add", "."]); await git(path, ["commit", "-m", id]); const commit = await git(path, ["rev-parse", "HEAD"]);
  if (dirty) await writeFile(join(path, "dirty.txt"), "dirty");
  return { path, branch, commit };
}

async function lifecycle(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-lifecycle-test-"));
  try {
    await git(root, ["init"]); await git(root, ["config", "user.email", "fixture@example.invalid"]); await git(root, ["config", "user.name", "Fixture"]);
    await writeFile(join(root, "base.txt"), "base"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
    const clean = await branchFixture(root, "clean"); const dirty = await branchFixture(root, "dirty", true); const unintegrated = await branchFixture(root, "unintegrated");
    await git(root, ["merge", "--no-ff", clean.branch, "-m", "integrate clean"]); await git(root, ["merge", "--no-ff", dirty.branch, "-m", "integrate dirty"]); const integrationCommit = await git(root, ["rev-parse", "HEAD"]); await writeFile(join(dirty.path, "uncollected.txt"), "dirty");
    for (const [id, item, collected] of [["clean", clean, true], ["dirty", dirty, true], ["unintegrated", unintegrated, true]] as const) {
      await atomicJson(join(rootDir(root), "features", "feature", "tasks", id, "status.json"), { schemaVersion: 1, featureId: "feature", taskId: id, state: "done", currentAttempt: 1, commit: item.commit, updatedAt: "2026-01-01T00:00:00.000Z" });
      await registerCbpiWorktree(root, { id, featureId: "feature", taskId: id, branch: item.branch, commit: item.commit, worktree: item.path, collected });
    }
    const cleanStatusPath = join(rootDir(root), "features", "feature", "tasks", "clean", "status.json");
    const cleanStatusBefore = await readFile(cleanStatusPath, "utf8");
    const dryRun = await reconcileCbpiLifecycle(root, { integrationCommit, dryRun: true });
    assert.deepEqual(dryRun.map((item) => [item.id, item.action]), [["clean", "cleaned"], ["dirty", "blocked"], ["unintegrated", "blocked"]]);
    assert.equal(await readFile(cleanStatusPath, "utf8"), cleanStatusBefore, "dry run does not update durable task state");
    assert.equal(await exists(clean.path), true, "dry run does not remove the worktree");
    const outcomes = await reconcileCbpiLifecycle(root, { integrationCommit });
    assert.deepEqual(outcomes.map((item) => [item.id, item.action]), [["clean", "cleaned"], ["dirty", "blocked"], ["unintegrated", "blocked"]]);
    assert.equal(await exists(clean.path), false); assert.equal(await exists(dirty.path), true); assert.equal(await exists(unintegrated.path), true);
    assert.equal((await readJson<{ state: string }>(cleanStatusPath)).state, "integrated");
    assert.equal((await reconcileCbpiLifecycle(root, { integrationCommit })).length, 2, "repeat reconciliation leaves blocked resources untouched");
    await writeFile(join(root, ".git", "refs", "heads", "conflict-copy"), "not-a-ref\n");
    const anomalies = await diagnoseGitAnomalies(root); assert.ok(anomalies.some((item) => item.code === "malformed-ref")); assert.ok(anomalies.some((item) => item.code === "conflict-copy"));
    const repair = await planGitRepair(root); assert.equal(repair.dryRun, true); await assert.rejects(planGitRepair(root, true), /never repairs foreign/);
  } finally { await rm(root, { recursive: true, force: true }); }
}

await lifecycle();
console.log("lifecycle/Git diagnostic tests passed");

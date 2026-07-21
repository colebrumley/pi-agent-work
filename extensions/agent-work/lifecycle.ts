import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicJson, exists, readJson, rootDir, safeId, writeStatus } from "./storage.ts";
import type { TaskStatus } from "./types.ts";

const execFileAsync = promisify(execFile);
export interface WorktreeOwnership { schemaVersion: 1; kind: "cbpi-worktree"; id: string; featureId: string; taskId: string; branch: string; commit: string; worktree: string; collected: boolean; coordinatorCommit?: string; collectionProof?: "stable-patch-id"; createdAt: string }
export interface LifecycleOutcome { id: string; action: "cleaned" | "integrated" | "blocked" | "stale"; reason: string }
export interface GitAnomaly { code: "malformed-ref" | "conflict-copy" | "stale-foreign-worktree"; path: string; repairCommand: string }

function ownershipDir(project: string): string { return join(rootDir(project), "ownership", "worktrees"); }
function ownershipPath(project: string, id: string): string { return join(ownershipDir(project), `${safeId(id, "ownership id")}.json`); }
function inside(base: string, value: string): string { const b = resolve(base); const v = resolve(value); if (v !== b && !v.startsWith(`${b}/`)) throw new Error("Path escapes project ownership boundary"); return v; }
async function git(project: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd: project })).stdout.trim(); }
async function gitOk(project: string, args: string[]): Promise<boolean> { try { await git(project, args); return true; } catch { return false; } }
function worktreeAllowed(project: string, worktree: string): boolean {
  const value = resolve(worktree);
  return value.startsWith(`${resolve(rootDir(project), "worktrees")}/`) || value.startsWith(`${resolve(rootDir(project), "features")}/`);
}
function validOwnedBranch(branch: unknown): branch is string { return typeof branch === "string" && (/^cbpi-[a-z0-9][a-z0-9._-]{0,74}$/.test(branch) || /^agent-work\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/a\d+$/.test(branch)); }
function validCommit(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value); }
function validOwnership(project: string, record: Partial<WorktreeOwnership>): record is WorktreeOwnership {
  return record.schemaVersion === 1 && record.kind === "cbpi-worktree" && typeof record.id === "string" && safeId(record.id) === record.id && typeof record.featureId === "string" && safeId(record.featureId) === record.featureId && typeof record.taskId === "string" && safeId(record.taskId) === record.taskId && validOwnedBranch(record.branch) && validCommit(record.commit) && typeof record.worktree === "string" && worktreeAllowed(project, join(project, record.worktree)) && typeof record.collected === "boolean" && (record.coordinatorCommit === undefined || validCommit(record.coordinatorCommit)) && (record.collectionProof === undefined || record.collectionProof === "stable-patch-id");
}

export async function registerCbpiWorktree(project: string, input: Omit<WorktreeOwnership, "schemaVersion" | "kind" | "createdAt"> & { createdAt?: string }): Promise<WorktreeOwnership> {
  if (!worktreeAllowed(project, input.worktree)) throw new Error("Cbpi worktrees must be inside .agent-work");
  if (!validOwnedBranch(input.branch)) throw new Error("Cbpi-owned branches must use the cbpi- prefix");
  if (!(await gitOk(project, ["-C", input.worktree, "rev-parse", "--is-inside-work-tree"]))) throw new Error("Owned worktree is not a Git worktree");
  const branch = await git(project, ["-C", input.worktree, "branch", "--show-current"]); const commit = await git(project, ["-C", input.worktree, "rev-parse", "HEAD"]);
  if (branch !== input.branch || commit !== input.commit) throw new Error("Ownership registration must bind the exact branch and commit");
  const record: WorktreeOwnership = { schemaVersion: 1, kind: "cbpi-worktree", ...input, id: safeId(input.id, "ownership id"), featureId: safeId(input.featureId, "feature id"), taskId: safeId(input.taskId, "task id"), worktree: relative(project, inside(project, input.worktree)), createdAt: input.createdAt ?? new Date().toISOString() };
  await atomicJson(ownershipPath(project, record.id), record); return record;
}

async function ownershipRecords(project: string): Promise<WorktreeOwnership[]> {
  const directory = ownershipDir(project); if (!(await exists(directory))) return [];
  const records: WorktreeOwnership[] = [];
  for (const entry of await readdir(directory)) if (entry.endsWith(".json")) try { const record = await readJson<WorktreeOwnership>(join(directory, entry)); if (validOwnership(project, record)) records.push(record); } catch { /* forged records fail closed by omission */ }
  return records;
}

export async function reconcileCbpiLifecycle(project: string, input: { dryRun?: boolean } = {}): Promise<LifecycleOutcome[]> {
  // The coordinator's actual HEAD, not the source worktree commit, is the authority.
  const coordinatorHead = await git(project, ["rev-parse", "HEAD"]);
  const outcomes: LifecycleOutcome[] = [];
  for (const record of await ownershipRecords(project)) {
    const worktree = inside(rootDir(project), join(project, record.worktree));
    if (!record.collected) { outcomes.push({ id: record.id, action: "blocked", reason: "owned work has not been collected" }); continue; }
    if (!record.coordinatorCommit || record.collectionProof !== "stable-patch-id") { outcomes.push({ id: record.id, action: "blocked", reason: "owned work lacks a coordinator collection audit" }); continue; }
    const coordinatorReachable = await gitOk(project, ["merge-base", "--is-ancestor", record.coordinatorCommit, coordinatorHead]);
    const collectedPatch = await gitPatchEquivalent(project, record.coordinatorCommit, record.commit);
    if (!coordinatorReachable || !collectedPatch) { outcomes.push({ id: record.id, action: "blocked", reason: "owned commit is not proven equivalent to its collected coordinator commit" }); continue; }
    const present = await exists(worktree);
    if (present && (await git(project, ["-C", worktree, "status", "--porcelain"]))) { outcomes.push({ id: record.id, action: "blocked", reason: "owned worktree has uncommitted changes" }); continue; }
    const statusPath = join(rootDir(project), "features", record.featureId, "tasks", record.taskId, "status.json");
    if (!(await exists(statusPath))) { outcomes.push({ id: record.id, action: "blocked", reason: "task status is missing" }); continue; }
    const status = await readJson<TaskStatus>(statusPath); if (status.commit !== record.commit) { outcomes.push({ id: record.id, action: "blocked", reason: "task status does not bind owned commit" }); continue; }
    if (input.dryRun) { outcomes.push({ id: record.id, action: present ? "cleaned" : "stale", reason: present ? "would remove clean collected owned worktree and branch" : "would reconcile already removed worktree" }); continue; }
    if (status.state !== "integrated") { status.state = "integrated"; await writeStatus(project, status); }
    if (present) await git(project, ["worktree", "remove", worktree]);
    // A cherry-picked source branch is not an ancestor, but its owned patch was verified above.
    if (await gitOk(project, ["show-ref", "--verify", "--quiet", `refs/heads/${record.branch}`])) await git(project, ["branch", "-D", record.branch]);
    await rm(ownershipPath(project, record.id)); outcomes.push({ id: record.id, action: present ? "cleaned" : "stale", reason: present ? "removed clean collected owned worktree and branch" : "reconciled already removed worktree" });
  }
  return outcomes;
}

async function stablePatchId(project: string, commit: string): Promise<string | undefined> {
  try {
    const patch = await git(project, ["diff-tree", "--no-commit-id", "--patch", commit]);
    return await new Promise<string | undefined>((resolvePatch, reject) => {
      const child = spawn("git", ["patch-id", "--stable"], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let error = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { error += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolvePatch(output.trim().split(/\s+/)[0] || undefined) : reject(new Error(error)));
      child.stdin.end(patch);
    });
  } catch { return undefined; }
}

async function gitPatchEquivalent(project: string, coordinatorCommit: string, sourceCommit: string): Promise<boolean> {
  const [coordinatorPatch, sourcePatch] = await Promise.all([stablePatchId(project, coordinatorCommit), stablePatchId(project, sourceCommit)]);
  return Boolean(sourcePatch && coordinatorPatch && sourcePatch === coordinatorPatch);
}

/** Collection binds the reviewed source patch to the exact coordinator commit created by integration. */
export async function markCbpiWorktreeCollected(project: string, id: string, input: { sourceCommit: string; coordinatorCommit: string }): Promise<WorktreeOwnership> {
  const path = ownershipPath(project, id);
  const record = await readJson<WorktreeOwnership>(path);
  if (!validOwnership(project, record)) throw new Error("Invalid cbpi worktree ownership record");
  if (record.commit !== input.sourceCommit || !validCommit(input.coordinatorCommit)) throw new Error("Collection audit must bind the registered source commit and a coordinator commit");
  if (!(await gitPatchEquivalent(project, input.coordinatorCommit, input.sourceCommit))) throw new Error("Source commit is not patch-equivalent to the coordinator integration commit");
  if (!record.collected || !record.coordinatorCommit || record.collectionProof !== "stable-patch-id") {
    record.collected = true;
    record.coordinatorCommit = input.coordinatorCommit;
    record.collectionProof = "stable-patch-id";
    await atomicJson(path, record);
  }
  return record;
}

export async function diagnoseGitAnomalies(project: string, limit = 50): Promise<GitAnomaly[]> {
  const anomalies: GitAnomaly[] = []; const common = resolve(project, await git(project, ["rev-parse", "--git-common-dir"]));
  const refs = join(common, "refs");
  const inspect = async (directory: string): Promise<void> => { if (!(await exists(directory)) || anomalies.length >= limit) return; for (const entry of await readdir(directory, { withFileTypes: true })) { if (anomalies.length >= limit) return; const path = join(directory, entry.name); if (entry.isDirectory()) await inspect(path); else if (entry.isFile()) { const content = await readFile(path, "utf8"); if (!/^[0-9a-f]{40,64}\n?$/.test(content)) anomalies.push({ code: "malformed-ref", path: relative(project, path), repairCommand: "Inspect and repair this foreign ref manually; cbpi will not modify it." }); if (/conflict|copy/i.test(entry.name)) anomalies.push({ code: "conflict-copy", path: relative(project, path), repairCommand: "Inspect and remove or rename this foreign conflict-copy file manually." }); } } };
  await inspect(refs);
  const listed = await git(project, ["worktree", "list", "--porcelain"]); for (const block of listed.split("\n\n")) { const path = block.match(/^worktree (.+)$/m)?.[1]; if (path && !worktreeAllowed(project, path) && !(await exists(path)) && anomalies.length < limit) anomalies.push({ code: "stale-foreign-worktree", path, repairCommand: "git worktree prune --dry-run" }); }
  return anomalies;
}

export async function planGitRepair(project: string, confirm = false): Promise<{ dryRun: true; token: string; anomalies: GitAnomaly[] }> {
  const anomalies = await diagnoseGitAnomalies(project); const token = createHash("sha256").update(JSON.stringify(anomalies)).digest("hex").slice(0, 24);
  if (confirm && anomalies.length) throw new Error("Cbpi never repairs foreign Git metadata automatically");
  return { dryRun: true, token, anomalies };
}

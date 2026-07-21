import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicJson, exists, readJson, rootDir, safeId, writeStatus } from "./storage.ts";
import type { TaskStatus } from "./types.ts";

const execFileAsync = promisify(execFile);
export interface WorktreeOwnership { schemaVersion: 1; kind: "cbpi-worktree"; id: string; featureId: string; taskId: string; branch: string; commit: string; worktree: string; collected: boolean; createdAt: string }
export interface LifecycleOutcome { id: string; action: "cleaned" | "integrated" | "blocked" | "stale"; reason: string }
export interface GitAnomaly { code: "malformed-ref" | "conflict-copy" | "stale-foreign-worktree"; path: string; repairCommand: string }

function ownershipDir(project: string): string { return join(rootDir(project), "ownership", "worktrees"); }
function ownershipPath(project: string, id: string): string { return join(ownershipDir(project), `${safeId(id, "ownership id")}.json`); }
function inside(base: string, value: string): string { const b = resolve(base); const v = resolve(value); if (v !== b && !v.startsWith(`${b}/`)) throw new Error("Path escapes project ownership boundary"); return v; }
async function git(project: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd: project })).stdout.trim(); }
async function gitOk(project: string, args: string[]): Promise<boolean> { try { await git(project, args); return true; } catch { return false; } }
function worktreeAllowed(project: string, worktree: string): boolean { return resolve(worktree).startsWith(`${resolve(rootDir(project), "worktrees")}/`); }
function validOwnedBranch(branch: unknown): branch is string { return typeof branch === "string" && /^cbpi-[a-z0-9][a-z0-9._-]{0,74}$/.test(branch); }
function validOwnership(project: string, record: Partial<WorktreeOwnership>): record is WorktreeOwnership {
  return record.schemaVersion === 1 && record.kind === "cbpi-worktree" && typeof record.id === "string" && safeId(record.id) === record.id && typeof record.featureId === "string" && safeId(record.featureId) === record.featureId && typeof record.taskId === "string" && safeId(record.taskId) === record.taskId && validOwnedBranch(record.branch) && typeof record.commit === "string" && /^[0-9a-f]{40,64}$/.test(record.commit) && typeof record.worktree === "string" && worktreeAllowed(project, join(project, record.worktree)) && typeof record.collected === "boolean";
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

export async function reconcileCbpiLifecycle(project: string, input: { integrationCommit: string; dryRun?: boolean }): Promise<LifecycleOutcome[]> {
  const outcomes: LifecycleOutcome[] = [];
  for (const record of await ownershipRecords(project)) {
    const worktree = inside(rootDir(project), join(project, record.worktree));
    const reachable = await gitOk(project, ["merge-base", "--is-ancestor", record.commit, input.integrationCommit]);
    if (!reachable) { outcomes.push({ id: record.id, action: "blocked", reason: "owned commit is not reachable from integration commit" }); continue; }
    if (!record.collected) { outcomes.push({ id: record.id, action: "blocked", reason: "owned work has not been collected" }); continue; }
    const present = await exists(worktree);
    if (present && (await git(project, ["-C", worktree, "status", "--porcelain"]))) { outcomes.push({ id: record.id, action: "blocked", reason: "owned worktree has uncommitted changes" }); continue; }
    const statusPath = join(rootDir(project), "features", record.featureId, "tasks", record.taskId, "status.json");
    if (!(await exists(statusPath))) { outcomes.push({ id: record.id, action: "blocked", reason: "task status is missing" }); continue; }
    const status = await readJson<TaskStatus>(statusPath); if (status.commit !== record.commit) { outcomes.push({ id: record.id, action: "blocked", reason: "task status does not bind owned commit" }); continue; }
    if (input.dryRun) { outcomes.push({ id: record.id, action: present ? "cleaned" : "stale", reason: present ? "would remove clean reachable owned worktree and branch" : "would reconcile already removed worktree" }); continue; }
    if (status.state !== "integrated") { status.state = "integrated"; await writeStatus(project, status); }
    if (present) await git(project, ["worktree", "remove", worktree]);
    if (await gitOk(project, ["show-ref", "--verify", "--quiet", `refs/heads/${record.branch}`])) await git(project, ["branch", "-d", record.branch]);
    await rm(ownershipPath(project, record.id)); outcomes.push({ id: record.id, action: present ? "cleaned" : "stale", reason: present ? "removed clean reachable owned worktree and branch" : "reconciled already removed worktree" });
  }
  return outcomes;
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

import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { appendJsonl, atomicJson, attemptDir, exists, readJson, safeId } from "./storage.ts";

const gzipAsync = promisify(gzip);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_SCHEMA = 1;
const BOUNDED_FILES = ["status.json", "invocation.json", "handoff.json", "evidence.json", "artifacts.json", "artifacts/index.json"];

export interface RetentionPolicy { failureRetentionDays: number; compaction: boolean }
export interface RetentionPolicyOverrides { failureRetentionDays?: number; compaction?: boolean }
export interface AttemptAddress { featureId: string; taskId: string; attempt: number }
export interface AttemptOwnership extends AttemptAddress { schemaVersion: 1; kind: "cbpi-attempt"; createdAt: string }
export interface IntegrityManifest { schemaVersion: 1; files: Array<{ path: string; sha256: string; bytes: number }> }
export interface CompactionRecord { schemaVersion: 1; kind: "successful-compaction"; at: string; beforeRawBytes: number; afterRawBytes: number; reclaimedRawBytes: number; gzipFiles: string[]; removedQueryFiles: string[]; integrityHash: string }
export interface PruneRecord { schemaVersion: 1; kind: "failed-diagnostics-prune"; at: string; dryRunToken: string; removedFiles: string[]; reclaimedBytes: number }

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { failureRetentionDays: 30, compaction: true };

export function resolveRetentionPolicy(repository: RetentionPolicyOverrides = {}, invocation: RetentionPolicyOverrides = {}): RetentionPolicy {
  const policy = { ...DEFAULT_RETENTION_POLICY, ...repository, ...invocation };
  if (!Number.isInteger(policy.failureRetentionDays) || policy.failureRetentionDays < 0 || policy.failureRetentionDays > 3650) throw new Error("failureRetentionDays must be an integer between 0 and 3650");
  if (typeof policy.compaction !== "boolean") throw new Error("compaction must be a boolean");
  return policy;
}

function dir(root: string, address: AttemptAddress): string { return attemptDir(root, address.featureId, address.taskId, address.attempt); }
function pathInside(base: string, candidate: string): string {
  const resolvedBase = resolve(base); const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(`${resolvedBase}/`)) throw new Error("Path escapes cbpi attempt boundary");
  return resolvedCandidate;
}
function sha256(data: Buffer | string): string { return createHash("sha256").update(data).digest("hex"); }
async function filesRecursive(base: string): Promise<string[]> {
  if (!(await exists(base))) return [];
  const entries = await readdir(base, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const current = pathInside(base, join(base, entry.name));
    if (entry.isDirectory()) result.push(...await filesRecursive(current));
    else if (entry.isFile()) result.push(current);
  }
  return result;
}
async function rawFiles(base: string): Promise<string[]> {
  const paths = [join(base, "events.jsonl"), ...await filesRecursive(join(base, "queries"))];
  return Promise.all(paths.map(async (path) => (await exists(path)) ? path : undefined)).then((items) => items.filter((item): item is string => Boolean(item)));
}
async function byteCount(paths: string[]): Promise<number> { return (await Promise.all(paths.map(async (path) => (await stat(path)).size))).reduce((sum, value) => sum + value, 0); }
function auditPath(base: string): string { return join(base, "retention-audit.jsonl"); }
function ownershipPath(base: string): string { return join(base, "ownership.json"); }
function integrityPath(base: string): string { return join(base, "integrity.json"); }

export async function markAttemptOwned(root: string, address: AttemptAddress, createdAt = new Date().toISOString()): Promise<AttemptOwnership> {
  const base = dir(root, address); await pathInside(resolve(root, ".agent-work"), base);
  const ownership: AttemptOwnership = { schemaVersion: 1, kind: "cbpi-attempt", featureId: safeId(address.featureId), taskId: safeId(address.taskId), attempt: address.attempt, createdAt };
  await atomicJson(ownershipPath(base), ownership); return ownership;
}

export async function writeIntegrityManifest(root: string, address: AttemptAddress): Promise<IntegrityManifest> {
  const base = dir(root, address); const files = [] as IntegrityManifest["files"];
  for (const name of BOUNDED_FILES) {
    const path = join(base, name); if (!(await exists(path))) continue;
    const data = await readFile(path); files.push({ path: name, sha256: sha256(data), bytes: data.length });
  }
  const manifest: IntegrityManifest = { schemaVersion: RETENTION_SCHEMA, files };
  await atomicJson(integrityPath(base), manifest); return manifest;
}

export async function verifyAttemptIntegrity(root: string, address: AttemptAddress): Promise<IntegrityManifest> {
  const base = dir(root, address); const ownership = await readJson<AttemptOwnership>(ownershipPath(base));
  if (ownership.schemaVersion !== 1 || ownership.kind !== "cbpi-attempt" || ownership.featureId !== safeId(address.featureId) || ownership.taskId !== safeId(address.taskId) || ownership.attempt !== address.attempt) throw new Error("Forged or mismatched cbpi attempt ownership");
  const manifest = await readJson<IntegrityManifest>(integrityPath(base));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("Invalid attempt integrity manifest");
  for (const item of manifest.files) {
    if (!item || typeof item.path !== "string" || !BOUNDED_FILES.includes(item.path) || typeof item.sha256 !== "string") throw new Error("Invalid integrity entry");
    const data = await readFile(pathInside(base, join(base, item.path)));
    if (data.length !== item.bytes || sha256(data) !== item.sha256) throw new Error(`Integrity check failed for ${item.path}`);
  }
  return manifest;
}

async function priorAudit<T extends { kind: string }>(base: string, kind: T["kind"]): Promise<T | undefined> {
  if (!(await exists(auditPath(base)))) return undefined;
  const lines = (await readFile(auditPath(base), "utf8")).split(/\r?\n/).filter(Boolean);
  for (const line of lines.reverse()) try { const value = JSON.parse(line); if (value?.kind === kind) return value as T; } catch { /* corrupt audit cannot authorize a repeat */ }
  return undefined;
}

export async function compactSuccessfulAttempt(root: string, address: AttemptAddress, options: { integrated: boolean; policy?: RetentionPolicyOverrides; now?: string } ): Promise<CompactionRecord> {
  const policy = resolveRetentionPolicy({}, options.policy);
  if (!options.integrated) throw new Error("Successful compaction requires confirmed integration");
  if (!policy.compaction) throw new Error("Successful compaction is disabled by policy");
  const base = dir(root, address); const previous = await priorAudit<CompactionRecord>(base, "successful-compaction"); if (previous) return previous;
  const integrity = await verifyAttemptIntegrity(root, address);
  const raw = await rawFiles(base); const beforeRawBytes = await byteCount(raw);
  const hasEventStream = await exists(join(base, "events.jsonl"));
  const gzipFiles: string[] = []; const removedQueryFiles: string[] = [];
  for (const file of raw) {
    const rel = relative(base, file);
    if (rel === "events.jsonl") {
      const compressed = `${file}.gz`; await writeFile(compressed, await gzipAsync(await readFile(file)), { mode: 0o600 });
      await rm(file); gzipFiles.push(`${rel}.gz`);
    } else if (hasEventStream) { await rm(file); removedQueryFiles.push(rel); }
  }
  const afterRawBytes = await byteCount(await rawFiles(base));
  const record: CompactionRecord = { schemaVersion: 1, kind: "successful-compaction", at: options.now ?? new Date().toISOString(), beforeRawBytes, afterRawBytes, reclaimedRawBytes: Math.max(0, beforeRawBytes - afterRawBytes), gzipFiles, removedQueryFiles, integrityHash: sha256(JSON.stringify(integrity)) };
  await appendJsonl(auditPath(base), record); return record;
}

export async function pruneFailedAttemptDiagnostics(root: string, address: AttemptAddress, input: { status: "failed" | "blocked" | "cancelled" | "stalled"; terminalAt: string; now?: string; policy?: RetentionPolicyOverrides; dryRun: boolean; dryRunToken?: string }): Promise<{ eligible: boolean; dryRunToken: string; files: string[]; reclaimedBytes: number; pruned: boolean }> {
  const policy = resolveRetentionPolicy({}, input.policy); const base = dir(root, address); await verifyAttemptIntegrity(root, address);
  const now = Date.parse(input.now ?? new Date().toISOString()); const terminal = Date.parse(input.terminalAt);
  if (!Number.isFinite(now) || !Number.isFinite(terminal)) throw new Error("terminalAt and now must be ISO timestamps");
  const eligible = now - terminal >= policy.failureRetentionDays * DAY_MS;
  const prior = await priorAudit<PruneRecord>(base, "failed-diagnostics-prune");
  if (!input.dryRun && prior) return { eligible, dryRunToken: prior.dryRunToken, files: prior.removedFiles, reclaimedBytes: prior.reclaimedBytes, pruned: true };
  const files = await rawFiles(base); const reclaimedBytes = await byteCount(files);
  const token = sha256(JSON.stringify({ address, status: input.status, terminalAt: input.terminalAt, files: files.map((file) => relative(base, file)), reclaimedBytes })).slice(0, 24);
  if (input.dryRun) return { eligible, dryRunToken: token, files: files.map((file) => relative(base, file)), reclaimedBytes, pruned: false };
  if (!eligible) throw new Error("Failed diagnostics are not yet eligible for pruning");
  if (input.dryRunToken !== token) throw new Error("Destructive prune requires the exact current dry-run token");
  if (!prior) { for (const file of files) await rm(file); await appendJsonl(auditPath(base), { schemaVersion: 1, kind: "failed-diagnostics-prune", at: input.now ?? new Date().toISOString(), dryRunToken: token, removedFiles: files.map((file) => relative(base, file)), reclaimedBytes } satisfies PruneRecord); }
  return { eligible, dryRunToken: token, files: files.map((file) => relative(base, file)), reclaimedBytes, pruned: true };
}

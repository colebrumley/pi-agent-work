import assert from "node:assert/strict";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptDir, atomicJson, exists } from "./storage.ts";
import { compactSuccessfulAttempt, markAttemptOwned, pruneFailedAttemptDiagnostics, resolveRetentionPolicy, verifyAttemptIntegrity, writeIntegrityManifest } from "./retention.ts";

const gunzipAsync = promisify(gunzip);
const address = { featureId: "feature", taskId: "task", attempt: 1 };

async function fixture(root: string): Promise<string> {
  const base = attemptDir(root, address.featureId, address.taskId, address.attempt);
  await atomicJson(join(base, "status.json"), { state: "done", route: { tier: "low" } });
  await atomicJson(join(base, "invocation.json"), { command: "pi", status: "success" });
  await atomicJson(join(base, "handoff.json"), { status: "done", summary: "bounded handoff" });
  await atomicJson(join(base, "evidence.json"), { hash: "evidence-hash", result: "passed" });
  await atomicJson(join(base, "artifacts.json"), { artifacts: [{ path: "result.txt", sha256: "abc" }] });
  const duplicate = JSON.stringify({ type: "message", content: "x".repeat(4_000) }) + "\n";
  await writeFile(join(base, "events.jsonl"), duplicate.repeat(20));
  await mkdir(join(base, "queries"), { recursive: true }); await writeFile(join(base, "queries", "turn-1.jsonl"), duplicate.repeat(20));
  await markAttemptOwned(root, address, "2026-01-01T00:00:00.000Z"); await writeIntegrityManifest(root, address);
  return base;
}

async function compaction(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-retention-test-"));
  try {
    const base = await fixture(root);
    const record = await compactSuccessfulAttempt(root, address, { integrated: true, now: "2026-02-01T00:00:00.000Z" });
    assert.ok(record.reclaimedRawBytes / record.beforeRawBytes >= 0.8, "controlled successful fixture reclaims at least 80%");
    assert.equal(await exists(join(base, "events.jsonl")), false); assert.equal(await exists(join(base, "queries", "turn-1.jsonl")), false);
    assert.ok((await gunzipAsync(await readFile(join(base, "events.jsonl.gz")))).length > 0);
    await verifyAttemptIntegrity(root, address);
    assert.deepEqual(await compactSuccessfulAttempt(root, address, { integrated: true }), record, "compaction is restart-safe and idempotent");
    await writeFile(join(base, "evidence.json"), "forged"); await assert.rejects(verifyAttemptIntegrity(root, address), /Integrity check failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function retainedQueriesAreAuditedHonestly(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-retention-test-"));
  try {
    const base = await fixture(root);
    await rm(join(base, "events.jsonl"));
    const queryPath = join(base, "queries", "turn-1.jsonl");
    const queryBytes = (await readFile(queryPath)).length;
    const record = await compactSuccessfulAttempt(root, address, { integrated: true });
    assert.equal(record.beforeRawBytes, queryBytes);
    assert.equal(record.afterRawBytes, queryBytes);
    assert.equal(record.reclaimedRawBytes, 0);
    assert.deepEqual(record.removedQueryFiles, []);
    assert.equal(await exists(queryPath), true, "queries without an event stream are retained and counted");
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function interruptedCompactionIsAuditedHonestly(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-retention-test-"));
  try {
    const base = await fixture(root);
    await writeFile(join(base, "events.jsonl.gz"), await readFile(join(base, "events.jsonl")));
    await rm(join(base, "events.jsonl"));
    const queryPath = join(base, "queries", "turn-1.jsonl");
    const queryBytes = (await readFile(queryPath)).length;
    const record = await compactSuccessfulAttempt(root, address, { integrated: true });
    assert.equal(record.beforeRawBytes, queryBytes);
    assert.equal(record.afterRawBytes, queryBytes);
    assert.equal(record.reclaimedRawBytes, 0);
    assert.deepEqual(record.removedQueryFiles, []);
    assert.equal(await exists(queryPath), true, "restart does not fabricate query reclamation");
    assert.deepEqual(await compactSuccessfulAttempt(root, address, { integrated: true }), record, "interrupted-compaction restart is idempotent");
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function failedRetention(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-retention-test-"));
  try {
    const base = await fixture(root); const terminalAt = "2026-01-01T00:00:00.000Z";
    const before = await pruneFailedAttemptDiagnostics(root, address, { status: "failed", terminalAt, now: "2026-01-30T23:59:59.999Z", dryRun: true });
    assert.equal(before.eligible, false); assert.ok(await exists(join(base, "events.jsonl")));
    const dry = await pruneFailedAttemptDiagnostics(root, address, { status: "failed", terminalAt, now: "2026-01-31T00:00:00.000Z", dryRun: true });
    assert.equal(dry.eligible, true); assert.ok(await exists(join(base, "events.jsonl")), "dry run never deletes");
    await assert.rejects(pruneFailedAttemptDiagnostics(root, address, { status: "failed", terminalAt, now: "2026-01-31T00:00:00.000Z", dryRun: false }), /dry-run token/);
    const pruned = await pruneFailedAttemptDiagnostics(root, address, { status: "failed", terminalAt, now: "2026-01-31T00:00:00.000Z", dryRun: false, dryRunToken: dry.dryRunToken });
    assert.equal(pruned.pruned, true); assert.equal(await exists(join(base, "events.jsonl")), false);
    assert.equal((await pruneFailedAttemptDiagnostics(root, address, { status: "failed", terminalAt, now: "2026-01-31T00:00:00.000Z", dryRun: false, dryRunToken: dry.dryRunToken })).pruned, true);
    assert.deepEqual(resolveRetentionPolicy({ failureRetentionDays: 10 }, { failureRetentionDays: 2, compaction: false }), { failureRetentionDays: 2, compaction: false });
  } finally { await rm(root, { recursive: true, force: true }); }
}

await compaction();
await retainedQueriesAreAuditedHonestly();
await interruptedCompactionIsAuditedHonestly();
await failedRetention();
console.log("retention/compaction tests passed");

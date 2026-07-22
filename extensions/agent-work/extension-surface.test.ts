import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentWorkExtension from "./index.ts";
import { escalationFromRouteFeedback, readRouteFeedback } from "./routing-feedback.ts";
import { createDefaultRouterConfig, routeTask } from "./router.ts";
import { atomicJson, attemptDir, taskDir } from "./storage.ts";

const tools: any[] = [];
const commands: any[] = [];
const events: string[] = [];
const api = {
  registerFlag() {}, registerTool(tool: any) { tools.push(tool); }, registerCommand(name: string) { commands.push(name); },
  registerEntryRenderer() {},
  on(name: string) { events.push(name); }, getFlag() { return undefined; }, setModel() {},
};
agentWorkExtension(api as any);
for (const name of ["agent_delegate", "agent_review", "agent_integrate", "agent_maintenance", "agent_router", "agent_run"]) assert.ok(tools.some((tool) => tool.name === name), `registered tool missing: ${name}`);
assert.ok(commands.includes("agent-profile"));
assert.ok(events.includes("session_start"));
assert.ok(events.includes("session_shutdown"));
const router = tools.find((tool) => tool.name === "agent_router");
assert.ok(router.parameters.args[0].diagnosisCategory, "router feedback accepts an optional diagnosis category");
const delegate = tools.find((tool) => tool.name === "agent_delegate");
for (const field of ["outcome", "surface", "nonGoals", "verificationCommands", "affectedAcceptanceTestIds", "acceptanceChecks"]) assert.ok(delegate.parameters.args[0][field], `direct delegation schema exposes bounded ${field}`);
const run = tools.find((tool) => tool.name === "agent_run");
const runTaskSchema = run.parameters.args[0].tasks.args[0].args[0].args[0];
for (const field of ["outcome", "surface", "nonGoals", "verificationCommands", "checkpointOutcome", "checkpointSurface", "affectedAcceptanceTestIds"]) assert.ok(runTaskSchema[field], `run task schema exposes ${field}`);
const persistedSchema = JSON.parse(await readFile("schemas/agent-work.schema.json", "utf8"));
const persistedTask = persistedSchema.$defs.runGraph.properties.tasks.items;
for (const field of ["outcome", "surface", "nonGoals", "verificationCommands", "checkpointOutcome", "checkpointSurface", "affectedAcceptanceTestIds"]) assert.ok(persistedTask.properties[field], `persisted run graph exposes ${field}`);
for (const field of ["checkpoints", "cancellationRequested", "combinedCoordinatorCommit", "finalGate"]) assert.ok(persistedSchema.$defs.runState.properties[field], `persisted run state exposes ${field}`);
for (const field of ["status", "coordinatorCommit", "canonicalMappings", "reportRef", "manifestRef", "retryGuidance"]) assert.ok(persistedSchema.$defs.directFinalGate.properties[field], `persisted direct final gate exposes ${field}`);
for (const field of ["status", "sourceCommit", "preIntegrationCommit", "coordinatorCommit", "patchEquivalentCommit", "retryGuidance"]) assert.ok(persistedSchema.$defs.integrationAttempt.properties[field], `persisted integration attempt exposes ${field}`);
for (const field of ["affectedAcceptanceTestIds", "acceptanceChecks"]) assert.ok(persistedSchema.$defs.task.allOf[1].properties[field], `persisted direct task exposes ${field}`);
assert.ok(!persistedTask.required.includes("outcome"), "legacy persisted run graphs remain migration-safe while new submissions validate bounds");

const root = await mkdtemp(join(tmpdir(), "agent-extension-surface-"));
try {
  for (const mode of ["read", "write"] as const) {
    await assert.rejects(delegate.execute(`invalid-${mode}`, { featureId: "f", taskId: `invalid-${mode}`, title: "invalid", prompt: "invalid", mode, outcome: "two outcomes, bypass validation", surface: ["src/**"], nonGoals: ["N/A"], verificationCommands: ["exit 0"] }, undefined, undefined, { cwd: root }), /Delegation refused before launch/);
    await assert.rejects(readFile(join(taskDir(root, "f", `invalid-${mode}`), "task.json")), /ENOENT/, "invalid public delegation has no task side effect");
  }
  const status = async (taskId: string) => atomicJson(join(taskDir(root, "f", taskId), "status.json"), {
    schemaVersion: 1, featureId: "f", taskId, state: "failed", currentAttempt: 1, updatedAt: new Date().toISOString(),
  });
  await status("plain");
  await status("diagnosed");
  await status("ordinary");
  await atomicJson(join(attemptDir(root, "f", "plain", 1), "invocation.json"), { model: "openai-codex/gpt-5.6-terra" });
  await atomicJson(join(attemptDir(root, "f", "diagnosed", 1), "invocation.json"), { model: "openai-codex/gpt-5.6-terra" });
  const ctx = { cwd: root };
  await router.execute("plain", { action: "feedback", featureId: "f", taskId: "plain", outcome: "failed" }, undefined, undefined, ctx);
  await router.execute("diagnosed", { action: "feedback", featureId: "f", taskId: "diagnosed", outcome: "failed", diagnosisCategory: "task-complexity", diagnosisReason: "bounded task exceeded tier" }, undefined, undefined, ctx);
  await router.execute("duplicate", { action: "feedback", featureId: "f", taskId: "diagnosed", outcome: "accepted" }, undefined, undefined, ctx);
  await router.execute("ordinary", { action: "feedback", featureId: "f", taskId: "ordinary", outcome: "corrected" }, undefined, undefined, ctx);
  await assert.rejects(router.execute("invalid", { action: "feedback", featureId: "f", taskId: "plain", outcome: "failed", diagnosisCategory: "unknown", diagnosisReason: "nope" }, undefined, undefined, ctx), /valid category/);
  const feedback = await readRouteFeedback(root);
  const plain = feedback.find((item) => item.taskId === "plain")!;
  const diagnosed = feedback.find((item) => item.taskId === "diagnosed")!;
  assert.equal(escalationFromRouteFeedback(plain), undefined, "failure without diagnosis stays at its tier");
  assert.deepEqual(diagnosed.diagnosis, { category: "task-complexity", reason: "bounded task exceeded tier" }, "idempotent feedback retains the first diagnosis");
  const retry = routeTask(createDefaultRouterConfig(), {
    taskId: "diagnosed", title: "retry", prompt: "retry", mode: "write", profile: "worker", attempt: 2,
    escalation: escalationFromRouteFeedback(diagnosed),
  });
  assert.equal(retry.escalation?.diagnosis.category, "task-complexity", "diagnosed failure reaches retry routing");
  assert.equal(feedback.filter((item) => item.taskId === "diagnosed").length, 1, "feedback remains idempotent");
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("registered extension surface smoke passed");

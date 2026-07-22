import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  dedupeFindings,
  parseFindings,
  parseVerdict,
  renderCritiqueReport,
  type CritiqueFinding,
} from "./critique.ts";
import { CRITICAL_FEEDBACK_PROTOCOL, FEATURE_WORKFLOW_PROTOCOL, ROUTER_ORCHESTRATION_PROTOCOL, perspectivePrompt, perspectivesFor, type CritiqueDepth, type CritiqueTargetType } from "./policy.ts";
import {
  buildQuestionnaireParamsSchema,
  cancelledResult,
  errorResult,
  normalizeQuestions,
  QUESTIONNAIRE_DESCRIPTION,
  QUESTIONNAIRE_PROMPT_GUIDELINES,
  QUESTIONNAIRE_TOOL_NAME,
  submittedResult,
  uiUnavailableResult,
  validateQuestions,
} from "./questionnaire.ts";
import { runQuestionnaireUi } from "./questionnaire-ui.ts";
import { Text } from "@earendil-works/pi-tui";
import {
  assertWriteGate,
  ensureRequirementsSession,
  renderRequirementsArtifacts,
  requirementsCliPath,
  requirementsDir,
  requirementsStatus,
  runRequirementsCli,
} from "./requirements.ts";
import { runPi, piInvocation, writeSystemPrompt } from "./runner.ts";
import {
  cancelActiveOperation,
  findProgressTimelines,
  formatProgress,
  getActiveOperation,
  listActiveOperations,
  ProgressMonitor,
  readProgressTimeline,
} from "./progress.ts";
import {
  activateAgentProfile,
  activateStartupProfile,
  createSessionProfileRuntime,
  ensureRuntimeAfterCommandFailure,
  ensureRuntimeAfterCommandSuccess,
  routingConfigForSession,
  type SessionProfileRuntime,
} from "./profiles.ts";
import {
  ECONOMY_PROFILE_NAME,
  PRO_PROFILE_NAME,
  formatActiveProfileStatus,
  loadRouterConfig,
  routeTask,
  routerConfigPath,
  type RouteComplexity,
  type RouteRisk,
  type RouterConfig,
} from "./router.ts";
import {
  appendJsonl,
  assertFeature,
  atomicJson,
  attemptDir,
  createFeature,
  createTask,
  exists,
  featureDir,
  findJsonlFiles,
  initializeRoot,
  nextAttempt,
  now,
  readJson,
  readStatus,
  readTask,
  rootDir,
  safeId,
  taskDir,
  validateHandoff,
  writeStatus,
} from "./storage.ts";
import { registerStatusFooter } from "./status-footer.ts";
import { registerAgentStatusUi } from "./agent-status-ui.ts";
import { SCHEMA_VERSION, type Handoff, type InvocationRecord, type ProgressEvent, type ProgressOperationKind, type SessionReference, type TaskMode, type TaskRecord } from "./types.ts";
import { loadState } from "../../requirements/src/state.ts";
import { assessFidelityLayers, evidenceResultForLayerStatus, evidenceResultForVerificationStatus, finalWorkspaceBlockers, integrationBlockers, rerunAcceptanceTests, sanitizeSummary, validateBuilderEvidence, writeVerificationReport, type BuilderEvidence, type VerificationFinding, type VerificationReport } from "./verification.ts";
import {
  acceptRun,
  boundedDelegationContractIssues,
  commandFidelity,
  applyProposal,
  approveProposal,
  cancelRun,
  getRun,
  listProposals,
  listRuns,
  retryRunTask,
  retryRunFinalGate,
  runReflection,
  selectSealedCheckpointReview,
  startRun,
  suspendRuns,
  type RunDeclaration,
  type RunExecutor,
  type RunTaskDeclaration,
} from "./runs.ts";
import { ancestorEvidence, canonicalAcceptanceProvenance, createEvidenceManifest, finalGateBlockers, intermediateEvidencePlan, mayExecuteCommand, type EvidenceManifest, type EvidenceRecord } from "./evidence.ts";
import { classifyChangedSurfaceFromDiff, recordReviewCompletion, reviewPlan, type ReviewLifecycleState, type ReviewMode } from "./review-lifecycle.ts";
import { createPromptSlice, renderPromptSlice, type PromptSliceRole } from "./prompt-slice.ts";
import { diagnoseMissingRouteFeedback, escalationFromRouteFeedback, readRouteFeedback, settleTerminalRoute, validEscalationDiagnosis } from "./routing-feedback.ts";
import { compactSuccessfulAttempt, markAttemptOwned, pruneFailedAttemptDiagnostics, resolveRetentionPolicy, writeIntegrityManifest } from "./retention.ts";
import { diagnoseGitAnomalies, findPatchEquivalentAncestor, gitPatchEquivalent, markCbpiWorktreeCollected, planGitRepair, reconcileCbpiLifecycle, registerCbpiWorktree } from "./lifecycle.ts";
import { loadWorkflowConfig, type WorkflowOverrides } from "./workflow-config.ts";
import { checkpointWorkspaceMetadataIssues, type CheckpointWorkspaceMetadata } from "./checkpoint-workspace.ts";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 40_000;
const rootLocks = new Map<string, Promise<void>>();

function lifecyclePath(root: string, featureId: string, taskId: string): string {
  return join(taskDir(root, featureId, taskId), "review-lifecycle.json");
}

async function loadReviewLifecycle(root: string, featureId: string, taskId: string, revision: string): Promise<ReviewLifecycleState> {
  const path = lifecyclePath(root, featureId, taskId);
  if (!(await exists(path))) return { requirementsRevision: revision, broadReviews: 0, findings: [] };
  const state = await readJson<ReviewLifecycleState>(path);
  if (state.requirementsRevision !== revision) throw new Error("review lifecycle requirements revision mismatch");
  return state;
}

async function writeEvidenceManifest(root: string, featureId: string, taskId: string, attempt: number, requirements: ReturnType<typeof loadState>, commit: string, evidence: BuilderEvidence): Promise<EvidenceManifest> {
  const path = join(attemptDir(root, featureId, taskId, attempt), "evidence-manifest.json");
  const prior = (await exists(path)) ? await readJson<EvidenceManifest>(path) : undefined;
  const canonicalIds = new Set(requirements.acceptanceTests.map((test) => `builder-${test.id}`));
  const ancestor = prior && prior.commit !== commit ? ancestorEvidence(prior.records.filter((record) => canonicalIds.has(record.id)), commit) : [];
  const declaredPath = join(attemptDir(root, featureId, taskId, attempt), "declared-verification.json");
  const declared = await exists(declaredPath) ? await readJson<any>(declaredPath) : undefined;
  const provenance = declared?.binding?.kind === "preseal" ? { sourceStateHash: declared.binding.patchHash, sourceTurnId: taskId, ...(declared.checkpointId ? { sourceCheckpointId: String(declared.checkpointId) } : {}) } : { sourceTurnId: taskId };
  const records: EvidenceRecord[] = evidence.tests.map((test) => {
    const provenanceForTest = canonicalAcceptanceProvenance(requirements.acceptanceTests, test.testId);
    return {
      id: `builder-${provenanceForTest.recordId}`,
      ...provenance, command: test.command, commandIdentity: "", kind: "full-suite" as const,
      requirementsRevision: requirements.requirementsRevision, commit, environment: test.environment, result: test.result,
      artifactHash: test.artifact?.sha256, fidelity: provenanceForTest.fidelity, scenarios: provenanceForTest.scenarios,
      freshness: "fresh" as const,
    };
  });
  const manifest = createEvidenceManifest({ requirementsRevision: requirements.requirementsRevision, commit, records: [...ancestor, ...records] });
  await atomicJson(path, manifest);
  return manifest;
}

async function taskIsHighRisk(root: string, featureId: string, taskId: string, attempt: number): Promise<boolean> {
  const path = join(attemptDir(root, featureId, taskId, attempt), "invocation.json");
  if (!(await exists(path))) return false;
  const invocation = await readJson<InvocationRecord>(path);
  return (invocation.route as { classification?: { risk?: string } } | undefined)?.classification?.risk === "high";
}

async function finalIntegrationBlockers(root: string, featureId: string, taskId: string, attempt: number, requirements: ReturnType<typeof loadState>, commit: string, highRisk: boolean): Promise<string[]> {
  const reportPath = join(taskDir(root, featureId, taskId), "verification-report.json");
  const blockers = integrationBlockers(requirements, commit, (await exists(reportPath)) ? await readJson<unknown>(reportPath) : undefined);
  if (!highRisk) return blockers;
  const finalPath = join(attemptDir(root, featureId, taskId, attempt), "final-evidence-manifest.json");
  if (!(await exists(finalPath))) return [...blockers, "high-risk integration requires a persisted final-gate evidence manifest"];
  const manifest = await readJson<EvidenceManifest>(finalPath);
  return [...blockers, ...finalGateBlockers(manifest.records, commit, requirements.requirementsRevision, requirements.acceptanceTests.some((test) => test.fidelityLayer === "real-end-to-end"))];
}

async function reviewVerification(attempt: string, requirements: ReturnType<typeof loadState>, evidence: BuilderEvidence, cwd: string, commit: string, findings: VerificationFinding[], mode: ReviewMode, overrideRationale?: string): Promise<VerificationReport> {
  const manifestPath = join(attempt, "evidence-manifest.json");
  const manifest = await exists(manifestPath) ? await readJson<EvidenceManifest>(manifestPath) : createEvidenceManifest({ requirementsRevision: requirements.requirementsRevision, commit, records: [] });
  const plan = intermediateEvidencePlan(manifest.records, commit);
  const duplicate = mayExecuteCommand({ records: manifest.records, command: "acceptance-suite", expensive: true, finalGate: mode === "final-gate", overrideRationale });
  if (mode === "focused" && plan.reused.length) {
    // The reviewer invocation is the targeted adversarial check; reuse is explicitly labelled.
    return { schemaVersion: 2, requirementsRevision: requirements.requirementsRevision, reviewedCommit: commit, generatedAt: now(), tests: requirements.acceptanceTests.map((test) => ({ testId: test.id, status: "passed", evidenceAssessment: "Reused same-commit full-suite evidence; focused targeted adversarial review ran." })), findings, evidenceComplete: true, approved: !findings.some((finding) => ["critical", "high"].includes(finding.severity) && finding.status === "open") };
  }
  if (!duplicate.allowed) throw new Error(duplicate.reason);
  return rerunAcceptanceTests(requirements, evidence, cwd, commit, findings);
}

async function settleRouteOutcome(root: string, route: { selectedModel?: string }, featureId: string, taskId: string, attempt: number, state: string): Promise<void> {
  await settleTerminalRoute(root, {
    featureId, taskId, attempt, model: route.selectedModel,
    outcome: state === "done" || state === "review" || state === "integrated" ? "accepted" : "failed",
  });
}

async function withRootLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = rootLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = previous.then(() => gate);
  rootLocks.set(root, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (rootLocks.get(root) === queued) rootLocks.delete(root);
  }
}

async function command(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024, signal });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    const message = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
    throw new Error(`${cmd} ${args.join(" ")} failed: ${message}`);
  }
}

interface SourceStateSnapshot {
  hash: string;
  head: string;
  trackedCount: number;
  untrackedCount: number;
  dirty: boolean;
}

async function sourceStateSnapshot(cwd: string, signal?: AbortSignal): Promise<SourceStateSnapshot> {
  const [head, index, porcelain, trackedRaw, untrackedRaw] = await Promise.all([
    command("git", ["rev-parse", "HEAD"], cwd, signal).then((result) => result.stdout.trim()),
    command("git", ["ls-files", "--stage", "-z"], cwd, signal).then((result) => result.stdout),
    command("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, signal).then((result) => result.stdout),
    command("git", ["ls-files", "--cached", "-z"], cwd, signal).then((result) => result.stdout.split("\0").filter(Boolean).sort()),
    command("git", ["ls-files", "--others", "--exclude-standard", "-z"], cwd, signal).then((result) => result.stdout.split("\0").filter(Boolean).sort()),
  ]);
  const hash = createHash("sha256").update("source-state-v1\0").update(head).update("\0index\0").update(index).update("\0status\0").update(porcelain);
  for (const [kind, paths] of [["tracked", trackedRaw], ["untracked", untrackedRaw]] as const) {
    for (const relativePath of paths) {
      hash.update("\0").update(kind).update("\0").update(relativePath).update("\0");
      try {
        const info = await lstat(join(cwd, relativePath));
        if (info.isSymbolicLink()) hash.update("symlink\0").update(await readlink(join(cwd, relativePath)));
        else if (info.isFile()) hash.update("file\0").update(await readFile(join(cwd, relativePath)));
        else hash.update(`non-file:${info.mode}\0`);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        hash.update("missing\0");
      }
    }
  }
  return { hash: `sha256:${hash.digest("hex")}`, head, trackedCount: trackedRaw.length, untrackedCount: untrackedRaw.length, dirty: Boolean(porcelain) };
}

async function runSideEffectFreeVerification(commands: readonly string[], cwd: string, signal?: AbortSignal): Promise<{
  records: Array<{ command: string; result: "passed" | "failed"; summary: string; sourceStateBefore: string; sourceStateAfter: string; sourceStateUnchanged: boolean }>;
  failed: boolean;
  postState: SourceStateSnapshot;
}> {
  const records: Array<{ command: string; result: "passed" | "failed"; summary: string; sourceStateBefore: string; sourceStateAfter: string; sourceStateUnchanged: boolean }> = [];
  let failed = false;
  let postState = await sourceStateSnapshot(cwd, signal);
  for (const declaredCommand of commands) {
    const before = postState;
    let commandPassed = true;
    let summary = "";
    try {
      const result = await execFileAsync("/bin/sh", ["-lc", declaredCommand], { cwd, maxBuffer: 10 * 1024 * 1024, signal });
      summary = sanitizeSummary(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    } catch (error: any) {
      commandPassed = false;
      summary = sanitizeSummary(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? "verification failed"}`);
    }
    const after = await sourceStateSnapshot(cwd, signal);
    const unchanged = before.hash === after.hash;
    if (!unchanged) summary = sanitizeSummary(`${summary}\nVerification command mutated tracked or untracked source state (${before.hash} -> ${after.hash}); the targeted verification gate is blocked.`);
    records.push({ command: declaredCommand, result: commandPassed && unchanged ? "passed" : "failed", summary, sourceStateBefore: before.hash, sourceStateAfter: after.hash, sourceStateUnchanged: unchanged });
    postState = after;
    if (!commandPassed || !unchanged) failed = true;
  }
  return { records, failed, postState };
}

async function projectRoot(cwd: string): Promise<string> {
  try {
    return (await command("git", ["rev-parse", "--show-toplevel"], cwd)).stdout.trim();
  } catch {
    return resolve(cwd);
  }
}

async function ensureLocalIgnore(root: string): Promise<void> {
  try {
    const gitDir = (await command("git", ["rev-parse", "--git-path", "info/exclude"], root)).stdout.trim();
    const path = resolve(root, gitDir);
    const current = (await exists(path)) ? await readFile(path, "utf8") : "";
    if (!current.split(/\r?\n/).includes(".agent-work/")) {
      await writeFile(path, `${current}${current.endsWith("\n") || !current ? "" : "\n"}.agent-work/\n`, "utf8");
    }
  } catch {
    // Non-git projects still get artifact structure.
  }
}

async function assertClean(root: string): Promise<void> {
  const status = (await command("git", ["status", "--porcelain"], root)).stdout.trim();
  if (status) throw new Error("Writing subagents require a clean coordinator worktree");
}

interface IntegrationAttemptRecord {
  schemaVersion: 1;
  status: "running" | "blocked" | "applied";
  sourceCommit: string;
  preIntegrationCommit: string;
  coordinatorCommit?: string;
  patchEquivalentCommit?: string;
  reason?: string;
  retryGuidance?: string;
  updatedAt: string;
}

async function cherryPickOrReuse(root: string, sourceCommit: string, recordPath: string, signal?: AbortSignal): Promise<{ coordinatorCommit: string; patchEquivalentCommit: string; reused: boolean }> {
  return withRootLock(root, async () => {
    await assertClean(root);
    const preIntegrationCommit = (await command("git", ["rev-parse", "HEAD"], root, signal)).stdout.trim();
    const priorAttempt = await exists(recordPath) ? await readJson<IntegrationAttemptRecord>(recordPath).catch(() => undefined) : undefined;
    const record: IntegrationAttemptRecord = { schemaVersion: 1, status: "running", sourceCommit, preIntegrationCommit, updatedAt: now() };
    await atomicJson(recordPath, record);
    const equivalent = priorAttempt?.sourceCommit === sourceCommit
      ? await findPatchEquivalentAncestor(root, sourceCommit)
      : await gitPatchEquivalent(root, preIntegrationCommit, sourceCommit) ? preIntegrationCommit : undefined;
    if (equivalent) {
      record.status = "applied"; record.coordinatorCommit = preIntegrationCommit; record.patchEquivalentCommit = equivalent; record.updatedAt = now();
      await atomicJson(recordPath, record);
      return { coordinatorCommit: preIntegrationCommit, patchEquivalentCommit: equivalent, reused: true };
    }
    try {
      await command("git", ["cherry-pick", sourceCommit], root, signal);
      const coordinatorCommit = (await command("git", ["rev-parse", "HEAD"], root, signal)).stdout.trim();
      await assertClean(root);
      if (!(await gitPatchEquivalent(root, coordinatorCommit, sourceCommit))) throw new Error("created coordinator commit is not patch-equivalent to the reviewed source commit");
      record.status = "applied"; record.coordinatorCommit = coordinatorCommit; record.patchEquivalentCommit = coordinatorCommit; record.updatedAt = now();
      await atomicJson(recordPath, record);
      return { coordinatorCommit, patchEquivalentCommit: coordinatorCommit, reused: false };
    } catch (error: any) {
      await command("git", ["cherry-pick", "--abort"], root).catch(() => undefined);
      await command("git", ["reset", "--hard", preIntegrationCommit], root);
      await command("git", ["clean", "-fd"], root);
      const restoredHead = (await command("git", ["rev-parse", "HEAD"], root)).stdout.trim();
      const restoredStatus = (await command("git", ["status", "--porcelain"], root)).stdout.trim();
      const restored = restoredHead === preIntegrationCommit && !restoredStatus;
      record.status = "blocked";
      record.reason = sanitizeSummary(`${error?.message ?? error}${restored ? "" : "; automatic coordinator restoration could not be proven"}`);
      record.retryGuidance = restored ? "Resolve the source/coordinator conflict or advance the clean coordinator base, then retry integration; patch-equivalent retries are reused." : "Repair the coordinator worktree to the recorded pre-integration commit before retrying.";
      record.updatedAt = now(); await atomicJson(recordPath, record);
      if (!restored) throw new Error(`Integration failed and coordinator restoration was not clean: ${record.reason}`);
      throw new Error(`Integration blocked and coordinator restored cleanly: ${record.reason}; ${record.retryGuidance}`);
    }
  });
}

function truncate(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n\n[Truncated ${text.length - OUTPUT_LIMIT} characters; inspect the on-disk artifact for the complete content.]`;
}

async function renderedHandoffSourceHash(path: string): Promise<string> {
  const bytes = await readFile(path);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseHandoffText(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("Subagent final response was not valid handoff JSON");
  }
}

function finalReceipt(input: {
  featureId: string;
  taskId: string;
  attempt: number;
  state: string;
  attemptPath: string;
  sessionFile?: string;
  commit?: string;
  summary?: string;
}): string {
  return [
    `${input.featureId}/${input.taskId} attempt ${input.attempt}: ${input.state}`,
    input.summary ? `Summary: ${input.summary}` : undefined,
    input.commit ? `Commit: ${input.commit}` : undefined,
    input.sessionFile ? `Session: ${input.sessionFile}` : undefined,
    `Artifacts: ${input.attemptPath}`,
  ].filter(Boolean).join("\n");
}

function buildChildArgs(input: {
  prompt: string;
  systemPromptPath: string;
  sessionDir: string;
  name: string;
  mode: TaskMode;
  model?: string;
  thinking?: string;
}): string[] {
  const tools = input.mode === "write" ? "read,grep,find,ls,bash,edit,write" : "read,grep,find,ls,bash";
  const args = [
    "--mode", "json", "-p",
    "--session-dir", input.sessionDir,
    "--name", input.name,
    "--tools", tools,
    "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--append-system-prompt", input.systemPromptPath,
  ];
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--thinking", input.thinking);
  args.push(input.prompt);
  return args;
}

type ProgressCallback = (text: string, event?: ProgressEvent) => void;

function operationKind(profile: string, explicit?: ProgressOperationKind): ProgressOperationKind {
  if (explicit) return explicit;
  if (profile === "critique-verifier") return "verification";
  if (profile === "reviewer" || profile.startsWith("critique-")) return "review";
  return "delegation";
}

function boundedContractText(input: Pick<RunTaskDeclaration, "outcome" | "surface" | "nonGoals" | "verificationCommands">): string {
  return `Declared bounded-work contract (coordinator-owned; do not reinterpret):\nOutcome: ${input.outcome}\nAllowed surface:\n${input.surface.map((item) => `- ${item}`).join("\n")}\nNon-goals:\n${input.nonGoals.map((item) => `- ${item}`).join("\n")}\nRequired verification commands:\n${input.verificationCommands.map((item) => `- ${item}`).join("\n")}`;
}

function operationId(kind: ProgressOperationKind, featureId: string, taskId: string, attempt: number): string {
  return `${kind}-${featureId}-${taskId}-a${attempt}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runTask(
  root: string,
  input: {
    featureId: string;
    taskId: string;
    title: string;
    prompt: string;
    mode: TaskMode;
    profile: string;
    dependsOn: string[];
    model?: string;
    thinking?: string;
    complexity?: RouteComplexity;
    risk?: RouteRisk;
    prefer?: "cost" | "speed" | "quality" | "balanced";
    outcome: string;
    surface: string[];
    nonGoals: string[];
    verificationCommands: string[];
    affectedAcceptanceTestIds?: string[];
    acceptanceChecks?: Array<{ testId: string; command: string }>;
    retry?: boolean;
    cwdOverride?: string;
    /** Reuse a checkpoint-owned isolated worktree rather than provisioning a task worktree. */
    sharedWorktree?: string;
    /** Leave changes uncommitted until the checkpoint's final turn seals them. */
    deferCommit?: boolean;
    /** Bounded acceptance subset for this checkpoint turn; omission means all for compatibility. */
    requiredAcceptanceTestIds?: string[];
    systemExtra?: string;
    forceRequirements?: boolean;
    skipRequirementsGate?: boolean;
    hardTimeoutMs?: number;
    inactivityMs?: number;
    routeSlice?: { role?: "builder" | "scout" | "reviewer"; complexity?: RouteComplexity; risk?: RouteRisk; kind?: "ui" | "test" | "maintenance" | "architecture" | "security" | "integration" | "general" };
    workflow?: WorkflowOverrides;
    operationKind?: ProgressOperationKind;
    operationId?: string;
  },
  signal: AbortSignal | undefined,
  onProgress?: ProgressCallback,
): Promise<{ receipt: string; finalText: string; attemptPath: string; sessionFile?: string; operationId: string }> {
  const contractIssues = boundedDelegationContractIssues(input);
  if (contractIssues.length) throw new Error(`Delegation refused before launch: ${contractIssues.join("; ")}`);
  const feature = await assertFeature(root, input.featureId);
  // Capture before asynchronous work so an outcome remains attributed to its initiating Pi session.
  const coordinatorSessionId = activeSessionId;
  const featureId = feature.id;
  const taskId = safeId(input.taskId, "task id");
  const taskPath = taskDir(root, featureId, taskId);

  if (!(await exists(join(taskPath, "task.json")))) {
    const task: TaskRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: taskId,
      featureId,
      title: input.title,
      prompt: input.prompt,
      mode: input.mode,
      profile: input.profile,
      dependsOn: input.dependsOn,
      affectedAcceptanceTestIds: input.affectedAcceptanceTestIds,
      acceptanceChecks: input.acceptanceChecks,
      createdAt: now(),
    };
    await createTask(root, task);
  } else if (!input.retry) {
    throw new Error(`Task already exists: ${taskId}. Set retry=true to create a new immutable attempt.`);
  }

  const task = await readTask(root, featureId, taskId);
  const attempt = await nextAttempt(root, featureId, taskId);
  const attemptPath = attemptDir(root, featureId, taskId, attempt);
  const workflow = await loadWorkflowConfig(root, input.workflow);
  const diskRouter = await loadRouterConfig(root);
  // Session activation gate: profile routing applies only after successful startup/command activation.
  const effectiveRouter = activeSessionProfileRuntime
    ? routingConfigForSession(activeSessionProfileRuntime, diskRouter)
    : diskRouter;
  const previousFeedback = (await readRouteFeedback(root)).filter((item) => item.featureId === featureId && item.taskId === taskId).at(-1);
  const route = routeTask(effectiveRouter, {
    taskId, title: input.title, prompt: input.prompt, mode: input.mode, profile: input.profile, attempt,
    complexity: input.complexity, risk: input.risk, prefer: input.prefer, slice: input.routeSlice,
    escalation: workflow.routing?.allowEscalation === false ? undefined : previousFeedback ? escalationFromRouteFeedback(previousFeedback) : undefined,
  }, input.model, input.thinking);
  const selectedModel = route.selectedModel;
  const selectedThinking = input.thinking ?? route.thinking;
  const eventsFile = join(attemptPath, "events.jsonl");
  const handoffPath = join(attemptPath, "handoff.json");
  const evidencePath = join(attemptPath, "evidence.json");
  const sessionDir = join(attemptPath, "sessions");
  const systemPromptPath = join(attemptPath, "system.md");
  let childCwd = input.cwdOverride ? resolve(input.cwdOverride) : root;
  let branch: string | undefined;
  let worktree: string | undefined;
  let builderHandoffPath: string | undefined;
  let forcedRequirements = false;

  await initializeRoot(root);
  await atomicJson(join(taskPath, "current.json"), {
    schemaVersion: SCHEMA_VERSION,
    attempt,
    path: attemptPath,
    updatedAt: now(),
  });
  await atomicJson(join(attemptPath, "artifacts", "index.json"), { schemaVersion: SCHEMA_VERSION, artifacts: [] });
  await markAttemptOwned(root, { featureId, taskId, attempt });

  const kind = operationKind(input.profile, input.operationKind);
  const currentOperationId = input.operationId ?? operationId(kind, featureId, taskId, attempt);
  const monitor = await ProgressMonitor.start({
    root,
    featureId,
    taskId,
    taskLabel: task.title,
    attempt,
    operationId: currentOperationId,
    operation: kind,
    phase: "preparing",
    hardTimeoutMs: input.hardTimeoutMs ?? workflow.liveness?.hardTimeoutMs,
    inactivityMs: input.inactivityMs ?? workflow.liveness?.inactivityMs,
    onStall: async () => { status.state = "stalled"; status.message = "No structured progress; child remains reachable and diagnostics are retained"; await writeStatus(root, status); },
    onRecovery: async () => { if (status.state === "stalled") { status.state = "running"; status.message = "Structured progress recovered"; await writeStatus(root, status); } },
    onDelivery: onProgress ? (event) => onProgress(formatProgress(event), event) : undefined,
  });
  if (input.retry) await monitor.milestone("Explicit retry attempt started");

  const status = await readStatus(root, featureId, taskId);
  Object.assign(status, {
    state: "running",
    currentAttempt: attempt,
    branch: undefined,
    worktree: undefined,
    message: undefined,
  });
  await writeStatus(root, status);

  try {
  if (input.mode === "write" && !input.skipRequirementsGate) {
    await monitor.phaseChange("requirements", "Checking requirements gate");
    try {
      const gate = await assertWriteGate(root, featureId, { force: input.forceRequirements });
      builderHandoffPath = gate.handoffPath;
      forcedRequirements = gate.forced;
    } catch (error: any) {
      status.state = "failed";
      status.message = error?.message ?? String(error);
      await writeStatus(root, status);
      throw error;
    }
  }

  if (input.mode === "write") {
    if (input.sharedWorktree) {
      childCwd = resolve(input.sharedWorktree);
      status.worktree = childCwd;
      await writeStatus(root, status);
    } else {
      await monitor.phaseChange("isolating", "Preparing isolated worktree");
      try {
        await command("git", ["rev-parse", "--is-inside-work-tree"], root);
        branch = `agent-work/${safeId(featureId)}/${taskId}/a${attempt}`;
        worktree = join(attemptPath, "worktree");
        await withRootLock(root, async () => {
          await assertClean(root);
          await command("git", ["worktree", "add", "-b", branch!, worktree!, "HEAD"], root);
        });
        childCwd = worktree;
        status.branch = branch;
        status.worktree = worktree;
        await writeStatus(root, status);
      } catch (error: any) {
        status.state = "failed";
        status.message = error?.message ?? String(error);
        await writeStatus(root, status);
        throw error;
      }
    }
  }

  await monitor.phaseChange("launching", "Preparing child invocation");
  await writeSystemPrompt(systemPromptPath, input.profile, handoffPath, input.mode, input.systemExtra ?? "");
  const brief = await readFile(join(featureDir(root, featureId), "brief.md"), "utf8");
  const builderHandoff = builderHandoffPath && await exists(builderHandoffPath)
    ? await readFile(builderHandoffPath, "utf8")
    : "";
  const prompt = [
    `Feature ID: ${featureId}`,
    `Task ID: ${taskId}`,
    `Attempt: ${attempt}`,
    forcedRequirements ? "Requirements handoff was FORCE-rendered with residual risk." : undefined,
    "",
    brief,
    builderHandoff ? `\n## Builder Handoff\n${builderHandoff}` : "",
    "",
    "## Delegated Task",
    task.prompt,
    "",
    boundedContractText(input),
    "",
    input.mode === "write"
      ? `Write the required handoff to: ${handoffPath}\nWrite schema-v2 builder test evidence to: ${evidencePath}. Shape: {\"schemaVersion\":2,\"requirementsRevision\":\"sha256:...\",\"implementationCommit\":\"pending\",\"tests\":[{\"testId\":\"at-...\",\"command\":\"...\",\"result\":\"passed|failed|not-run\",\"environment\":\"...\",\"scenarios\":[\"happy-path|boundaries|malformed-input|failure-recovery|regression|abuse\"],\"summary\":\"bounded sanitized relevant output\",\"artifact\":{\"path\":\"durable path\",\"sha256\":\"sha256:...\"}}]}. Omit artifact only when the bounded summary is sufficient.`
      : "Return the required handoff JSON as your entire final response.",
  ].filter(Boolean).join("\n");

  const args = buildChildArgs({
    prompt,
    systemPromptPath,
    sessionDir,
    name: `${featureId}/${taskId}/a${attempt}`,
    mode: input.mode,
    model: selectedModel,
    thinking: selectedThinking,
  });
  const invocation = piInvocation(args);
  const invocationRecord: InvocationRecord = {
    schemaVersion: SCHEMA_VERSION,
    featureId,
    taskId,
    attempt,
    profile: input.profile,
    mode: input.mode,
    cwd: childCwd,
    command: invocation.command,
    args: args.map((arg, index) => index === args.length - 1 ? "<task-prompt>" : arg),
    model: selectedModel,
    thinking: selectedThinking,
    route,
    startedAt: now(),
  };
  await atomicJson(join(attemptPath, "route.json"), route);
  await atomicJson(join(attemptPath, "invocation.json"), invocationRecord);
  await appendJsonl(join(rootDir(root), "routing-decisions.jsonl"), {
    timestamp: route.timestamp, type: "route", featureId, taskId, attempt, ...route,
  });

    await monitor.phaseChange(kind === "review" ? "reviewing" : kind === "verification" ? "verifying" : "delegating", "Child process launched");
    const run = await runPi({ cwd: childCwd, args, eventsFile, signal, monitor });
    invocationRecord.completedAt = now();
    invocationRecord.durationMs = Date.parse(invocationRecord.completedAt) - Date.parse(invocationRecord.startedAt);
    invocationRecord.usage = run.usage;
    invocationRecord.exitCode = run.exitCode;
    await atomicJson(join(attemptPath, "invocation.json"), invocationRecord);

    const sessionFiles = await findJsonlFiles(sessionDir);
    const sessionFile = sessionFiles[0];
    const sessionRef: SessionReference = {
      schemaVersion: SCHEMA_VERSION,
      id: run.sessionId,
      file: sessionFile,
      eventsFile,
      cwd: childCwd,
      updatedAt: now(),
    };
    await atomicJson(join(attemptPath, "session.json"), sessionRef);

      if (run.exitCode !== 0) {
      status.state = "failed";
      status.message = truncate(run.stderr || run.finalText || `Subagent exited ${run.exitCode}`);
      await writeStatus(root, status);
      await appendJsonl(join(rootDir(root), "routing-decisions.jsonl"), {
        timestamp: now(), type: "outcome", featureId, taskId, attempt, model: selectedModel,
        state: status.state, durationMs: invocationRecord.durationMs, usage: run.usage, correction: attempt > 1,
        sessionId: coordinatorSessionId,
      });
        await monitor.terminal("failure", "Child process failed; inspect persisted diagnostics");
        await writeIntegrityManifest(root, { featureId, taskId, attempt });
      return {
        receipt: finalReceipt({ featureId, taskId, attempt, state: status.state, attemptPath, sessionFile, summary: status.message }),
        finalText: run.finalText,
        attemptPath,
        sessionFile,
        operationId: currentOperationId,
      };
    }

    let handoff: Handoff | undefined;
    if (await exists(handoffPath)) {
      const candidate = await readJson<unknown>(handoffPath);
      if (validateHandoff(candidate)) handoff = candidate;
    } else if (input.mode === "read") {
      try {
        const candidate = parseHandoffText(run.finalText);
        if (validateHandoff(candidate)) handoff = candidate;
      } catch {
        // For critique sub-runs we may synthesize a handoff from freeform text later.
      }
    }
    if (!handoff) {
      if (input.mode === "read" && run.finalText.trim()) {
        handoff = {
          schemaVersion: SCHEMA_VERSION,
          featureId,
          taskId,
          attempt,
          status: "done",
          summary: run.finalText.trim().slice(0, 2000),
          changedFiles: [],
          checks: [],
          decisions: [],
          risks: [],
          blockers: [],
          nextSteps: [],
          session: { id: run.sessionId, file: sessionFile, eventsFile },
          createdAt: now(),
        };
      } else {
        status.state = "failed";
        status.message = "Subagent did not produce a valid handoff.json";
        await writeStatus(root, status);
        await appendJsonl(join(rootDir(root), "routing-decisions.jsonl"), {
          timestamp: now(), type: "outcome", featureId, taskId, attempt, model: selectedModel,
          state: status.state, durationMs: invocationRecord.durationMs, usage: run.usage, correction: attempt > 1,
          sessionId: coordinatorSessionId,
        });
        await monitor.terminal("failure", status.message);
        await writeIntegrityManifest(root, { featureId, taskId, attempt });
        return {
          receipt: finalReceipt({ featureId, taskId, attempt, state: status.state, attemptPath, sessionFile, summary: status.message }),
          finalText: run.finalText,
          attemptPath,
          sessionFile,
          operationId: currentOperationId,
        };
      }
    }

    handoff.featureId = featureId;
    handoff.taskId = taskId;
    handoff.summary = sanitizeSummary(handoff.summary);
    handoff.checks = handoff.checks.map((check) => ({ ...check, command: check.command.slice(0, 2_000), evidence: check.evidence ? sanitizeSummary(check.evidence) : undefined }));
    handoff.attempt = attempt;
    handoff.session = { id: run.sessionId, file: sessionFile, eventsFile };
    handoff.createdAt ||= now();
    (handoff as any).boundedContract = { outcome: input.outcome, surface: input.surface, nonGoals: input.nonGoals, verificationCommands: input.verificationCommands, affectedAcceptanceTestIds: input.affectedAcceptanceTestIds, acceptanceChecks: input.acceptanceChecks };
    if (input.mode === "write") {
      const tracked = (await command("git", ["diff", "--name-only"], childCwd)).stdout.split(/\r?\n/).filter(Boolean);
      const staged = (await command("git", ["diff", "--cached", "--name-only"], childCwd)).stdout.split(/\r?\n/).filter(Boolean);
      const untracked = (await command("git", ["ls-files", "--others", "--exclude-standard"], childCwd)).stdout.split(/\r?\n/).filter(Boolean);
      const summaries = new Map(handoff.changedFiles.map((file) => [file.path, file.summary]));
      handoff.changedFiles = [...new Set([...tracked, ...staged, ...untracked])].map((path) => ({
        path,
        summary: summaries.get(path) ?? "Changed by subagent; no description supplied",
      }));
    }
    await atomicJson(handoffPath, handoff);

    let commit: string | undefined;
    let builderEvidence: BuilderEvidence | undefined;
    if (input.mode === "write" && handoff.status === "done") {
      const requirements = loadState(requirementsDir(root, featureId));
      const rawEvidence = await exists(evidencePath) ? await readJson<unknown>(evidencePath) : undefined;
      const evidenceCheck = await validateBuilderEvidence(requirements, rawEvidence, undefined, input.requiredAcceptanceTestIds);
      // Persist only the sanitized, bounded representation even on refusal.
      if (evidenceCheck.evidence) await atomicJson(evidencePath, evidenceCheck.evidence);
      if (!evidenceCheck.valid || !evidenceCheck.evidence) {
        handoff.status = "failed";
        handoff.blockers = [...handoff.blockers, ...evidenceCheck.issues];
        handoff.summary = `Completion evidence refused: ${evidenceCheck.issues.join("; ")}`;
        await atomicJson(handoffPath, handoff);
      } else builderEvidence = evidenceCheck.evidence;
    }
    if (input.mode === "write" && handoff.status === "done") {
      const changes = (await command("git", ["status", "--porcelain"], childCwd)).stdout.trim();
      if (changes && !input.deferCommit) {
        await command("git", ["add", "-A"], childCwd);
        await command("git", ["commit", "-m", `agent-work(${taskId}): ${input.title}`], childCwd);
        commit = (await command("git", ["rev-parse", "HEAD"], childCwd)).stdout.trim();
      }
      if (commit && !input.sharedWorktree) {
        const verification = await runSideEffectFreeVerification(input.verificationCommands, childCwd, signal);
        const requirements = loadState(requirementsDir(root, featureId));
        await atomicJson(join(attemptPath, "declared-verification.json"), { schemaVersion: 1, requirementsRevision: requirements.requirementsRevision, taskId, worktree: childCwd, binding: { kind: "commit", commit, sourceStateHash: verification.postState.hash }, recordedAt: now(), records: verification.records });
        if (verification.failed) { handoff.status = "failed"; handoff.blockers = [...handoff.blockers, "Declared targeted verification failed or mutated source state"]; handoff.summary = "Declared targeted verification failed or mutated source state; review and integration are blocked"; await atomicJson(handoffPath, handoff); }
      }
      if (commit && builderEvidence && handoff.status === "done") {
        builderEvidence.implementationCommit = commit;
        await atomicJson(evidencePath, builderEvidence);
        const requirements = loadState(requirementsDir(root, featureId));
        await writeEvidenceManifest(root, featureId, taskId, attempt, requirements, commit, builderEvidence);
        if (branch && worktree) await registerCbpiWorktree(root, {
          id: `${featureId}-${taskId}-a${attempt}`, featureId, taskId, branch, commit, worktree, collected: false,
        });
      }
    }

    status.state = handoff.status === "done" ? (input.mode === "write" && commit ? "review" : "done") : handoff.status;
    status.commit = commit;
    status.message = handoff.summary;
    await writeStatus(root, status);
    await appendJsonl(join(rootDir(root), "routing-decisions.jsonl"), {
      timestamp: now(), type: "outcome", featureId, taskId, attempt, model: selectedModel,
      state: status.state, durationMs: invocationRecord.durationMs, usage: run.usage,
      correction: attempt > 1, sessionId: coordinatorSessionId,
    });
    await settleRouteOutcome(root, route, featureId, taskId, attempt, status.state);
    await writeIntegrityManifest(root, { featureId, taskId, attempt });
    await monitor.terminal(handoff.status === "done" ? "success" : handoff.status === "blocked" ? "blocked" : "failure", handoff.status === "done" ? "Task completed" : `Task reported ${handoff.status}`);
    return {
      receipt: finalReceipt({ featureId, taskId, attempt, state: status.state, attemptPath, sessionFile, commit, summary: handoff.summary }),
      finalText: run.finalText || handoff.summary,
      attemptPath,
      sessionFile,
      operationId: currentOperationId,
    };
  } catch (error: any) {
    const terminal = monitor.snapshot().terminal;
    status.state = signal?.aborted || terminal === "cancelled" ? "cancelled" : "failed";
    status.message = error?.message ?? String(error);
    await writeStatus(root, status);
    await appendJsonl(join(rootDir(root), "routing-decisions.jsonl"), {
      timestamp: now(), type: "outcome", featureId, taskId, attempt, model: selectedModel,
      state: status.state, correction: attempt > 1, error: status.message, sessionId: coordinatorSessionId,
    });
    await settleRouteOutcome(root, route, featureId, taskId, attempt, status.state);
    await writeIntegrityManifest(root, { featureId, taskId, attempt });
    if (!monitor.isTerminal) await monitor.terminal(signal?.aborted ? "cancelled" : "failure", signal?.aborted ? "Task cancelled" : `${kind} failed; inspect persisted diagnostics`);
    throw error;
  }
}

async function runMultiPerspectiveReview(
  root: string,
  input: {
    featureId: string;
    taskId: string;
    worktree: string;
    depth: CritiqueDepth;
    targetType: CritiqueTargetType;
    model?: string;
    thinking?: string;
    prompt?: string;
    retry?: boolean;
    singlePerspective?: boolean;
  },
  signal: AbortSignal | undefined,
  onProgress?: ProgressCallback,
  monitor?: ProgressMonitor,
): Promise<string> {
  const perspectives = perspectivesFor(input.targetType, input.depth);
  const selectedPerspectives = input.singlePerspective ? perspectives.slice(0, 1) : perspectives;
  const attackFindings: CritiqueFinding[] = [];
  const reviewRootTask = safeId(`${input.taskId}-critique`);

  for (const [perspectiveIndex, perspective] of selectedPerspectives.entries()) {
    if (signal?.aborted) throw new Error("Subagent aborted");
    await monitor?.phaseChange("reviewing", `Reviewing via ${perspective}`, { completed: perspectiveIndex, active: 1, total: selectedPerspectives.length });
    onProgress?.(`Reviewing via ${perspective}`);
    const result = await runTask(root, {
      featureId: input.featureId,
      taskId: `${reviewRootTask}-${perspective}`,
      title: `Critique ${input.taskId} (${perspective})`,
      prompt: [
        input.prompt ?? `Adversarially critique task ${input.taskId} in this worktree.`,
        "",
        `Perspective: ${perspective}`,
        perspectivePrompt(perspective, input.targetType),
        "",
        "Read the relevant files/diff. Produce severity-grouped findings with `file:line` citations.",
        "Minimum 2 findings. Prefer honest lows over inflated severity.",
        'Return only structured JSON: {"findings":[{"severity":"critical|high|medium|low","category":"...","location":"file:line","description":"..."}]}. Include findings: [] explicitly when clean.',
      ].join("\n"),
      mode: "read",
      profile: `critique-${perspective}`,
      dependsOn: [input.taskId],
      model: input.model,
      thinking: input.thinking,
      retry: input.retry,
      outcome: `Critique ${input.taskId} from one perspective`,
      surface: ["review-target-diff"],
      nonGoals: ["Do not modify implementation files"],
      verificationCommands: ["git diff --check"],
      cwdOverride: input.worktree,
      skipRequirementsGate: true,
      systemExtra: "You are a critique attacker. Stay in your assigned perspective.",
    }, signal, onProgress);
    attackFindings.push(...parseFindings(result.finalText, perspective));
    await monitor?.milestone(`Completed ${perspective} review`, { completed: perspectiveIndex + 1, active: 0, total: selectedPerspectives.length });
  }

  let findings = dedupeFindings(attackFindings);
  const dropped: CritiqueFinding[] = [];
  const verifyPool = findings
    .filter((f) => f.severity === "critical" || f.severity === "high")
    .slice(0, 10);

  for (const [index, finding] of verifyPool.entries()) {
    if (signal?.aborted) throw new Error("Subagent aborted");
    await monitor?.phaseChange("verifying", `Verifying finding ${index + 1}/${verifyPool.length}`, { completed: index, active: 1, total: verifyPool.length });
    onProgress?.(`Verifying ${finding.severity} finding ${index + 1}/${verifyPool.length}`);
    const result = await runTask(root, {
      featureId: input.featureId,
      taskId: `${reviewRootTask}-verify-${index + 1}`,
      title: `Verify finding ${index + 1}`,
      prompt: [
        "Independently verify this ONE finding by reading the actual target. Do not invent new findings.",
        "",
        `Severity: ${finding.severity}`,
        `Location: ${finding.location}`,
        `Description: ${finding.description}`,
        finding.impact ? `Impact: ${finding.impact}` : "",
        "",
        "Return exactly:",
        "**Verdict**: confirmed | false-positive | uncertain",
        "**Evidence**: 2-4 sentences with at least one file:line citation",
      ].filter(Boolean).join("\n"),
      mode: "read",
      profile: "critique-verifier",
      dependsOn: [input.taskId],
      model: input.model,
      thinking: input.thinking,
      retry: true,
      outcome: `Verify one reported finding`,
      surface: ["reported-finding-location"],
      nonGoals: ["Do not modify implementation files"],
      verificationCommands: ["git diff --check"],
      cwdOverride: input.worktree,
      skipRequirementsGate: true,
    }, signal, onProgress);
    const verdict = parseVerdict(result.finalText);
    // Security clamp: never drop security findings as false-positive.
    if (verdict.verdict === "false-positive" && finding.perspectives.includes("security")) {
      finding.verification = { verdict: "uncertain", note: `security-clamp: ${verdict.note}` };
      continue;
    }
    if (verdict.verdict === "false-positive" && !(/`[^`]+`/.test(verdict.note) || /\w+:\d+/.test(verdict.note))) {
      finding.verification = { verdict: "uncertain", note: `invalid false-positive without citation: ${verdict.note}` };
      continue;
    }
    finding.verification = { verdict: verdict.verdict, note: verdict.note };
    if (verdict.verdict === "false-positive") dropped.push(finding);
    await monitor?.milestone(`Verified finding ${index + 1}/${verifyPool.length}`, { completed: index + 1, active: 0, total: verifyPool.length });
  }

  findings = findings.filter((f) => f.verification?.verdict !== "false-positive");
  const report = renderCritiqueReport({
    target: `${input.featureId}/${input.taskId}`,
    depth: input.depth,
    findings,
    dropped,
  });
  const outDir = join(featureDir(root, input.featureId), "tasks", safeId(input.taskId), "critique");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "latest.md"), report, "utf8");
  await atomicJson(join(outDir, "latest.json"), { findings, dropped, depth: input.depth });
  return `${report}\n\nSaved: ${join(outDir, "latest.md")}`;
}

async function reviewTaskForRun(root: string, featureId: string, task: RunTaskDeclaration, signal: AbortSignal, mode: "focused" | "broad" = "focused", checkpointMembers = [task.id], affectedAcceptanceTestIds?: string[], turnAcceptanceTestIds: Record<string, string[] | undefined> = {}, turnAcceptanceChecks: Record<string, Array<{ testId: string; command: string }> | undefined> = {}): Promise<{ approved: boolean; corrections?: number }> {
  const source = await readStatus(root, featureId, task.id);
  if (!source.worktree || !source.commit) throw new Error("Writing task is missing an isolated commit");
  const requirements = loadState(requirementsDir(root, source.featureId));
  const mergedEvidence: BuilderEvidence = { schemaVersion: 2, requirementsRevision: requirements.requirementsRevision, implementationCommit: source.commit, tests: [] };
  for (const memberId of checkpointMembers) {
    const memberStatus = await readStatus(root, featureId, memberId);
    const requiredIds = turnAcceptanceTestIds[memberId] ?? affectedAcceptanceTestIds;
    const evidencePath = join(attemptDir(root, featureId, memberId, memberStatus.currentAttempt), "evidence.json");
    const evidenceCheck = await validateBuilderEvidence(requirements, await readJson<unknown>(evidencePath), memberId === task.id ? source.commit : undefined, requiredIds);
    if (!evidenceCheck.valid || !evidenceCheck.evidence) throw new Error(`Review refused invalid targeted evidence for checkpoint turn ${memberId}: ${evidenceCheck.issues.join("; ")}`);
    for (const test of evidenceCheck.evidence.tests) {
      const prior = mergedEvidence.tests.findIndex((item) => item.testId === test.testId);
      if (prior >= 0) mergedEvidence.tests[prior] = test; else mergedEvidence.tests.push(test);
    }
  }
  await runMultiPerspectiveReview(root, {
    featureId: source.featureId,
    taskId: task.id,
    worktree: source.worktree,
    depth: mode === "broad" ? "deep" : "standard",
    singlePerspective: mode === "focused",
    targetType: "code",
    retry: true,
  }, signal);
  const critique = await readJson<{ findings?: Array<{ severity: "critical" | "high" | "medium" | "low"; description: string; verification?: { verdict?: string } }> }>(join(taskDir(root, source.featureId, task.id), "critique", "latest.json"));
  const findings: VerificationFinding[] = (critique.findings ?? []).map((item) => ({
    severity: item.severity,
    status: item.verification?.verdict === "false-positive" ? "false-positive" : "open",
    summary: sanitizeSummary(item.description),
  }));
  const canonicalCommands = new Map<string, string>();
  for (const memberId of checkpointMembers) {
    const ids = turnAcceptanceTestIds[memberId] ?? [];
    const checks = turnAcceptanceChecks[memberId];
    if (!ids.length || !checks?.length || checks.length !== ids.length || checks.some((check) => !ids.includes(check.testId))) throw new Error(`Checkpoint member ${memberId} lacks complete persisted acceptanceChecks; resubmit with canonical mapping`);
    for (const check of checks) {
      const prior = canonicalCommands.get(check.testId);
      if (prior && prior !== check.command) throw new Error(`Checkpoint acceptance mapping conflicts for ${check.testId}`);
      canonicalCommands.set(check.testId, check.command);
    }
  }
  if ((affectedAcceptanceTestIds ?? []).some((testId) => !canonicalCommands.has(testId))) throw new Error("Checkpoint acceptance mapping does not cover the full affected-test union");
  const verification = await rerunAcceptanceTests(requirements, mergedEvidence, source.worktree, source.commit, findings, { signal, testIds: affectedAcceptanceTestIds, canonicalCommands, requireCanonicalCommands: true });
  await writeVerificationReport(join(taskDir(root, source.featureId, task.id), "verification-report.json"), verification);
  return { approved: verification.approved, corrections: findings.filter((finding) => finding.status === "open").length };
}

async function integrateTaskForRun(root: string, featureId: string, task: RunTaskDeclaration, signal: AbortSignal, affectedAcceptanceTestIds?: string[]): Promise<{ combinedCoordinatorCommit: string }> {
  const status = await readStatus(root, featureId, task.id);
  if (status.state === "integrated") return { combinedCoordinatorCommit: (await command("git", ["rev-parse", "HEAD"], root)).stdout.trim() };
  if (status.state !== "review" || !status.commit) throw new Error("Task is not ready for gated integration");
  const requirements = loadState(requirementsDir(root, featureId));
  const verificationPath = join(taskDir(root, featureId, task.id), "verification-report.json");
  const verification = await exists(verificationPath) ? await readJson<unknown>(verificationPath) : undefined;
  const blockers = integrationBlockers(requirements, status.commit, verification, affectedAcceptanceTestIds);
  if (blockers.length) throw new Error(`Integration verification gate refused the checkpoint: ${blockers.join("; ")}`);
  const taskRecord = await readTask(root, featureId, task.id);
  for (const dependency of taskRecord.dependsOn) {
    const dependencyStatus = await readStatus(root, featureId, dependency);
    if (!["done", "integrated"].includes(dependencyStatus.state)) throw new Error("Integration dependency gate refused the task");
  }
  const integrationRecordPath = join(attemptDir(root, featureId, task.id, status.currentAttempt), "integration-attempt.json");
  const integration = await cherryPickOrReuse(root, status.commit, integrationRecordPath, signal);
  const coordinatorCommit = integration.coordinatorCommit;
  try {
    await assertClean(root);
    if (/^agent-work\/.+\/a\d+$/.test(status.branch ?? "")) await markCbpiWorktreeCollected(root, `${featureId}-${task.id}-a${status.currentAttempt}`, { sourceCommit: status.commit, coordinatorCommit: integration.patchEquivalentCommit }).catch((error) => { throw new Error(`post-cherry-pick collection proof failed: ${error?.message ?? error}`); });
    if (/^agent-work\/.+\/a\d+$/.test(status.branch ?? "")) await compactSuccessfulAttempt(root, { featureId, taskId: task.id, attempt: status.currentAttempt }, { integrated: true }).catch((error) => { throw new Error(`post-cherry-pick compaction failed: ${error?.message ?? error}`); });
    await reconcileCbpiLifecycle(root, {}).catch((error) => { throw new Error(`post-cherry-pick lifecycle reconciliation failed: ${error?.message ?? error}`); });
  } catch (error: any) {
    const record = await readJson<IntegrationAttemptRecord>(integrationRecordPath);
    record.status = "blocked"; record.reason = sanitizeSummary(error?.message ?? String(error)); record.retryGuidance = "Repair the recorded integration bookkeeping failure and retry; the existing patch-equivalent commit will be reused without another cherry-pick."; record.updatedAt = now(); await atomicJson(integrationRecordPath, record);
    throw error;
  }
  status.state = "integrated";
  status.message = `Integrated ${status.commit}`;
  await writeStatus(root, status);
  await appendJsonl(join(featureDir(root, featureId), "decisions.jsonl"), { timestamp: now(), type: "integration", taskId: task.id, commit: status.commit, coordinatorCommit });
  return { combinedCoordinatorCommit: coordinatorCommit };
}

export async function executeExactCommitFinalGate(
  root: string,
  context: { runId: string; featureId: string; combinedCoordinatorCommit: string; signal: AbortSignal },
  tasks: RunTaskDeclaration[],
  paths: { reportFile: string; manifestFile: string },
  options: { independentReview?: (input: { root: string; featureId: string; runId: string; task: RunTaskDeclaration; commit: string; signal: AbortSignal }) => Promise<VerificationFinding[]> } = {},
): Promise<{ combinedCoordinatorCommit: string; passed: boolean; evidenceComplete: boolean; findings: VerificationFinding[]; reportPath: string; manifestPath?: string; reason?: string }> {
  const reportFile = paths.reportFile;
  const requirements = loadState(requirementsDir(root, context.featureId));
  const baseReport = {
    schemaVersion: 2,
    requirementsRevision: requirements.requirementsRevision,
    reviewedCommit: context.combinedCoordinatorCommit,
    generatedAt: now(),
    layers: requirements.testingStandards.fidelity.map((layer) => ({ layer: layer.name, applicable: layer.applicable, rationale: layer.rationale, status: "pending", testIds: [] as string[] })),
  };
  try {
    return await withRootLock(root, async () => {
    const head = (await command("git", ["rev-parse", "HEAD"], root, context.signal)).stdout.trim();
    const initialStatus = (await command("git", ["status", "--porcelain"], root, context.signal)).stdout;
    const workspaceBlockers = finalWorkspaceBlockers(context.combinedCoordinatorCommit, head, initialStatus);
    if (workspaceBlockers.length) {
      const reason = workspaceBlockers.join("; ");
      await atomicJson(reportFile, { ...baseReport, tests: [], findings: [], evidenceComplete: false, approved: false, executorStatus: "blocked", reason });
      return { combinedCoordinatorCommit: head, passed: false, evidenceComplete: false, findings: [], reportPath: reportFile, reason };
    }
    const merged: BuilderEvidence = { schemaVersion: 2, requirementsRevision: requirements.requirementsRevision, implementationCommit: context.combinedCoordinatorCommit, tests: [] };
    for (const task of tasks.filter((item) => item.mode === "write")) {
      const status = await readStatus(root, context.featureId, task.id);
      const evidencePath = join(attemptDir(root, context.featureId, task.id, status.currentAttempt), "evidence.json");
      const checked = await validateBuilderEvidence(requirements, await readJson<unknown>(evidencePath), undefined, task.affectedAcceptanceTestIds);
      if (!checked.valid || !checked.evidence) throw new Error(`missing or stale targeted evidence for ${task.id}: ${checked.issues.join("; ")}`);
      for (const test of checked.evidence.tests) {
        const prior = merged.tests.findIndex((item) => item.testId === test.testId);
        if (prior >= 0) merged.tests[prior] = test; else merged.tests.push(test);
      }
    }
    const complete = await validateBuilderEvidence(requirements, merged, context.combinedCoordinatorCommit);
    if (!complete.valid || !complete.evidence) throw new Error(`final acceptance command evidence is incomplete: ${complete.issues.join("; ")}`);
    const finalTask = tasks.filter((item) => item.mode === "write").at(-1);
    if (!finalTask) throw new Error("final gate requires at least one integrated writing checkpoint");
    let findings: VerificationFinding[];
    if (options.independentReview) {
      findings = await options.independentReview({ root, featureId: context.featureId, runId: context.runId, task: finalTask, commit: context.combinedCoordinatorCommit, signal: context.signal });
    } else {
      await runMultiPerspectiveReview(root, {
        featureId: context.featureId,
        taskId: finalTask.id,
        worktree: root,
        depth: "deep",
        targetType: "code",
        retry: true,
        prompt: `Independently review the exact combined coordinator commit ${context.combinedCoordinatorCommit}. Inspect the integrated feature as a whole and report unresolved findings.`,
      }, context.signal);
      const critique = await readJson<{ findings?: Array<{ severity: "critical" | "high" | "medium" | "low"; description: string; verification?: { verdict?: string } }> }>(join(taskDir(root, context.featureId, finalTask.id), "critique", "latest.json"));
      findings = (critique.findings ?? []).map((item) => ({
        severity: item.severity,
        status: item.verification?.verdict === "false-positive" ? "false-positive" : "open",
        summary: sanitizeSummary(item.description),
      }));
    }
    const canonicalCommands = new Map<string, string>();
    for (const task of tasks.filter((item) => item.mode === "write")) {
      const ids = task.affectedAcceptanceTestIds;
      if (!ids?.length || !task.acceptanceChecks?.length) throw new Error(`task ${task.id} lacks persisted acceptanceChecks; legacy run is blocked and must be resubmitted with an explicit coordinator mapping`);
      if (task.acceptanceChecks.length !== ids.length || task.acceptanceChecks.some((check) => !ids.includes(check.testId))) throw new Error(`task ${task.id} acceptanceChecks do not exactly cover its affected acceptance tests`);
      for (const check of task.acceptanceChecks) {
        const prior = canonicalCommands.get(check.testId);
        if (prior && prior !== check.command) throw new Error(`conflicting coordinator acceptance mapping for ${check.testId}; resubmit with one canonical command`);
        canonicalCommands.set(check.testId, check.command);
      }
    }
    if (requirements.acceptanceTests.some((test) => !canonicalCommands.has(test.id))) throw new Error("final gate lacks complete coordinator-declared acceptance command coverage");
    for (const test of requirements.acceptanceTests) {
      const command = canonicalCommands.get(test.id)!;
      const actual = commandFidelity(command);
      if (!actual || (actual !== test.fidelityLayer && !(test.fidelityLayer === "realistic-smoke" && actual === "integration"))) throw new Error(`canonical command for ${test.id} cannot satisfy required ${test.fidelityLayer} fidelity at final execution`);
    }
    const verification = await rerunAcceptanceTests(requirements, complete.evidence, root, context.combinedCoordinatorCommit, findings, { signal: context.signal, canonicalCommands, requireCanonicalCommands: true, isolateExactCommit: true });
    const endingHead = (await command("git", ["rev-parse", "HEAD"], root, context.signal)).stdout.trim();
    const endingStatus = (await command("git", ["status", "--porcelain"], root, context.signal)).stdout;
    const endingWorkspaceBlockers = finalWorkspaceBlockers(context.combinedCoordinatorCommit, endingHead, endingStatus);
    const fidelity = assessFidelityLayers(requirements, verification.tests);
    const finalBlockers = [...endingWorkspaceBlockers, ...fidelity.blockers];
    if (finalBlockers.length) { verification.approved = false; verification.evidenceComplete = false; }
    const acceptanceRecords: EvidenceRecord[] = verification.tests.map((test) => {
      const declared = canonicalAcceptanceProvenance(requirements.acceptanceTests, test.testId);
      return { id: `final-${declared.recordId}`, command: test.command ?? `approved-exception:${test.testId}`, commandIdentity: "", kind: "full-suite", requirementsRevision: requirements.requirementsRevision, commit: context.combinedCoordinatorCommit, environment: test.startingSnapshotHash ? `disposable exact-commit worktree; starting snapshot ${test.startingSnapshotHash}` : "approved exception", result: evidenceResultForVerificationStatus(test.status), fidelity: declared.fidelity, scenarios: declared.scenarios, freshness: "fresh", ...(test.startingSnapshotHash ? { sourceStateHash: test.startingSnapshotHash } : {}) };
    });
    const layerRecords: EvidenceRecord[] = fidelity.layers.map((layer) => ({ id: `final-layer-${layer.layer}`, command: `fidelity-layer:${layer.layer}`, commandIdentity: "", kind: "full-suite", requirementsRevision: requirements.requirementsRevision, commit: context.combinedCoordinatorCommit, environment: layer.rationale, result: evidenceResultForLayerStatus(layer.status), fidelity: layer.layer, scenarios: [], freshness: "fresh", declaredStatus: layer.status }));
    const finalManifest = createEvidenceManifest({ requirementsRevision: requirements.requirementsRevision, commit: context.combinedCoordinatorCommit, records: [...acceptanceRecords, ...layerRecords] });
    const finalManifestPath = paths.manifestFile;
    await atomicJson(finalManifestPath, finalManifest);
    await atomicJson(reportFile, { ...verification, layers: fidelity.layers, evidenceManifest: { path: finalManifestPath, sha256: finalManifest.manifestHash }, executorStatus: "complete", ...(finalBlockers.length ? { reason: finalBlockers.join("; ") } : {}) });
    return { combinedCoordinatorCommit: endingHead, passed: verification.approved, evidenceComplete: verification.evidenceComplete, findings, reportPath: reportFile, manifestPath: finalManifestPath, reason: verification.approved ? undefined : `final gate blocked: ${finalBlockers.join("; ") || "review, acceptance tests, or severe findings failed"}; inspect report and rerun` };
    });
  } catch (error: any) {
    if (context.signal.aborted) throw error;
    const reason = sanitizeSummary(error?.message ?? String(error));
    await atomicJson(reportFile, { ...baseReport, tests: [], findings: [], evidenceComplete: false, approved: false, executorStatus: "failed", reason });
    return { combinedCoordinatorCommit: context.combinedCoordinatorCommit, passed: false, evidenceComplete: false, findings: [], reportPath: reportFile, reason: `final gate executor failed: ${reason}; correct evidence/infrastructure and rerun` };
  }
}

export async function executeFeatureFinalGate(
  root: string,
  context: { runId: string; featureId: string; combinedCoordinatorCommit: string; signal: AbortSignal },
  options: { independentReview?: (input: { root: string; featureId: string; runId: string; task: RunTaskDeclaration; commit: string; signal: AbortSignal }) => Promise<VerificationFinding[]> } = {},
): Promise<{ combinedCoordinatorCommit: string; passed: boolean; evidenceComplete: boolean; findings: VerificationFinding[]; reportPath: string; manifestPath?: string; reason?: string }> {
  const runDir = join(featureDir(root, context.featureId), "runs", safeId(context.runId));
  const graph = await readJson<RunDeclaration>(join(runDir, "graph.json"));
  return executeExactCommitFinalGate(root, context, graph.tasks, {
    reportFile: join(runDir, "final-verification-report.json"),
    manifestFile: join(runDir, "synthetic-final-evidence-manifest.json"),
  }, options);
}

export interface DirectFinalGateRecord {
  schemaVersion: 1;
  status: "pending" | "running" | "passed" | "blocked";
  requirementsRevision: string;
  sourceCommit: string;
  preIntegrationCommit: string;
  coordinatorCommit?: string;
  canonicalMappings: Array<{ testId: string; command: string }>;
  reportRef?: { path: string; commit: string };
  manifestRef?: { path: string; sha256: string; commit: string };
  retryGuidance?: string;
  reason?: string;
  updatedAt: string;
}

export async function executeDirectFinalIntegration(
  root: string,
  featureId: string,
  taskId: string,
  signal: AbortSignal,
  options: { independentReview?: Parameters<typeof executeExactCommitFinalGate>[4]["independentReview"] } = {},
): Promise<{ sourceCommit: string; coordinatorCommit: string; gate: DirectFinalGateRecord }> {
  const status = await readStatus(root, featureId, taskId);
  const attemptPath = attemptDir(root, featureId, taskId, status.currentAttempt);
  const gatePath = join(attemptPath, "direct-final-gate.json");
  const prior = await exists(gatePath) ? await readJson<DirectFinalGateRecord>(gatePath) : undefined;
  if (status.state === "integrated" && prior?.status === "passed" && prior.coordinatorCommit) return { sourceCommit: prior.sourceCommit, coordinatorCommit: prior.coordinatorCommit, gate: prior };
  if (status.state !== "review" || !status.commit) throw new Error(`Task must be in review state, currently: ${status.state}`);
  const requirements = loadState(requirementsDir(root, featureId));
  const task = await readTask(root, featureId, taskId);
  const handoff = await exists(join(attemptPath, "handoff.json")) ? await readJson<{ boundedContract?: { affectedAcceptanceTestIds?: string[]; acceptanceChecks?: Array<{ testId: string; command: string }> } }>(join(attemptPath, "handoff.json")) : undefined;
  const affectedAcceptanceTestIds = task.affectedAcceptanceTestIds ?? handoff?.boundedContract?.affectedAcceptanceTestIds;
  const mappings = task.acceptanceChecks ?? handoff?.boundedContract?.acceptanceChecks ?? [];
  const expectedIds = requirements.acceptanceTests.map((test) => test.id);
  if (!affectedAcceptanceTestIds?.length || mappings.length !== expectedIds.length || new Set(mappings.map((item) => item.testId)).size !== mappings.length || expectedIds.some((id) => !mappings.some((item) => item.testId === id))) {
    throw new Error("Direct final gate requires persisted canonical acceptanceChecks covering every acceptance test; resubmit the direct task with complete mappings");
  }
  for (const mapping of mappings) {
    const required = requirements.acceptanceTests.find((test) => test.id === mapping.testId)!.fidelityLayer;
    const actual = commandFidelity(mapping.command);
    if (!actual || (required !== actual && !(required === "realistic-smoke" && actual === "integration"))) throw new Error(`canonical command for ${mapping.testId} cannot satisfy required ${required} fidelity`);
  }
  const highRisk = await taskIsHighRisk(root, featureId, taskId, status.currentAttempt);
  const blockers = await finalIntegrationBlockers(root, featureId, taskId, status.currentAttempt, requirements, status.commit, highRisk);
  if (blockers.length) throw new Error(`Integration refused:\n- ${blockers.join("\n- ")}`);
  for (const dependency of task.dependsOn) {
    const dependencyStatus = await readStatus(root, featureId, dependency);
    if (!["done", "integrated"].includes(dependencyStatus.state)) throw new Error(`Dependency ${dependency} is not complete: ${dependencyStatus.state}`);
  }
  let gate = prior;
  const head = (await command("git", ["rev-parse", "HEAD"], root, signal)).stdout.trim();
  if (!gate) gate = { schemaVersion: 1, status: "pending", requirementsRevision: requirements.requirementsRevision, sourceCommit: status.commit, preIntegrationCommit: head, canonicalMappings: mappings, retryGuidance: "Retry agent_integrate after correcting any reported integration/final-gate failure; patch-equivalent commits are reused without another cherry-pick.", updatedAt: now() };
  if (gate.sourceCommit !== status.commit || gate.requirementsRevision !== requirements.requirementsRevision) throw new Error("Persisted direct final gate is stale for the current task commit or requirements revision");
  if (!gate.coordinatorCommit) gate.preIntegrationCommit = head;
  gate.status = "pending"; gate.reason = undefined; gate.updatedAt = now(); await atomicJson(gatePath, gate);
  const integrationRecordPath = join(attemptPath, "integration-attempt.json");
  try {
    const integration = await cherryPickOrReuse(root, status.commit, integrationRecordPath, signal);
    gate.coordinatorCommit = integration.coordinatorCommit;
    gate.status = "running"; gate.updatedAt = now(); await atomicJson(gatePath, gate);
  } catch (error: any) {
    const integrationRecord = await readJson<IntegrationAttemptRecord>(integrationRecordPath).catch(() => undefined);
    gate.status = "blocked"; gate.coordinatorCommit = undefined; gate.reason = integrationRecord?.reason ?? sanitizeSummary(error?.message ?? String(error)); gate.retryGuidance = integrationRecord?.retryGuidance ?? "Restore a clean coordinator worktree and retry integration."; gate.updatedAt = now(); await atomicJson(gatePath, gate);
    throw error;
  }
  const finalTask = { ...task, affectedAcceptanceTestIds, acceptanceChecks: mappings, outcome: `Complete direct task ${taskId}`, surface: ["direct-task-commit"], nonGoals: ["Do not modify unrelated paths"], verificationCommands: ["git diff --check"] } as RunTaskDeclaration;
  const reportFile = join(attemptPath, "direct-final-verification-report.json");
  const manifestFile = join(attemptPath, "direct-final-evidence-manifest.json");
  const result = await executeExactCommitFinalGate(root, { runId: `direct-${taskId}-a${status.currentAttempt}`, featureId, combinedCoordinatorCommit: gate!.coordinatorCommit!, signal }, [finalTask], { reportFile, manifestFile }, options);
  gate!.reportRef = { path: result.reportPath, commit: gate!.coordinatorCommit! };
  if (result.manifestPath && await exists(result.manifestPath)) {
    const manifest = await readJson<{ manifestHash: string }>(result.manifestPath);
    gate!.manifestRef = { path: result.manifestPath, sha256: manifest.manifestHash, commit: gate!.coordinatorCommit! };
  }
  if (result.passed && result.evidenceComplete && result.combinedCoordinatorCommit === gate!.coordinatorCommit) {
    gate!.status = "passed"; gate!.reason = undefined; gate!.retryGuidance = undefined;
    status.state = "integrated"; status.message = `Integrated ${status.commit} after exact-commit direct final gate`;
    await writeStatus(root, status);
    await appendJsonl(join(featureDir(root, featureId), "decisions.jsonl"), { timestamp: now(), type: "direct-final-integration", taskId, commit: status.commit, coordinatorCommit: gate!.coordinatorCommit, reportPath: result.reportPath, manifestPath: result.manifestPath });
  } else {
    await withRootLock(root, async () => {
      await command("git", ["reset", "--hard", gate!.coordinatorCommit!], root);
      await command("git", ["clean", "-fd"], root);
      await assertClean(root);
    });
    gate!.status = "blocked";
    gate!.reason = result.reason ?? "Direct final gate failed";
    gate!.retryGuidance = "Inspect the persisted report, correct the failure, then retry agent_integrate; the recorded cherry-pick will not be repeated.";
  }
  gate!.updatedAt = now(); await atomicJson(gatePath, gate);
  if (gate!.status !== "passed") throw new Error(`Direct final gate blocked integration: ${gate!.reason} ${gate!.retryGuidance}`);
  return { sourceCommit: status.commit, coordinatorCommit: gate!.coordinatorCommit!, gate: gate! };
}

export interface ProductionExecutorTestHooks {
  /** Deterministic child-process seam for production lifecycle harnesses; omitted in normal wiring. */
  taskRunner?: typeof runTask;
  checkpointReviewer?: RunExecutor["review"];
  finalReviewer?: Parameters<typeof executeFeatureFinalGate>[2]["independentReview"];
}

export function executorForRoot(root: string, featureId: string, hooks: ProductionExecutorTestHooks = {}): RunExecutor {
  const checkpoints = new Map<string, CheckpointWorkspaceMetadata>();
  const checkpointWorkspace = async (checkpointId: string, runId: string): Promise<CheckpointWorkspaceMetadata> => {
    const key = `${runId}\0${checkpointId}`;
    const existing = checkpoints.get(key); if (existing) return existing;
    const checkpointDir = join(featureDir(root, featureId), "runs", safeId(runId), "checkpoints", safeId(checkpointId));
    const metadataPath = join(checkpointDir, "workspace.json");
    const expectedWorktree = join(checkpointDir, "worktree");
    const expectedBranch = `agent-work/${safeId(featureId)}/run-${safeId(runId)}-${safeId(checkpointId)}`;
    if (await exists(metadataPath)) {
      const persisted = await readJson<CheckpointWorkspaceMetadata>(metadataPath);
      const metadataIssues = checkpointWorkspaceMetadataIssues(persisted, { worktree: expectedWorktree, branch: expectedBranch });
      if (metadataIssues.length) throw new Error(`Persisted checkpoint workspace is invalid: ${metadataIssues.join("; ")}; repair before resume`);
      const actualRoot = (await command("git", ["rev-parse", "--show-toplevel"], persisted.worktree)).stdout.trim();
      const actualBranch = (await command("git", ["branch", "--show-current"], persisted.worktree)).stdout.trim();
      const identityIssues = checkpointWorkspaceMetadataIssues(persisted, { worktree: expectedWorktree, branch: expectedBranch }, { worktree: actualRoot, branch: actualBranch });
      if (identityIssues.length) throw new Error(`Persisted checkpoint workspace is invalid: ${identityIssues.join("; ")}; repair before resume`);
      checkpoints.set(key, persisted); return persisted;
    }
    const baseCommit = (await command("git", ["rev-parse", "HEAD"], root)).stdout.trim();
    await withRootLock(root, async () => {
      await assertClean(root);
      await command("git", ["worktree", "add", "-b", expectedBranch, expectedWorktree, baseCommit], root);
      await atomicJson(metadataPath, { schemaVersion: 1, worktree: expectedWorktree, branch: expectedBranch, baseCommit });
    });
    const created: CheckpointWorkspaceMetadata = { schemaVersion: 1, worktree: expectedWorktree, branch: expectedBranch, baseCommit };
    checkpoints.set(key, created); return created;
  };
  return {
    async delegate(task, context) {
      const alreadyExists = await exists(join(taskDir(root, featureId, task.id), "task.json"));
      const started = Date.now();
      const workspace = task.mode === "write" && context.checkpointId ? await checkpointWorkspace(context.checkpointId, context.runId) : undefined;
      await (hooks.taskRunner ?? runTask)(root, {
        featureId,
        taskId: task.id,
        title: task.title,
        prompt: `${task.prompt}\n\nDeclared bounded-work contract (coordinator-owned; do not reinterpret):\nOutcome: ${task.outcome}\nAllowed surface:\n${task.surface.map((item) => `- ${item}`).join("\n")}\nNon-goals:\n${task.nonGoals.map((item) => `- ${item}`).join("\n")}\nRequired verification commands (the coordinator executes these after your turn; do not claim substitutes):\n${task.verificationCommands.map((item) => `- ${item}`).join("\n")}`,
        mode: task.mode,
        profile: task.profile ?? (task.mode === "write" ? "worker" : "scout"),
        dependsOn: task.dependsOn,
        model: task.model,
        thinking: task.thinking,
        complexity: task.complexity,
        risk: task.risk,
        prefer: task.prefer,
        retry: alreadyExists || context.retry,
        sharedWorktree: workspace?.worktree,
        deferCommit: Boolean(workspace),
        requiredAcceptanceTestIds: task.affectedAcceptanceTestIds,
        affectedAcceptanceTestIds: task.affectedAcceptanceTestIds,
        acceptanceChecks: task.acceptanceChecks,
      }, context.signal);
      const status = await readStatus(root, featureId, task.id);
      let verifiedPostState: SourceStateSnapshot | undefined;
      if (task.mode === "write" && ["done", "review", "integrated"].includes(status.state)) {
        const verificationWorktree = workspace?.worktree ?? status.worktree;
        if (!verificationWorktree) throw new Error(`Declared verification for ${task.id} requires its writing worktree`);
        const requirements = loadState(requirementsDir(root, featureId));
        const verification = await runSideEffectFreeVerification(task.verificationCommands, verificationWorktree, context.signal);
        verifiedPostState = verification.postState;
        const binding = verifiedPostState.dirty
          ? { kind: "preseal", head: verifiedPostState.head, patchHash: verifiedPostState.hash }
          : { kind: "commit", commit: verifiedPostState.head, sourceStateHash: verifiedPostState.hash };
        await atomicJson(join(attemptDir(root, featureId, task.id, status.currentAttempt), "declared-verification.json"), { schemaVersion: 1, requirementsRevision: requirements.requirementsRevision, taskId: task.id, ...(context.checkpointId ? { checkpointId: context.checkpointId } : {}), worktree: verificationWorktree, binding, recordedAt: now(), records: verification.records });
        if (verification.failed) throw new Error(`Declared verification command failed or mutated source state for ${task.id}; inspect sanitized declared-verification.json, restore the source state, and rerun`);
      }
      let checkpointReview: { mode: "focused" | "broad"; rationale: string } | undefined;
      if (workspace && context.checkpointFinal && status.state === "done") {
        const changes = (await command("git", ["status", "--porcelain"], workspace.worktree)).stdout.trim();
        const committedRange = (await command("git", ["diff", "--name-only", workspace.baseCommit, "HEAD"], workspace.worktree)).stdout.trim();
        if (!changes && !committedRange) {
          status.state = "blocked"; status.message = "Writing checkpoint produced no implementation commit; review, integration, and final gate are blocked"; await writeStatus(root, status);
          return { outcome: "blocked", durationMs: Date.now() - started };
        }
        if (!verifiedPostState) throw new Error("Checkpoint sealing requires successful source-state-bound targeted verification");
        const presealState = await sourceStateSnapshot(workspace.worktree, context.signal);
        if (presealState.hash !== verifiedPostState.hash) throw new Error(`Checkpoint source state changed after targeted verification (${verifiedPostState.hash} -> ${presealState.hash}); rerun verification before sealing`);
        // Always rewrite the complete base-relative checkpoint into one reviewed commit. This keeps retries/amendments atomic.
        await command("git", ["reset", "--soft", workspace.baseCommit], workspace.worktree);
        await command("git", ["add", "-A"], workspace.worktree);
        await command("git", ["commit", "-m", `agent-work(${context.checkpointId}): checkpoint`], workspace.worktree);
        const commit = (await command("git", ["rev-parse", "HEAD"], workspace.worktree)).stdout.trim();
        if (commit === workspace.baseCommit) throw new Error("Writing checkpoint has no implementation commit");
        try {
          const files = (await command("git", ["diff", "--name-only", workspace.baseCommit, commit], workspace.worktree)).stdout.split(/\r?\n/).filter(Boolean);
          const allowedSurface = task.checkpointSurface ?? task.surface;
          const outside = files.filter((path) => !allowedSurface.some((surface) => surface.endsWith("/") ? path.startsWith(surface) : path === surface));
          if (outside.length) {
            status.state = "blocked"; status.message = `Checkpoint changed paths outside declared allowedSurface: ${outside.join(", ")}`;
            await writeStatus(root, status);
            return { outcome: "blocked", durationMs: Date.now() - started };
          }
          const diff = (await command("git", ["diff", "--unified=0", workspace.baseCommit, commit], workspace.worktree)).stdout;
          const sealedSurface = classifyChangedSurfaceFromDiff({ files, diff });
          checkpointReview = selectSealedCheckpointReview(task.reviewTriggers, sealedSurface.kinds, true);
        } catch {
          checkpointReview = selectSealedCheckpointReview(task.reviewTriggers, [], false);
        }
        status.commit = commit; status.branch = workspace.branch; status.worktree = workspace.worktree; status.state = "review";
        const requirements = loadState(requirementsDir(root, featureId));
        const evidencePath = join(attemptDir(root, featureId, task.id, status.currentAttempt), "evidence.json");
        const evidenceCheck = await validateBuilderEvidence(requirements, await readJson<unknown>(evidencePath), undefined, task.affectedAcceptanceTestIds);
        if (!evidenceCheck.valid || !evidenceCheck.evidence) throw new Error("Checkpoint final turn has invalid targeted-check evidence");
        evidenceCheck.evidence.implementationCommit = commit;
        await atomicJson(evidencePath, evidenceCheck.evidence);
        await writeEvidenceManifest(root, featureId, task.id, status.currentAttempt, requirements, commit, evidenceCheck.evidence);
        await writeStatus(root, status);
      }
      let cost = 0;
      try {
        const invocation = await readJson<InvocationRecord>(join(attemptDir(root, featureId, task.id, status.currentAttempt), "invocation.json"));
        cost = invocation.usage?.cost ?? 0;
      } catch { /* bounded telemetry is optional */ }
      const outcome = status.state === "review" ? "review" : status.state === "done" || status.state === "integrated" ? "completed" : status.state === "blocked" ? "blocked" : status.state === "cancelled" ? "cancelled" : "failed";
      const evidencePath = join(attemptDir(root, featureId, task.id, status.currentAttempt), "evidence.json");
      const requirements = loadState(requirementsDir(root, featureId));
      return {
        outcome, durationMs: Date.now() - started, cost,
        ...(task.mode === "write" && ["review", "completed"].includes(outcome) ? { targetedEvidence: { requirementsRevision: requirements.requirementsRevision, testIds: task.affectedAcceptanceTestIds ?? requirements.acceptanceTests.map((test) => test.id), evidencePath, recordedAt: now() } } : {}),
        ...(checkpointReview ? { checkpointReview } : {}),
      };
    },
    review: hooks.checkpointReviewer ?? ((task, context) => reviewTaskForRun(root, featureId, task, context.signal, context.mode, context.checkpointMembers, context.affectedAcceptanceTestIds, context.turnAcceptanceTestIds, context.turnAcceptanceChecks)),
    integrate: (task, context) => integrateTaskForRun(root, featureId, task, context.signal, context.affectedAcceptanceTestIds),
    finalGate: (context) => executeFeatureFinalGate(root, context, { independentReview: hooks.finalReviewer }),
  };
}

/** Set by extension factory so runTask can gate routing on successful activation. */
let activeSessionProfileRuntime: SessionProfileRuntime | undefined;
/** Opaque Pi session identity for attributing delegated outcomes to the initiating session. */
let activeSessionId: string | undefined;

export default function agentWorkExtension(pi: ExtensionAPI) {
  const testHooks = (pi as ExtensionAPI & { __agentWorkTestHooks?: { directFinalReviewer?: Parameters<typeof executeExactCommitFinalGate>[4]["independentReview"] } }).__agentWorkTestHooks;
  registerStatusFooter(pi);
  registerAgentStatusUi(pi);

  pi.registerFlag("agent-profile", {
    description: "Activate a named agent-work model profile (coordinator + delegated routing)",
    type: "string",
  });

  const sessionRuntime = createSessionProfileRuntime();
  activeSessionProfileRuntime = sessionRuntime;
  let startupHandled = false;
  const modelApi = { setModel: (model: unknown) => pi.setModel(model as any) };

  pi.on("session_start", async (_event, ctx) => {
    activeSessionId = ctx.sessionManager.getSessionId();
    const root = await projectRoot(ctx.cwd);
    await initializeRoot(root);
    // Reset per-session activation gate.
    sessionRuntime.activated = false;
    sessionRuntime.routingConfig = undefined;
    sessionRuntime.lastError = undefined;
    sessionRuntime.statusLine = "agent-profile: pending";
    activeSessionProfileRuntime = sessionRuntime;

    if (startupHandled) return;
    startupHandled = true;

    const flagRaw = pi.getFlag("agent-profile");
    const flagName = typeof flagRaw === "string" && flagRaw.trim() ? flagRaw.trim() : null;

    await activateStartupProfile({
      api: modelApi,
      root,
      flagName,
      ctx: ctx as any,
      runtime: sessionRuntime,
    });
    // Resume durable nonterminal runs after routing is available. Terminal tasks are never relaunched.
    for (const run of await listRuns(root)) if (run.state !== "terminal") {
      void startRun(root, run.featureId, run.runId, executorForRoot(root, run.featureId));
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const root = await projectRoot(ctx.cwd);
    await suspendRuns(root);
    sessionRuntime.activated = false;
    sessionRuntime.routingConfig = undefined;
    if (activeSessionProfileRuntime === sessionRuntime) activeSessionProfileRuntime = undefined;
    activeSessionId = undefined;
  });

  pi.registerCommand("agent-profile", {
    description: "Select or activate a named agent-work model profile",
    getArgumentCompletions: (prefix: string) => {
      const names = [PRO_PROFILE_NAME, ECONOMY_PROFILE_NAME, "Legacy"].filter((name) =>
        name.toLowerCase().startsWith(prefix.toLowerCase()));
      return names.length ? names.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const root = await projectRoot(ctx.cwd);
      let config: RouterConfig;
      try {
        config = await loadRouterConfig(root);
      } catch (error: any) {
        ctx.ui.notify(`agent-profile: ${error?.message ?? error}`, "error");
        return;
      }

      const requested = args.trim();
      const run = async (name: string) => {
        const result = await activateAgentProfile({
          api: modelApi,
          root,
          profileName: name,
          ctx: ctx as any,
          baselineConfig: sessionRuntime.routingConfig ?? config,
        });
        if (result.ok) ensureRuntimeAfterCommandSuccess(sessionRuntime, result);
        else ensureRuntimeAfterCommandFailure(sessionRuntime, result);
      };

      if (requested) {
        await run(requested);
        return;
      }

      const names = config.profiles.map((profile) => profile.name);
      if (!names.length) {
        ctx.ui.notify("agent-profile: no profiles configured in router.json", "error");
        return;
      }
      const selected = await ctx.ui.select(
        `Active profile: ${config.activeProfile}. Choose a profile:`,
        names,
      );
      if (!selected) {
        ctx.ui.notify(`Keeping ${formatActiveProfileStatus(sessionRuntime.routingConfig ?? config)}`, "info");
        return;
      }
      await run(selected);
    },
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${CRITICAL_FEEDBACK_PROTOCOL}\n\n${FEATURE_WORKFLOW_PROTOCOL}\n\n${ROUTER_ORCHESTRATION_PROTOCOL}`,
  }));

  pi.registerTool({
    name: QUESTIONNAIRE_TOOL_NAME,
    label: "Requirements Questionnaire",
    description: QUESTIONNAIRE_DESCRIPTION,
    promptSnippet: "Interactive 1–5 question requirements batch (TUI); chat fallback otherwise",
    promptGuidelines: QUESTIONNAIRE_PROMPT_GUIDELINES,
    parameters: buildQuestionnaireParamsSchema(Type) as any,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const normalized = normalizeQuestions(params.questions ?? []);
      const invalid = validateQuestions(normalized);
      if (invalid) return errorResult(invalid, normalized);

      if (ctx.mode !== "tui") {
        return uiUnavailableResult(normalized, ctx.mode);
      }

      const uiResult = await runQuestionnaireUi(ctx.ui.custom.bind(ctx.ui) as any, normalized);
      if (uiResult.cancelled || uiResult.status === "cancelled") {
        return cancelledResult(normalized);
      }
      return submittedResult(normalized, uiResult.answers);
    },
    renderCall(args, theme) {
      const qs = (args as { questions?: { label?: string; id?: string }[] }).questions ?? [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id || "?").join(", ");
      let text = theme.fg("toolTitle", theme.bold(`${QUESTIONNAIRE_TOOL_NAME} `));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) text += theme.fg("dim", ` (${labels})`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as {
        status?: string;
        cancelled?: boolean;
        answers?: {
          id: string;
          multiSelect?: boolean;
          selections: { label: string; wasCustom: boolean; index?: number; value: string }[];
        }[];
      } | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.status === "cancelled" || details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled — continue in chat"), 0, 0);
      }
      if (details.status === "ui_unavailable") {
        return new Text(theme.fg("warning", "UI unavailable — ask in chat"), 0, 0);
      }
      if (details.status === "error") {
        const text = result.content[0];
        return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
      }
      const lines = (details.answers ?? []).map((a) => {
        const parts = a.selections.map((sel) => {
          if (sel.wasCustom) return `${theme.fg("muted", "(wrote) ")}${sel.label}`;
          const display = sel.index ? `${sel.index}. ${sel.label}` : sel.label;
          return display;
        });
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${parts.join("; ")}`;
      });
      return new Text(lines.join("\n") || theme.fg("muted", "No answers"), 0, 0);
    },
  });

  pi.registerTool({
    name: "agent_feature_init",
    label: "Initialize Feature",
    description: "Create a durable .agent-work feature and bootstrap its requirements package.",
    parameters: Type.Object({
      id: Type.String({ description: "Stable feature slug" }),
      title: Type.String(),
      goal: Type.String(),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
      tier: Type.Optional(StringEnum(["tiny", "small", "medium", "large", "epic"] as const)),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      await ensureLocalIgnore(root);
      const feature = await createFeature(root, {
        id: params.id,
        title: params.title,
        goal: params.goal,
        acceptanceCriteria: params.acceptanceCriteria ?? [],
        constraints: params.constraints ?? [],
      });
      const reqDir = await ensureRequirementsSession(root, feature.id, feature.title, params.tier ?? "medium");
      return {
        content: [{
          type: "text",
          text: `Created feature ${feature.id}\nBrief: ${join(featureDir(root, feature.id), "brief.md")}\nRequirements: ${reqDir}\nNext: continue the automatic requirements interview with agent_requirements until handoff-ready.`,
        }],
        details: feature,
      };
    },
  });

  pi.registerTool({
    name: "agent_requirements",
    label: "Requirements Package",
    description: "Initialize, inspect, validate, apply patches, or render the deterministic requirements package for a feature.",
    parameters: Type.Object({
      featureId: Type.String(),
      action: StringEnum(["status", "init", "gaps", "validate", "apply", "render", "cli-help"] as const),
      tier: Type.Optional(StringEnum(["tiny", "small", "medium", "large", "epic"] as const)),
      patchJson: Type.Optional(Type.String({ description: "Raw patch JSON for action=apply" })),
      force: Type.Optional(Type.Boolean({ description: "Force render handoff even with blockers" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      await assertFeature(root, params.featureId);
      const feature = await assertFeature(root, params.featureId);

      if (params.action === "cli-help") {
        return { content: [{ type: "text", text: `CLI: ${requirementsCliPath()}\nExample:\nnode --experimental-strip-types ${requirementsCliPath()} gaps --dir ${requirementsDir(root, feature.id)}` }], details: {} };
      }
      if (params.action === "init") {
        const dir = await ensureRequirementsSession(root, feature.id, feature.title, params.tier ?? "medium");
        return { content: [{ type: "text", text: `Requirements session ready: ${dir}` }], details: { dir } };
      }
      if (params.action === "status" || params.action === "validate" || params.action === "gaps") {
        if (params.action === "init") {/* unreachable */}
        const dir = requirementsDir(root, feature.id);
        if (params.action === "status") {
          const status = await requirementsStatus(root, feature.id);
          return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: status };
        }
        const result = await runRequirementsCli([params.action, "--dir", dir], root);
        return { content: [{ type: "text", text: truncate((result.stdout || result.stderr).trim() || `(exit ${result.code})`) }], details: { code: result.code } };
      }
      if (params.action === "apply") {
        if (!params.patchJson) throw new Error("patchJson is required for action=apply");
        const dir = requirementsDir(root, feature.id);
        await mkdir(dir, { recursive: true });
        const patchPath = join(dir, `patch-${Date.now()}.json`);
        await writeFile(patchPath, params.patchJson, "utf8");
        const result = await runRequirementsCli(["apply", patchPath, "--dir", dir], root);
        return { content: [{ type: "text", text: truncate((result.stdout || result.stderr).trim()) }], details: { code: result.code, patchPath } };
      }
      if (params.action === "render") {
        const rendered = await renderRequirementsArtifacts(root, feature.id, { force: params.force });
        return {
          content: [{ type: "text", text: `Rendered\nSpec: ${rendered.specPath}\nHandoff: ${rendered.handoffPath}${rendered.forced ? "\nFORCED: residual risk present" : ""}` }],
          details: rendered,
        };
      }
      throw new Error(`Unknown action: ${params.action}`);
    },
  });

  pi.registerTool({
    name: "agent_delegate",
    label: "Delegate Task",
    description: "Run an isolated persistent Pi subagent with a required bounded-work contract. Writing tasks require a handoff-ready schema-v2 requirements package; forceRequirements never bypasses readiness.",
    parameters: Type.Object({
      featureId: Type.String(),
      taskId: Type.String(),
      title: Type.String(),
      prompt: Type.String(),
      mode: StringEnum(["read", "write"] as const),
      profile: Type.Optional(StringEnum(["worker", "reviewer", "scout"] as const)),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      outcome: Type.String({ description: "One coherent, independently verifiable outcome" }),
      surface: Type.Array(Type.String({ description: "Specific in-scope file or component" }), { minItems: 1, maxItems: 8 }),
      nonGoals: Type.Array(Type.String({ description: "Meaningful explicit exclusion" }), { minItems: 1 }),
      verificationCommands: Type.Array(Type.String({ description: "Objective non-no-op verification command" }), { minItems: 1 }),
      affectedAcceptanceTestIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
      acceptanceChecks: Type.Optional(Type.Array(Type.Object({ testId: Type.String(), command: Type.String() }), { minItems: 1 })),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
      complexity: Type.Optional(StringEnum(["tiny", "small", "medium", "large"] as const)),
      risk: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
      prefer: Type.Optional(StringEnum(["cost", "speed", "quality", "balanced"] as const)),
      retry: Type.Optional(Type.Boolean()),
      forceRequirements: Type.Optional(Type.Boolean({ description: "Compatibility flag: rerender an already-valid handoff; never bypasses readiness or user approval" })),
      hardTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional operation timeout; disabled by default" })),
      inactivityMs: Type.Optional(Type.Integer({ minimum: 1 })),
      routeSlice: Type.Optional(Type.Object({ role: Type.Optional(StringEnum(["builder", "scout", "reviewer"] as const)), complexity: Type.Optional(StringEnum(["tiny", "small", "medium", "large"] as const)), risk: Type.Optional(StringEnum(["low", "medium", "high"] as const)), kind: Type.Optional(StringEnum(["ui", "test", "maintenance", "architecture", "security", "integration", "general"] as const)) })),
      retentionDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
      compaction: Type.Optional(Type.Boolean()),
      retainWorktree: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (params.mode === "write" && (!params.affectedAcceptanceTestIds?.length || !params.acceptanceChecks?.length || params.acceptanceChecks.length !== params.affectedAcceptanceTestIds.length || params.acceptanceChecks.some((check) => !params.affectedAcceptanceTestIds.includes(check.testId)))) throw new Error("Delegation refused before launch: writing requires complete affectedAcceptanceTestIds and coordinator-owned acceptanceChecks mapping");
      const root = await projectRoot(ctx.cwd);
      if (params.mode === "write") {
        const requirements = loadState(requirementsDir(root, params.featureId));
        const expected = requirements.acceptanceTests.map((test) => test.id);
        if (params.acceptanceChecks!.length !== expected.length || expected.some((id) => !params.acceptanceChecks!.some((check) => check.testId === id))) throw new Error("Delegation refused before launch: direct writing lifecycle requires canonical acceptanceChecks for every acceptance test used by its automatic final gate");
        for (const check of params.acceptanceChecks!) {
          const required = requirements.acceptanceTests.find((test) => test.id === check.testId)?.fidelityLayer;
          const actual = commandFidelity(check.command);
          if (!required || !actual || (required !== actual && !(required === "realistic-smoke" && actual === "integration"))) throw new Error(`Delegation refused before launch: acceptanceChecks ${check.testId} cannot satisfy required ${required ?? "known"} fidelity`);
        }
      }
      const result = await runTask(root, {
        featureId: params.featureId,
        taskId: params.taskId,
        title: params.title,
        prompt: params.prompt,
        mode: params.mode,
        profile: params.profile ?? (params.mode === "write" ? "worker" : "scout"),
        dependsOn: params.dependsOn ?? [],
        outcome: params.outcome,
        surface: params.surface,
        nonGoals: params.nonGoals,
        verificationCommands: params.verificationCommands,
        affectedAcceptanceTestIds: params.affectedAcceptanceTestIds,
        acceptanceChecks: params.acceptanceChecks,
        model: params.model,
        thinking: params.thinking,
        complexity: params.complexity,
        risk: params.risk,
        prefer: params.prefer,
        retry: params.retry,
        forceRequirements: params.forceRequirements,
        hardTimeoutMs: params.hardTimeoutMs,
        inactivityMs: params.inactivityMs,
        routeSlice: params.routeSlice,
        workflow: { retention: { failureRetentionDays: params.retentionDays, compaction: params.compaction }, cleanup: { retainWorktree: params.retainWorktree } },
        operationId: _id,
      }, signal, (progress, event) => onUpdate?.({ content: [{ type: "text", text: progress }], details: { progress: event } }));
      return { content: [{ type: "text", text: result.receipt }], details: { attemptPath: result.attemptPath, sessionFile: result.sessionFile, operationId: result.operationId } };
    },
  });

  pi.registerTool({
    name: "agent_run",
    label: "Orchestrate Run",
    description: "Submit, inspect, cancel, resume, explicitly retry, or reflect a durable dependency-aware parallel run.",
    promptSnippet: "Run two or more genuinely independent eligible tasks with durable dependency-aware scheduling",
    promptGuidelines: ["Use agent_run submit only when decomposition contains at least two genuinely independent eligible tasks; retain agent_delegate for a single task."],
    parameters: Type.Object({
      action: StringEnum(["submit", "status", "list", "cancel", "retry", "resume", "reflect"] as const),
      featureId: Type.String(),
      runId: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
      tasks: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        title: Type.String(),
        prompt: Type.String(),
        mode: StringEnum(["read", "write"] as const),
        profile: Type.Optional(Type.String()),
        dependsOn: Type.Array(Type.String()),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(Type.String()),
        complexity: Type.Optional(StringEnum(["tiny", "small", "medium", "large"] as const)),
        risk: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
        prefer: Type.Optional(StringEnum(["cost", "speed", "quality", "balanced"] as const)),
        outcome: Type.String({ description: "One coherent, independently verifiable outcome" }),
        surface: Type.Array(Type.String({ description: "In-scope file or component" }), { minItems: 1 }),
        nonGoals: Type.Array(Type.String({ description: "Explicitly excluded work" }), { minItems: 1 }),
        verificationCommands: Type.Array(Type.String({ description: "Objective verification command" }), { minItems: 1 }),
        checkpoint: Type.Optional(Type.String({ description: "Ordered shared writing checkpoint identifier" })),
        checkpointOutcome: Type.Optional(Type.String({ description: "Shared coherent outcome, identical for all members of a multi-turn checkpoint" })),
        checkpointSurface: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Shared allowed surface, identical for all members; each turn surface must be a subset" })),
        reviewTriggers: Type.Optional(Type.Array(StringEnum(["public-contract", "architecture", "security-trust-boundary", "data-migration", "concurrency", "expanded-acceptance-scope", "uncertain"] as const))),
        affectedAcceptanceTestIds: Type.Optional(Type.Array(Type.String({ description: "Acceptance test affected by this writing turn" }), { minItems: 1 })),
        acceptanceChecks: Type.Optional(Type.Array(Type.Object({ testId: Type.String({ description: "Affected acceptance test ID" }), command: Type.String({ description: "Coordinator-owned objective acceptance command" }) }), { minItems: 1 })),
      }))),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      await assertFeature(root, params.featureId);
      if (params.action === "list") {
        const runs = await listRuns(root, params.featureId);
        return { content: [{ type: "text", text: runs.length ? JSON.stringify(runs, null, 2) : "No runs." }], details: { runs } };
      }
      if (!params.runId) throw new Error(`${params.action} requires runId`);
      const executor = executorForRoot(root, params.featureId);
      if (params.action === "submit") {
        if (!params.tasks?.length) throw new Error("submit requires a complete non-empty tasks graph");
        await ensureLocalIgnore(root);
        const declaration: RunDeclaration = { schemaVersion: 1, id: params.runId, featureId: params.featureId, tasks: params.tasks as RunTaskDeclaration[], concurrency: params.concurrency };
        for (const task of declaration.tasks.filter((item) => item.mode === "write")) if (!task.affectedAcceptanceTestIds?.length || !task.acceptanceChecks?.length || task.acceptanceChecks.length !== task.affectedAcceptanceTestIds.length || task.acceptanceChecks.some((check) => !task.affectedAcceptanceTestIds!.includes(check.testId))) throw new Error(`submit writing task ${task.id} requires complete affectedAcceptanceTestIds and acceptanceChecks`);
        const knownAcceptanceTests = new Set(loadState(requirementsDir(root, params.featureId)).acceptanceTests.map((test) => test.id));
        const unknownAffected = declaration.tasks.flatMap((task) => [...(task.affectedAcceptanceTestIds ?? []), ...(task.acceptanceChecks?.map((check) => check.testId) ?? [])]).filter((testId) => !knownAcceptanceTests.has(testId));
        if (unknownAffected.length) throw new Error(`submit references unknown affected acceptance tests: ${[...new Set(unknownAffected)].join(", ")}`);
        for (const task of declaration.tasks.filter((item) => item.mode === "write")) for (const check of task.acceptanceChecks ?? []) {
          const required = loadState(requirementsDir(root, params.featureId)).acceptanceTests.find((test) => test.id === check.testId)?.fidelityLayer;
          const actual = commandFidelity(check.command);
          if (required && (!actual || (required !== actual && !(required === "realistic-smoke" && actual === "integration")))) throw new Error(`acceptanceChecks ${check.testId} command cannot satisfy required ${required} fidelity; rescope to an independently enforceable command`);
        }
        const state = await acceptRun(root, declaration);
        await startRun(root, params.featureId, params.runId, executor);
        return { content: [{ type: "text", text: `Accepted run ${params.runId}; scheduling continues non-blockingly.\nState: ${join(featureDir(root, params.featureId), "runs", params.runId, "state.json")}` }], details: state };
      }
      if (params.action === "status") {
        const state = await getRun(root, params.featureId, params.runId);
        const taskLines = Object.values(state.tasks).map((task) => `${task.id}: ${task.state}${task.waitReason ? ` (${task.waitReason})` : ""}`);
        const summary = [`Run ${params.runId}: ${state.state}${state.outcome ? `/${state.outcome}` : ""}`, `Agents: ${state.activeCount}/${state.effectiveCap}`, ...taskLines, `Final gate: ${state.finalGate.status}${state.finalGate.reason ? ` — ${state.finalGate.reason}` : state.finalGate.reportPath ? ` — ${state.finalGate.reportPath}` : ""}`, `Reflection: ${state.reflection.status}${state.reflection.path ? ` — ${state.reflection.path}` : ""}`].join("\n");
        return { content: [{ type: "text", text: truncate(summary) }], details: state };
      }
      if (params.action === "reflect") {
        const state = await runReflection(root, params.featureId, params.runId, true);
        return { content: [{ type: "text", text: `Reflection ${state.reflection.status}${state.reflection.path ? `: ${state.reflection.path}` : state.reflection.reason ? `: ${state.reflection.reason}` : ""}` }], details: state };
      }
      await startRun(root, params.featureId, params.runId, executor);
      if (params.action === "cancel") await cancelRun(root, params.featureId, params.runId, params.taskId);
      else if (params.action === "retry") {
        if (params.taskId) await retryRunTask(root, params.featureId, params.runId, params.taskId);
        else await retryRunFinalGate(root, params.featureId, params.runId);
      }
      const state = await getRun(root, params.featureId, params.runId);
      return { content: [{ type: "text", text: `${params.action === "resume" ? "Resumed" : params.action === "retry" ? "Explicit retry requested for" : "Cancellation requested for"} ${params.taskId ?? params.runId}.` }], details: state };
    },
  });

  pi.registerTool({
    name: "agent_reflection_proposal",
    label: "Reflection Proposals",
    description: "List, explicitly approve, or audit-apply recurring evidence-backed process proposals. Never mutates behavior or configuration automatically.",
    parameters: Type.Object({
      action: StringEnum(["list", "approve", "apply"] as const),
      proposalId: Type.Optional(Type.String()),
      operator: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      if (params.action === "list") {
        const proposals = await listProposals(root);
        return { content: [{ type: "text", text: proposals.length ? JSON.stringify(proposals, null, 2) : "No recurring proposals." }], details: { proposals } };
      }
      if (!params.proposalId || !params.operator) throw new Error(`${params.action} requires proposalId and explicit operator identity`);
      const proposal = params.action === "approve"
        ? await approveProposal(root, params.proposalId, params.operator)
        : await applyProposal(root, params.proposalId, params.operator);
      return { content: [{ type: "text", text: `Proposal ${proposal.id}: ${proposal.state}. No behavior or configuration was changed automatically.` }], details: proposal };
    },
  });

  pi.registerTool({
    name: "agent_router",
    label: "Model Router",
    description: "Inspect routing policy/telemetry or record quality feedback used to calibrate model and prompt choices.",
    parameters: Type.Object({
      action: StringEnum(["status", "report", "feedback"] as const),
      featureId: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      attempt: Type.Optional(Type.Integer({ minimum: 1 })),
      outcome: Type.Optional(StringEnum(["accepted", "corrected", "failed"] as const)),
      note: Type.Optional(Type.String()),
      diagnosisCategory: Type.Optional(StringEnum(["task-complexity", "missing-context", "infrastructure", "prompt-quality"] as const)),
      diagnosisReason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      const config = await loadRouterConfig(root);
      const logPath = join(rootDir(root), "routing-decisions.jsonl");
      if (params.action === "status") {
        const active = formatActiveProfileStatus(config);
        return { content: [{ type: "text", text: `${active}\nConfig: ${routerConfigPath(root)}\nTelemetry: ${logPath}\n\n${JSON.stringify(config, null, 2)}` }], details: { ...config, statusLine: active } };
      }
      if (params.action === "feedback") {
        if (!params.featureId || !params.taskId || !params.outcome) throw new Error("feedback requires featureId, taskId, and outcome");
        const diagnosis = params.diagnosisCategory || params.diagnosisReason
          ? { category: params.diagnosisCategory, reason: params.diagnosisReason }
          : undefined;
        if (diagnosis && !validEscalationDiagnosis(diagnosis)) throw new Error("feedback diagnosis requires a valid category and non-empty reason");
        const status = await readStatus(root, params.featureId, params.taskId);
        const attempt = params.attempt ?? status.currentAttempt;
        const invocationPath = join(attemptDir(root, params.featureId, params.taskId, attempt), "invocation.json");
        const invocation = (await exists(invocationPath)) ? await readJson<InvocationRecord>(invocationPath) : undefined;
        const model = invocation?.model ?? (invocation?.route as { selectedModel?: string } | undefined)?.selectedModel;
        await settleTerminalRoute(root, { featureId: params.featureId, taskId: params.taskId, attempt, model, outcome: params.outcome, note: params.note, diagnosis });
        return { content: [{ type: "text", text: `Recorded ${params.outcome} feedback for ${params.featureId}/${params.taskId} attempt ${attempt}.` }], details: {} };
      }
      const lines = (await exists(logPath)) ? (await readFile(logPath, "utf8")).split(/\r?\n/).filter(Boolean) : [];
      const records = lines.map((line) => JSON.parse(line));
      const routes = records.filter((record) => record.type === "route");
      const outcomes = records.filter((record) => record.type === "outcome");
      const feedback = records.filter((record) => record.type === "feedback");
      const models: Record<string, { routes: number; outcomes: number; corrections: number; failures: number; cost: number; durationMs: number }> = {};
      for (const route of routes) {
        const model = route.selectedModel ?? "pi-default";
        models[model] ??= { routes: 0, outcomes: 0, corrections: 0, failures: 0, cost: 0, durationMs: 0 };
        models[model].routes++;
      }
      for (const outcome of outcomes) {
        const model = outcome.model ?? "pi-default";
        models[model] ??= { routes: 0, outcomes: 0, corrections: 0, failures: 0, cost: 0, durationMs: 0 };
        models[model].outcomes++;
        models[model].corrections += outcome.correction ? 1 : 0;
        models[model].failures += ["failed", "blocked", "cancelled"].includes(outcome.state) ? 1 : 0;
        models[model].cost += outcome.usage?.cost ?? 0;
        models[model].durationMs += outcome.durationMs ?? 0;
      }
      for (const item of feedback) {
        const route = routes.findLast((candidate) => candidate.featureId === item.featureId && candidate.taskId === item.taskId && candidate.attempt === item.attempt);
        const model = route?.selectedModel ?? "pi-default";
        models[model] ??= { routes: 0, outcomes: 0, corrections: 0, failures: 0, cost: 0, durationMs: 0 };
        models[model].corrections += item.outcome === "corrected" ? 1 : 0;
        models[model].failures += item.outcome === "failed" ? 1 : 0;
      }
      const routeFeedback = await readRouteFeedback(root);
      const terminalRoutes = outcomes.map((item) => ({ featureId: item.featureId, taskId: item.taskId, attempt: item.attempt, model: item.model }));
      const feedbackDiagnostics = diagnoseMissingRouteFeedback(terminalRoutes, routeFeedback);
      const telemetry = {
        routing: routes.slice(-100).map((route) => ({ tier: route.classification?.risk, escalation: Boolean(route.escalation), feedbackComplete: !feedbackDiagnostics.missing.some((missing) => missing.featureId === route.featureId && missing.taskId === route.taskId && missing.attempt === route.attempt) })),
        review: records.filter((record) => record.type === "review").slice(-100).map((record) => ({ mode: record.mode, fanOut: record.fanOut, reused: record.reused ?? 0, fresh: record.fresh ?? 0, duplicate: record.duplicate ?? 0 })),
        lifecycle: outcomes.slice(-100).map((outcome) => ({ state: outcome.state, timeout: outcome.terminal === "timeout" })),
        cleanup: records.filter((record) => record.type === "cleanup").slice(-100).map((record) => record.outcome),
      };
      const report = { generatedAt: now(), totals: { routes: routes.length, outcomes: outcomes.length, feedback: routeFeedback.length }, models, feedbackDiagnostics, telemetry };
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: report };
    },
  });

  pi.registerTool({
    name: "agent_operation",
    label: "Agent Operation",
    description: "Inspect, replay, list, or cancel durable delegated-work progress operations.",
    parameters: Type.Object({
      action: StringEnum(["status", "replay", "list", "cancel"] as const),
      operationId: Type.Optional(Type.String()),
      featureId: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      if (params.action === "cancel") {
        if (!params.operationId) throw new Error("cancel requires operationId");
        const cancelled = await cancelActiveOperation(params.operationId);
        if (!cancelled) throw new Error(`Operation is not active: ${params.operationId}`);
        return { content: [{ type: "text", text: `Cancelled ${params.operationId}; no automatic retry was started.` }], details: { operationId: params.operationId, cancelled: true } };
      }
      if (params.action === "status") {
        if (!params.operationId) throw new Error("status requires operationId");
        const active = getActiveOperation(params.operationId);
        const timeline = active ? [] : await readProgressTimeline(root, params.operationId);
        const status = active ?? timeline.at(-1);
        if (!status) throw new Error(`Unknown operation: ${params.operationId}`);
        return { content: [{ type: "text", text: formatProgress(status) }], details: { progress: status, active: Boolean(active) } };
      }
      if (params.action === "replay") {
        if (!params.operationId) throw new Error("replay requires operationId");
        const timeline = await readProgressTimeline(root, params.operationId);
        return { content: [{ type: "text", text: truncate(timeline.map(formatProgress).join("\n")) }], details: { operationId: params.operationId, timeline } };
      }
      const active = listActiveOperations().filter((event) =>
        (!params.featureId || event.featureId === params.featureId) && (!params.taskId || event.taskId === params.taskId));
      const persisted = await findProgressTimelines(root, { featureId: params.featureId, taskId: params.taskId });
      const latest = persisted.map((timeline) => timeline.at(-1)!).filter((event) => !active.some((item) => item.operationId === event.operationId));
      const operations = [...active, ...latest];
      return { content: [{ type: "text", text: operations.length ? operations.map(formatProgress).join("\n") : "No matching operations." }], details: { operations, active: active.map((event) => event.operationId) } };
    },
  });

  pi.registerTool({
    name: "agent_maintenance",
    label: "Agent Work Maintenance",
    description: "Inspect safe retention and Git lifecycle maintenance. Pruning is always dry-run-first; foreign Git repair is diagnostic only.",
    parameters: Type.Object({
      action: StringEnum(["prune", "compact", "cleanup", "git-diagnostics", "git-repair-plan"] as const),
      featureId: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()), attempt: Type.Optional(Type.Integer({ minimum: 1 })),
      dryRun: Type.Optional(Type.Boolean()), dryRunToken: Type.Optional(Type.String()), terminalAt: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      if (params.action === "git-diagnostics") {
        const anomalies = await diagnoseGitAnomalies(root);
        return { content: [{ type: "text", text: JSON.stringify(anomalies, null, 2) }], details: { anomalies, dryRun: true } };
      }
      if (params.action === "git-repair-plan") {
        const plan = await planGitRepair(root, false);
        return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }], details: plan };
      }
      if (!params.featureId || !params.taskId) throw new Error(`${params.action} requires featureId and taskId`);
      const status = await readStatus(root, params.featureId, params.taskId);
      const attempt = params.attempt ?? status.currentAttempt;
      const address = { featureId: params.featureId, taskId: params.taskId, attempt };
      if (params.action === "compact") {
        const result = await compactSuccessfulAttempt(root, address, { integrated: status.state === "integrated" });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      }
      if (params.action === "cleanup") {
        const result = await reconcileCbpiLifecycle(root, { dryRun: params.dryRun !== false });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { dryRun: params.dryRun !== false, result } };
      }
      if (!params.terminalAt) throw new Error("prune requires terminalAt from the preserved status diagnostics");
      if (!(["failed", "blocked", "cancelled", "stalled"] as string[]).includes(status.state)) throw new Error("Only failed, blocked, cancelled, or stalled diagnostics are eligible for pruning");
      const result = await pruneFailedAttemptDiagnostics(root, address, { status: status.state as "failed" | "blocked" | "cancelled" | "stalled", terminalAt: params.terminalAt, policy: (await loadWorkflowConfig(root)).retention, dryRun: params.dryRun !== false, dryRunToken: params.dryRunToken });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: "agent_inspect",
    label: "Inspect Agent Work",
    description: "Read a task handoff, status, full event stream, or persistent child session on demand.",
    parameters: Type.Object({
      featureId: Type.String(),
      taskId: Type.String(),
      attempt: Type.Optional(Type.Integer({ minimum: 1 })),
      artifact: Type.Optional(StringEnum(["handoff", "status", "events", "session", "invocation"] as const)),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      const status = await readStatus(root, params.featureId, params.taskId);
      const attempt = params.attempt ?? status.currentAttempt;
      const artifact = params.artifact ?? "handoff";
      let path: string;
      if (artifact === "status") path = join(taskDir(root, params.featureId, params.taskId), "status.json");
      else if (artifact === "session") {
        const ref = await readJson<SessionReference>(join(attemptDir(root, params.featureId, params.taskId, attempt), "session.json"));
        if (!ref.file) throw new Error("No persistent session file was recorded");
        path = ref.file;
      } else {
        const name = artifact === "events" ? "events.jsonl" : artifact === "invocation" ? "invocation.json" : "handoff.json";
        path = join(attemptDir(root, params.featureId, params.taskId, attempt), name);
      }
      const content = await readFile(path, "utf8");
      return { content: [{ type: "text", text: `${path}\n\n${truncate(content)}` }], details: { path, truncated: content.length > OUTPUT_LIMIT } };
    },
  });

  pi.registerTool({
    name: "agent_ask",
    label: "Ask Subagent",
    description: "Resume a task's persistent child session and ask a focused follow-up question.",
    parameters: Type.Object({
      featureId: Type.String(),
      taskId: Type.String(),
      question: Type.String(),
      attempt: Type.Optional(Type.Integer({ minimum: 1 })),
      allowChanges: Type.Optional(Type.Boolean({ description: "Allow a writing worker to revise its worktree and amend its task commit" })),
      hardTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional operation timeout; disabled by default" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const root = await projectRoot(ctx.cwd);
      const status = await readStatus(root, params.featureId, params.taskId);
      const attempt = params.attempt ?? status.currentAttempt;
      const dir = attemptDir(root, params.featureId, params.taskId, attempt);
      const session = await readJson<SessionReference>(join(dir, "session.json"));
      const invocation = await readJson<InvocationRecord>(join(dir, "invocation.json"));
      if (!session.file) throw new Error("No persistent child session is available");
      if (params.allowChanges && invocation.mode !== "write") throw new Error("This task is read-only");
      if (params.allowChanges && status.state === "integrated") throw new Error("Cannot revise a task after integration");
      const queryFile = join(dir, "queries", `${Date.now()}.jsonl`);
      const tools = params.allowChanges ? "read,grep,find,ls,bash,edit,write" : "read,grep,find,ls,bash";
      const question = params.allowChanges
        ? `Revise the implementation as requested, run relevant checks, and update handoff.json. Do not commit; the coordinator will amend the task commit.\n\n${params.question}`
        : `Answer this focused follow-up without modifying project files:\n\n${params.question}`;
      const args = [
        "--mode", "json", "-p", "--session", session.file,
        "--tools", tools,
        "--no-extensions", "--no-skills", "--no-prompt-templates",
        question,
      ];
      const monitor = await ProgressMonitor.start({
        root,
        featureId: params.featureId,
        taskId: params.taskId,
        attempt,
        operationId: _id,
        operation: "follow-up",
        phase: "follow-up",
        hardTimeoutMs: params.hardTimeoutMs,
        onDelivery: (event) => onUpdate?.({ content: [{ type: "text", text: formatProgress(event) }], details: { progress: event } }),
      });
      try {
      const result = await runPi({ cwd: session.cwd, args, eventsFile: queryFile, signal, monitor });
      let amendedCommit: string | undefined;
      if (params.allowChanges && result.exitCode === 0) {
        const parentCommit = status.commit;
        const changes = (await command("git", ["status", "--porcelain"], session.cwd)).stdout.trim();
        if (changes) {
          await command("git", ["add", "-A"], session.cwd);
          if (status.commit) await command("git", ["commit", "--amend", "--no-edit"], session.cwd);
          else await command("git", ["commit", "-m", `agent-work(${params.taskId}): follow-up revision`], session.cwd);
          amendedCommit = (await command("git", ["rev-parse", "HEAD"], session.cwd)).stdout.trim();
          const files = parentCommit
            ? (await command("git", ["diff", "--name-only", parentCommit, amendedCommit], session.cwd)).stdout.split(/\r?\n/).filter(Boolean)
            : [];
          const diff = parentCommit ? (await command("git", ["diff", "--unified=0", parentCommit, amendedCommit], session.cwd)).stdout : "";
          const surface = classifyChangedSurfaceFromDiff({ files, diff, affectedRequirementIds: [...diff.matchAll(/\b(?:fr|ac|at)-[a-z0-9_-]+\b/gi)].map((item) => item[0]) });
          await atomicJson(join(dir, "amendment.json"), { parentCommit, amendedCommit, changedSurface: surface, recordedAt: now() });
          const manifestPath = join(dir, "evidence-manifest.json");
          if (await exists(manifestPath)) {
            const prior = await readJson<EvidenceManifest>(manifestPath);
            await atomicJson(manifestPath, createEvidenceManifest({ requirementsRevision: prior.requirementsRevision, commit: amendedCommit, records: ancestorEvidence(prior.records, amendedCommit) }));
          }
          status.commit = amendedCommit;
          status.state = "review";
          status.message = "Worker revised the task commit; review again before integration";
          await writeStatus(root, status);
        }
      }
      await appendJsonl(join(dir, "queries", "index.jsonl"), {
        timestamp: now(), question: params.question, allowChanges: params.allowChanges ?? false,
        eventsFile: queryFile, exitCode: result.exitCode, commit: amendedCommit,
      });
      if (params.allowChanges) {
        await appendJsonl(join(rootDir(root), "routing-decisions.jsonl"), {
          timestamp: now(), type: "feedback", featureId: params.featureId, taskId: params.taskId, attempt,
          outcome: result.exitCode === 0 ? "corrected" : "failed", note: params.question.slice(0, 500),
        });
      }
      const response = truncate(result.finalText || result.stderr || "(no response)");
      await monitor.terminal(result.exitCode === 0 ? "success" : "failure", result.exitCode === 0 ? "Follow-up completed" : `Follow-up exited ${result.exitCode}`);
      return {
        content: [{ type: "text", text: amendedCommit ? `${response}\n\nAmended task commit: ${amendedCommit}` : response }],
        details: { session: session.file, eventsFile: queryFile, commit: amendedCommit, operationId: _id },
      };
      } catch (error: any) {
        if (!monitor.isTerminal) await monitor.terminal(signal?.aborted ? "cancelled" : "failure", signal?.aborted ? "Follow-up cancelled" : "Follow-up failed; inspect persisted diagnostics");
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "agent_review",
    label: "Review Task",
    description: "Run multi-perspective adversarial review with independent verification of critical/high findings.",
    parameters: Type.Object({
      featureId: Type.String(),
      taskId: Type.String({ description: "Writing task to review" }),
      depth: Type.Optional(StringEnum(["quick", "standard", "deep"] as const)),
      targetType: Type.Optional(StringEnum(["code", "spec"] as const)),
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
      retry: Type.Optional(Type.Boolean()),
      singleReviewer: Type.Optional(Type.Boolean({ description: "Fallback to one general reviewer instead of multi-perspective critique" })),
      mode: Type.Optional(StringEnum(["broad", "focused", "final-gate"] as const)),
      hardTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional operation timeout; disabled by default" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const root = await projectRoot(ctx.cwd);
      const source = await readStatus(root, params.featureId, params.taskId);
      if (!source.worktree) throw new Error(`Task ${params.taskId} has no worktree to review`);
      if (!source.commit) throw new Error(`Task ${params.taskId} has no implementation commit to review`);
      const requirements = loadState(requirementsDir(root, params.featureId));
      const amendmentPath = join(attemptDir(root, params.featureId, params.taskId, source.currentAttempt), "amendment.json");
      const amendment = (await exists(amendmentPath)) ? await readJson<{ changedSurface?: ReturnType<typeof classifyChangedSurfaceFromDiff> }>(amendmentPath) : undefined;
      const lifecycle = await loadReviewLifecycle(root, params.featureId, params.taskId, requirements.requirementsRevision);
      const planned = reviewPlan(lifecycle, {
        phase: params.mode === "final-gate" ? "final" : lifecycle.broadReviews === 0 ? "initial" : "amendment",
        requirementsRevision: requirements.requirementsRevision, commit: source.commit,
        highRisk: params.mode === "final-gate" || params.depth === "deep" || await taskIsHighRisk(root, params.featureId, params.taskId, source.currentAttempt),
        changedSurface: amendment?.changedSurface,
        explicitBroad: params.mode === "broad",
      });
      const mode: ReviewMode = params.mode ?? planned.mode;
      const depth = params.depth ?? "standard";
      const singlePass = params.singleReviewer || mode === "focused" || mode === "final-gate";
      const total = singlePass ? 1 : perspectivesFor(params.targetType ?? "code", depth).length;
      const monitor = await ProgressMonitor.start({
        root,
        featureId: params.featureId,
        taskId: params.taskId,
        attempt: source.currentAttempt,
        operationId: _id,
        operation: "review",
        phase: "validating-evidence",
        counts: { completed: 0, active: 1, total },
        hardTimeoutMs: params.hardTimeoutMs,
        onDelivery: (event) => onUpdate?.({ content: [{ type: "text", text: formatProgress(event) }], details: { progress: event } }),
      });
      const controller = new AbortController();
      const abort = () => controller.abort();
      monitor.setCancelHandler(abort);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      try {
        const sourceAttempt = attemptDir(root, params.featureId, params.taskId, source.currentAttempt);
        const evidencePath = join(sourceAttempt, "evidence.json");
        const evidenceRaw = await exists(evidencePath) ? await readJson<unknown>(evidencePath) : undefined;
        const evidenceCheck = await validateBuilderEvidence(requirements, evidenceRaw, source.commit);
        if (!evidenceCheck.valid || !evidenceCheck.evidence)
          throw new Error(`Review refused: ${evidenceCheck.issues.join("; ")}`);
        await monitor.milestone("Builder evidence validated");

        if (singlePass) {
          const role: PromptSliceRole = mode === "final-gate" ? "final-gate" : mode === "focused" ? "focused-reviewer" : "broad-reviewer";
          const sourcePath = join(requirementsDir(root, params.featureId), "handoff.md");
          const sourceHash = await renderedHandoffSourceHash(sourcePath);
          if (!sourceHash.startsWith("sha256:")) throw new Error("review source handoff hash could not be computed");
          const slice = renderPromptSlice(createPromptSlice(requirements, {
            role, sourcePath, sourceHash,
            requirementIds: requirements.functionalRequirements.map((item) => item.id), criterionIds: requirements.acceptanceCriteria.map((item) => item.id),
            findings: lifecycle.findings, changedSurface: amendment?.changedSurface,
            checks: mode === "final-gate" ? ["Run all required acceptance checks on the exact current commit."] : ["Verify prior findings and changed files."],
          }));
          const result = await runTask(root, {
            featureId: params.featureId,
            taskId: `${params.taskId}-review`,
            title: `Review ${params.taskId}`,
            prompt: `${params.prompt ?? `Review task ${params.taskId}. Inspect HEAD, its diff, and the working tree.`}\n\n## Review slice\n${slice}`,
            mode: "read",
            profile: "reviewer",
            dependsOn: [params.taskId],
            model: params.model,
            thinking: params.thinking,
            retry: params.retry,
            outcome: `Review task ${params.taskId}`,
            surface: ["review-target-diff"],
            nonGoals: ["Do not modify implementation files"],
            verificationCommands: ["git diff --check"],
            cwdOverride: source.worktree,
            skipRequirementsGate: true,
            hardTimeoutMs: params.hardTimeoutMs,
            operationKind: "review",
            operationId: `${_id}-review`,
          }, controller.signal, (progress, event) => onUpdate?.({ content: [{ type: "text", text: progress }], details: { progress: event } }));
          await monitor.phaseChange("verifying-acceptance", "Rerunning required acceptance tests", { completed: 0, active: 1, total: requirements.acceptanceTests.length });
          const singleFindings: VerificationFinding[] = parseFindings(result.finalText, "single-reviewer").map((item) => ({
            severity: item.severity,
            status: "open",
            summary: sanitizeSummary(item.description),
          }));
          const verification = mode === "focused"
          ? await reviewVerification(sourceAttempt, requirements, evidenceCheck.evidence, source.worktree, source.commit, singleFindings, mode)
            : await rerunAcceptanceTests(requirements, evidenceCheck.evidence, source.worktree, source.commit, singleFindings, {
            signal: controller.signal,
            onProgress: async (progress) => {
              if (progress.status === "running") await monitor.phaseChange("verifying-acceptance", `Rerunning ${progress.testId}`, { completed: progress.completed, active: 1, total: progress.total });
              else await monitor.milestone(`${progress.testId}: ${progress.status}`, { completed: progress.completed, active: 0, total: progress.total });
            },
          });
          const verificationPath = join(taskDir(root, params.featureId, params.taskId), "verification-report.json");
          if (mode === "final-gate") {
            const records: EvidenceRecord[] = verification.tests.flatMap((test) => {
              const acceptanceTest = canonicalAcceptanceProvenance(requirements.acceptanceTests, test.testId);
              const base: EvidenceRecord = {
              id: `final-${acceptanceTest.recordId}`, command: test.command ?? `approved-exception:${test.testId}`, commandIdentity: "", kind: "full-suite",
              requirementsRevision: requirements.requirementsRevision, commit: source.commit, environment: "independent-review",
              result: evidenceResultForVerificationStatus(test.status), artifactHash: test.artifact?.sha256,
              fidelity: acceptanceTest.fidelity, scenarios: acceptanceTest.scenarios, freshness: "fresh",
              };
              return acceptanceTest.fidelity === "real-end-to-end" ? [base, { ...base, id: `${base.id}-flow`, kind: "flow" }] : [base];
            });
            const manifest = createEvidenceManifest({ requirementsRevision: requirements.requirementsRevision, commit: source.commit, records });
            await atomicJson(join(sourceAttempt, "final-evidence-manifest.json"), manifest);
            const blockers = finalGateBlockers(manifest.records, source.commit, requirements.requirementsRevision, requirements.acceptanceTests.some((test) => test.fidelityLayer === "real-end-to-end"));
            if (blockers.length) { verification.approved = false; verification.evidenceComplete = false; }
          }
          await writeVerificationReport(verificationPath, verification);
          const findingsForLifecycle = parseFindings(result.finalText, mode).map((item) => ({ severity: item.severity, location: item.location, description: item.description, sourceReviewId: `${mode}:${source.currentAttempt}` }));
          await atomicJson(lifecyclePath(root, params.featureId, params.taskId), recordReviewCompletion(lifecycle, { ...planned, mode, panel: false }, source.commit, findingsForLifecycle));
          await monitor.terminal(verification.approved ? "success" : "failure", verification.approved ? "Acceptance verification approved" : "Acceptance verification refused completion");
          return { content: [{ type: "text", text: `${result.receipt}\nMachine verification: ${verificationPath}\nApproved: ${verification.approved}` }], details: { ...verification, operationId: _id, reviewOperationId: result.operationId } };
        }

        const report = await runMultiPerspectiveReview(root, {
          featureId: params.featureId,
          taskId: params.taskId,
          worktree: source.worktree,
          depth,
          targetType: params.targetType ?? "code",
          model: params.model,
          thinking: params.thinking,
          prompt: params.prompt,
          retry: params.retry,
        }, controller.signal, (progress, event) => {
          monitor.observe({ type: "message_update" });
          onUpdate?.({ content: [{ type: "text", text: progress }], details: { progress: event } });
        }, monitor);
        const critique = await readJson<{ findings?: Array<{ severity: "critical" | "high" | "medium" | "low"; description: string; verification?: { verdict?: string } }> }>(join(taskDir(root, params.featureId, params.taskId), "critique", "latest.json"));
        const findings: VerificationFinding[] = (critique.findings ?? []).map((item) => ({
          severity: item.severity,
          status: item.verification?.verdict === "false-positive" ? "false-positive" : "open",
          summary: sanitizeSummary(item.description),
        }));
        await monitor.phaseChange("verifying-acceptance", "Rerunning required acceptance tests", { completed: 0, active: 1, total: requirements.acceptanceTests.length });
        const verification = planned.mode === "focused"
          ? await reviewVerification(sourceAttempt, requirements, evidenceCheck.evidence, source.worktree, source.commit, findings, planned.mode)
          : await rerunAcceptanceTests(requirements, evidenceCheck.evidence, source.worktree, source.commit, findings, {
          signal: controller.signal,
          onProgress: async (progress) => {
            if (progress.status === "running") await monitor.phaseChange("verifying-acceptance", `Rerunning ${progress.testId}`, { completed: progress.completed, active: 1, total: progress.total });
            else await monitor.milestone(`${progress.testId}: ${progress.status}`, { completed: progress.completed, active: 0, total: progress.total });
          },
        });
        const verificationPath = join(taskDir(root, params.featureId, params.taskId), "verification-report.json");
        await writeVerificationReport(verificationPath, verification);
        const broadFindings = (critique.findings ?? []).map((item) => ({ severity: item.severity, location: "review", description: item.description, sourceReviewId: `broad:${source.currentAttempt}` }));
        await atomicJson(lifecyclePath(root, params.featureId, params.taskId), recordReviewCompletion(lifecycle, planned, source.commit, broadFindings));
        await monitor.terminal(verification.approved ? "success" : "failure", verification.approved ? "Review and acceptance verification approved" : "Review completed but verification refused approval");
        return { content: [{ type: "text", text: `${report}\nMachine verification: ${verificationPath}\nApproved: ${verification.approved}` }], details: { ...verification, operationId: _id } };
      } catch (error: any) {
        if (!monitor.isTerminal) await monitor.terminal(controller.signal.aborted ? "cancelled" : "failure", controller.signal.aborted ? "Review cancelled" : "Review failed; inspect persisted diagnostics");
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });

  pi.registerTool({
    name: "agent_integrate",
    label: "Integrate Task",
    description: "Cherry-pick a reviewed writing task's isolated commit into the coordinator worktree.",
    parameters: Type.Object({
      featureId: Type.String(),
      taskId: Type.String(),
      hardTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional operation timeout; disabled by default" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const root = await projectRoot(ctx.cwd);
      const status = await readStatus(root, params.featureId, params.taskId);
      if (status.state !== "review") throw new Error(`Task must be in review state, currently: ${status.state}`);
      if (!status.commit) throw new Error("Task has no commit to integrate");
      const monitor = await ProgressMonitor.start({
        root,
        featureId: params.featureId,
        taskId: params.taskId,
        attempt: status.currentAttempt,
        operationId: _id,
        operation: "integration",
        phase: "verification-gate",
        hardTimeoutMs: params.hardTimeoutMs,
        onDelivery: (event) => onUpdate?.({ content: [{ type: "text", text: formatProgress(event) }], details: { progress: event } }),
      });
      const controller = new AbortController();
      const abort = () => controller.abort();
      monitor.setCancelHandler(abort);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      try {
        await monitor.milestone("Current-commit verification report approved");
        await monitor.phaseChange("integrating", "Cherry-picking reviewed commit and running comprehensive exact-commit final gate");
        const integrated = await executeDirectFinalIntegration(root, params.featureId, params.taskId, controller.signal, { independentReview: testHooks?.directFinalReviewer });
        await markCbpiWorktreeCollected(root, `${params.featureId}-${params.taskId}-a${status.currentAttempt}`, { sourceCommit: integrated.sourceCommit, coordinatorCommit: integrated.coordinatorCommit }).catch(() => undefined);
        const policy = await loadWorkflowConfig(root);
        const retention = resolveRetentionPolicy(policy.retention);
        const compaction = retention.compaction
          ? await compactSuccessfulAttempt(root, { featureId: params.featureId, taskId: params.taskId, attempt: status.currentAttempt }, { integrated: true }).catch(() => undefined)
          : undefined;
        const cleanup = policy.cleanup?.retainWorktree ? [] : await reconcileCbpiLifecycle(root, {}).catch(() => []);
        await monitor.terminal("success", "Task integrated");
        return { content: [{ type: "text", text: `Integrated ${params.taskId} via ${integrated.sourceCommit}; direct final gate passed at ${integrated.coordinatorCommit}` }], details: { commit: integrated.sourceCommit, coordinatorCommit: integrated.coordinatorCommit, finalGate: integrated.gate, operationId: _id, compaction, cleanup } };
      } catch (error: any) {
        if (!monitor.isTerminal) await monitor.terminal(controller.signal.aborted ? "cancelled" : "failure", controller.signal.aborted ? "Integration cancelled" : "Integration failed; inspect persisted diagnostics");
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}

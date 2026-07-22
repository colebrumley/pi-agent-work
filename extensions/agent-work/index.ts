import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { integrationBlockers, rerunAcceptanceTests, sanitizeSummary, validateBuilderEvidence, writeVerificationReport, type BuilderEvidence, type VerificationFinding, type VerificationReport } from "./verification.ts";
import {
  acceptRun,
  applyProposal,
  approveProposal,
  cancelRun,
  getRun,
  listProposals,
  listRuns,
  retryRunTask,
  runReflection,
  startRun,
  suspendRuns,
  type RunDeclaration,
  type RunExecutor,
  type RunTaskDeclaration,
} from "./runs.ts";
import { ancestorEvidence, createEvidenceManifest, finalGateBlockers, intermediateEvidencePlan, mayExecuteCommand, type EvidenceManifest, type EvidenceRecord } from "./evidence.ts";
import { classifyChangedSurfaceFromDiff, recordReviewCompletion, reviewPlan, type ReviewLifecycleState, type ReviewMode } from "./review-lifecycle.ts";
import { createPromptSlice, renderPromptSlice, type PromptSliceRole } from "./prompt-slice.ts";
import { diagnoseMissingRouteFeedback, escalationFromRouteFeedback, readRouteFeedback, settleTerminalRoute, validEscalationDiagnosis } from "./routing-feedback.ts";
import { compactSuccessfulAttempt, markAttemptOwned, pruneFailedAttemptDiagnostics, resolveRetentionPolicy, writeIntegrityManifest } from "./retention.ts";
import { diagnoseGitAnomalies, markCbpiWorktreeCollected, planGitRepair, reconcileCbpiLifecycle, registerCbpiWorktree } from "./lifecycle.ts";
import { loadWorkflowConfig, type WorkflowOverrides } from "./workflow-config.ts";

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

async function writeEvidenceManifest(root: string, featureId: string, taskId: string, attempt: number, requirementsRevision: string, commit: string, evidence: BuilderEvidence): Promise<EvidenceManifest> {
  const path = join(attemptDir(root, featureId, taskId, attempt), "evidence-manifest.json");
  const prior = (await exists(path)) ? await readJson<EvidenceManifest>(path) : undefined;
  const ancestor = prior && prior.commit !== commit ? ancestorEvidence(prior.records, commit) : [];
  const records: EvidenceRecord[] = evidence.tests.map((test, index) => ({
    id: `builder-${index + 1}`, command: test.command, commandIdentity: "", kind: "full-suite",
    requirementsRevision, commit, environment: test.environment, result: test.result,
    artifactHash: test.artifact?.sha256, fidelity: "integration", scenarios: test.scenarios,
    freshness: "fresh",
  }));
  const manifest = createEvidenceManifest({ requirementsRevision, commit, records: [...ancestor, ...records] });
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

function truncate(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n\n[Truncated ${text.length - OUTPUT_LIMIT} characters; inspect the on-disk artifact for the complete content.]`;
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
    retry?: boolean;
    cwdOverride?: string;
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
      const evidenceCheck = await validateBuilderEvidence(requirements, rawEvidence);
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
      if (changes) {
        await command("git", ["add", "-A"], childCwd);
        await command("git", ["commit", "-m", `agent-work(${taskId}): ${input.title}`], childCwd);
        commit = (await command("git", ["rev-parse", "HEAD"], childCwd)).stdout.trim();
      }
      if (commit && builderEvidence) {
        builderEvidence.implementationCommit = commit;
        await atomicJson(evidencePath, builderEvidence);
        const requirements = loadState(requirementsDir(root, featureId));
        await writeEvidenceManifest(root, featureId, taskId, attempt, requirements.requirementsRevision, commit, builderEvidence);
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
  },
  signal: AbortSignal | undefined,
  onProgress?: ProgressCallback,
  monitor?: ProgressMonitor,
): Promise<string> {
  const perspectives = perspectivesFor(input.targetType, input.depth);
  const attackFindings: CritiqueFinding[] = [];
  const reviewRootTask = safeId(`${input.taskId}-critique`);

  for (const [perspectiveIndex, perspective] of perspectives.entries()) {
    if (signal?.aborted) throw new Error("Subagent aborted");
    await monitor?.phaseChange("reviewing", `Reviewing via ${perspective}`, { completed: perspectiveIndex, active: 1, total: perspectives.length });
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
        "Final response should include the findings report; also include maker handoff JSON summary field with the report text.",
      ].join("\n"),
      mode: "read",
      profile: `critique-${perspective}`,
      dependsOn: [input.taskId],
      model: input.model,
      thinking: input.thinking,
      retry: input.retry,
      cwdOverride: input.worktree,
      skipRequirementsGate: true,
      systemExtra: "You are a critique attacker. Stay in your assigned perspective.",
    }, signal, onProgress);
    attackFindings.push(...parseFindings(result.finalText, perspective));
    await monitor?.milestone(`Completed ${perspective} review`, { completed: perspectiveIndex + 1, active: 0, total: perspectives.length });
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

async function reviewTaskForRun(root: string, featureId: string, task: RunTaskDeclaration, signal: AbortSignal): Promise<{ approved: boolean; corrections?: number }> {
  const source = await readStatus(root, featureId, task.id);
  if (!source.worktree || !source.commit) throw new Error("Writing task is missing an isolated commit");
  const requirements = loadState(requirementsDir(root, source.featureId));
  const evidencePath = join(attemptDir(root, source.featureId, task.id, source.currentAttempt), "evidence.json");
  const evidenceCheck = await validateBuilderEvidence(requirements, await readJson<unknown>(evidencePath), source.commit);
  if (!evidenceCheck.valid || !evidenceCheck.evidence) throw new Error("Review refused invalid builder evidence");
  await runMultiPerspectiveReview(root, {
    featureId: source.featureId,
    taskId: task.id,
    worktree: source.worktree,
    depth: "standard",
    targetType: "code",
    retry: true,
  }, signal);
  const critique = await readJson<{ findings?: Array<{ severity: "critical" | "high" | "medium" | "low"; description: string; verification?: { verdict?: string } }> }>(join(taskDir(root, source.featureId, task.id), "critique", "latest.json"));
  const findings: VerificationFinding[] = (critique.findings ?? []).map((item) => ({
    severity: item.severity,
    status: item.verification?.verdict === "false-positive" ? "false-positive" : "open",
    summary: sanitizeSummary(item.description),
  }));
  const verification = await rerunAcceptanceTests(requirements, evidenceCheck.evidence, source.worktree, source.commit, findings, { signal });
  await writeVerificationReport(join(taskDir(root, source.featureId, task.id), "verification-report.json"), verification);
  return { approved: verification.approved, corrections: findings.filter((finding) => finding.status === "open").length };
}

async function integrateTaskForRun(root: string, featureId: string, task: RunTaskDeclaration, signal: AbortSignal): Promise<void> {
  const status = await readStatus(root, featureId, task.id);
  if (status.state === "integrated") return;
  if (status.state !== "review" || !status.commit) throw new Error("Task is not ready for gated integration");
  const requirements = loadState(requirementsDir(root, featureId));
  const verificationPath = join(taskDir(root, featureId, task.id), "verification-report.json");
  const verification = await exists(verificationPath) ? await readJson<unknown>(verificationPath) : undefined;
  const blockers = await finalIntegrationBlockers(root, featureId, task.id, status.currentAttempt, requirements, status.commit, await taskIsHighRisk(root, featureId, task.id, status.currentAttempt));
  if (blockers.length) throw new Error("Integration verification gate refused the task");
  const taskRecord = await readTask(root, featureId, task.id);
  for (const dependency of taskRecord.dependsOn) {
    const dependencyStatus = await readStatus(root, featureId, dependency);
    if (!["done", "integrated"].includes(dependencyStatus.state)) throw new Error("Integration dependency gate refused the task");
  }
  await withRootLock(root, async () => {
    await assertClean(root);
    await command("git", ["cherry-pick", status.commit!], root, signal);
  });
  const coordinatorCommit = (await command("git", ["rev-parse", "HEAD"], root)).stdout.trim();
  status.state = "integrated";
  status.message = `Integrated ${status.commit}`;
  await writeStatus(root, status);
  await appendJsonl(join(featureDir(root, featureId), "decisions.jsonl"), { timestamp: now(), type: "integration", taskId: task.id, commit: status.commit, coordinatorCommit });
  await markCbpiWorktreeCollected(root, `${featureId}-${task.id}-a${status.currentAttempt}`, { sourceCommit: status.commit, coordinatorCommit }).catch(() => undefined);
  await compactSuccessfulAttempt(root, { featureId, taskId: task.id, attempt: status.currentAttempt }, { integrated: true }).catch(() => undefined);
  await reconcileCbpiLifecycle(root, {}).catch(() => []);
}

function executorForRoot(root: string, featureId: string): RunExecutor {
  return {
    async delegate(task, context) {
      const alreadyExists = await exists(join(taskDir(root, featureId, task.id), "task.json"));
      const started = Date.now();
      await runTask(root, {
        featureId,
        taskId: task.id,
        title: task.title,
        prompt: task.prompt,
        mode: task.mode,
        profile: task.profile ?? (task.mode === "write" ? "worker" : "scout"),
        dependsOn: task.dependsOn,
        model: task.model,
        thinking: task.thinking,
        complexity: task.complexity,
        risk: task.risk,
        prefer: task.prefer,
        retry: alreadyExists || context.retry,
      }, context.signal);
      const status = await readStatus(root, featureId, task.id);
      let cost = 0;
      try {
        const invocation = await readJson<InvocationRecord>(join(attemptDir(root, featureId, task.id, status.currentAttempt), "invocation.json"));
        cost = invocation.usage?.cost ?? 0;
      } catch { /* bounded telemetry is optional */ }
      const outcome = status.state === "review" ? "review" : status.state === "done" || status.state === "integrated" ? "completed" : status.state === "blocked" ? "blocked" : status.state === "cancelled" ? "cancelled" : "failed";
      return { outcome, durationMs: Date.now() - started, cost };
    },
    review: (task, context) => reviewTaskForRun(root, featureId, task, context.signal),
    integrate: (task, context) => integrateTaskForRun(root, featureId, task, context.signal),
  };
}

/** Set by extension factory so runTask can gate routing on successful activation. */
let activeSessionProfileRuntime: SessionProfileRuntime | undefined;
/** Opaque Pi session identity for attributing delegated outcomes to the initiating session. */
let activeSessionId: string | undefined;

export default function agentWorkExtension(pi: ExtensionAPI) {
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
    description: "Run an isolated persistent Pi subagent. Writing tasks require a handoff-ready schema-v2 requirements package; forceRequirements never bypasses readiness.",
    parameters: Type.Object({
      featureId: Type.String(),
      taskId: Type.String(),
      title: Type.String(),
      prompt: Type.String(),
      mode: StringEnum(["read", "write"] as const),
      profile: Type.Optional(StringEnum(["worker", "reviewer", "scout"] as const)),
      dependsOn: Type.Optional(Type.Array(Type.String())),
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
      const root = await projectRoot(ctx.cwd);
      const result = await runTask(root, {
        featureId: params.featureId,
        taskId: params.taskId,
        title: params.title,
        prompt: params.prompt,
        mode: params.mode,
        profile: params.profile ?? (params.mode === "write" ? "worker" : "scout"),
        dependsOn: params.dependsOn ?? [],
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
        const state = await acceptRun(root, declaration);
        await startRun(root, params.featureId, params.runId, executor);
        return { content: [{ type: "text", text: `Accepted run ${params.runId}; scheduling continues non-blockingly.\nState: ${join(featureDir(root, params.featureId), "runs", params.runId, "state.json")}` }], details: state };
      }
      if (params.action === "status") {
        const state = await getRun(root, params.featureId, params.runId);
        const taskLines = Object.values(state.tasks).map((task) => `${task.id}: ${task.state}${task.waitReason ? ` (${task.waitReason})` : ""}`);
        const summary = [`Run ${params.runId}: ${state.state}${state.outcome ? `/${state.outcome}` : ""}`, `Agents: ${state.activeCount}/${state.effectiveCap}`, ...taskLines, `Reflection: ${state.reflection.status}${state.reflection.path ? ` — ${state.reflection.path}` : ""}`].join("\n");
        return { content: [{ type: "text", text: truncate(summary) }], details: state };
      }
      if (params.action === "reflect") {
        const state = await runReflection(root, params.featureId, params.runId, true);
        return { content: [{ type: "text", text: `Reflection ${state.reflection.status}${state.reflection.path ? `: ${state.reflection.path}` : state.reflection.reason ? `: ${state.reflection.reason}` : ""}` }], details: state };
      }
      await startRun(root, params.featureId, params.runId, executor);
      if (params.action === "cancel") await cancelRun(root, params.featureId, params.runId, params.taskId);
      else if (params.action === "retry") {
        if (!params.taskId) throw new Error("retry requires taskId");
        await retryRunTask(root, params.featureId, params.runId, params.taskId);
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
          const slice = renderPromptSlice(createPromptSlice(requirements, {
            role, sourcePath: join(requirementsDir(root, params.featureId), "handoff.md"), sourceHash: requirements.requirementsRevision,
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
            const records: EvidenceRecord[] = verification.tests.filter((test) => test.command).flatMap((test, index) => {
              const base: EvidenceRecord = {
              id: `final-${index + 1}`, command: test.command!, commandIdentity: "", kind: "full-suite",
              requirementsRevision: requirements.requirementsRevision, commit: source.commit, environment: "independent-review",
              result: test.status === "passed" ? "passed" : "failed", artifactHash: test.artifact?.sha256,
              fidelity: "integration", scenarios: requirements.acceptanceTests.find((item) => item.id === test.testId)?.categories ?? [], freshness: "fresh",
              };
              return requirements.acceptanceTests.find((item) => item.id === test.testId)?.fidelityLayer === "real-end-to-end" ? [base, { ...base, id: `${base.id}-flow`, kind: "flow" }] : [base];
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
        const requirements = loadState(requirementsDir(root, params.featureId));
        const verificationPath = join(taskDir(root, params.featureId, params.taskId), "verification-report.json");
        const verification = await exists(verificationPath) ? await readJson<unknown>(verificationPath) : undefined;
        const workflow = await loadWorkflowConfig(root);
        const highRisk = await taskIsHighRisk(root, params.featureId, params.taskId, status.currentAttempt);
        const verificationBlockers = workflow.compatibility?.allowHighRiskWithoutFinalGate && highRisk
          ? integrationBlockers(requirements, status.commit, verification)
          : await finalIntegrationBlockers(root, params.featureId, params.taskId, status.currentAttempt, requirements, status.commit, highRisk);
        if (verificationBlockers.length) throw new Error(`Integration refused:\n- ${verificationBlockers.join("\n- ")}`);
        await monitor.milestone("Current-commit verification report approved");
        await monitor.phaseChange("dependency-gate", "Checking task dependencies");
        const task = await readTask(root, params.featureId, params.taskId);
        for (const dependency of task.dependsOn) {
          const dependencyStatus = await readStatus(root, params.featureId, dependency);
          if (!["done", "integrated"].includes(dependencyStatus.state)) {
            throw new Error(`Dependency ${dependency} is not complete: ${dependencyStatus.state}`);
          }
        }
        await monitor.phaseChange("integrating", "Cherry-picking independently verified commit");
        await withRootLock(root, async () => {
          await assertClean(root);
          await command("git", ["cherry-pick", status.commit!], root, controller.signal);
        });
        const coordinatorCommit = (await command("git", ["rev-parse", "HEAD"], root)).stdout.trim();
        status.state = "integrated";
        status.message = `Integrated ${status.commit}`;
        await writeStatus(root, status);
        await appendJsonl(join(featureDir(root, params.featureId), "decisions.jsonl"), {
          timestamp: now(),
          type: "integration",
          taskId: params.taskId,
          commit: status.commit,
          coordinatorCommit,
        });
        await markCbpiWorktreeCollected(root, `${params.featureId}-${params.taskId}-a${status.currentAttempt}`, { sourceCommit: status.commit, coordinatorCommit }).catch(() => undefined);
        const policy = await loadWorkflowConfig(root);
        const retention = resolveRetentionPolicy(policy.retention);
        const compaction = retention.compaction
          ? await compactSuccessfulAttempt(root, { featureId: params.featureId, taskId: params.taskId, attempt: status.currentAttempt }, { integrated: true }).catch(() => undefined)
          : undefined;
        const cleanup = policy.cleanup?.retainWorktree ? [] : await reconcileCbpiLifecycle(root, {}).catch(() => []);
        await monitor.terminal("success", "Task integrated");
        return { content: [{ type: "text", text: `Integrated ${params.taskId} via ${status.commit}` }], details: { commit: status.commit, operationId: _id, compaction, cleanup } };
      } catch (error: any) {
        if (!monitor.isTerminal) await monitor.terminal(controller.signal.aborted ? "cancelled" : "failure", controller.signal.aborted ? "Integration cancelled" : "Integration failed; inspect persisted diagnostics");
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}

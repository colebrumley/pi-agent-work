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
import { CRITICAL_FEEDBACK_PROTOCOL, ROUTER_ORCHESTRATION_PROTOCOL, perspectivePrompt, perspectivesFor, type CritiqueDepth, type CritiqueTargetType } from "./policy.ts";
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
import { loadRouterConfig, routeTask, routerConfigPath, type RouteComplexity, type RouteRisk } from "./router.ts";
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
import { SCHEMA_VERSION, type Handoff, type InvocationRecord, type SessionReference, type TaskMode, type TaskRecord } from "./types.ts";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 40_000;
const rootLocks = new Map<string, Promise<void>>();

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

async function command(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
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
  },
  signal: AbortSignal | undefined,
  onProgress?: (text: string) => void,
): Promise<{ receipt: string; finalText: string; attemptPath: string; sessionFile?: string }> {
  const feature = await assertFeature(root, input.featureId);
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
  const route = routeTask(await loadRouterConfig(root), {
    taskId, title: input.title, prompt: input.prompt, mode: input.mode, profile: input.profile, attempt,
    complexity: input.complexity, risk: input.risk, prefer: input.prefer,
  }, input.model, input.thinking);
  const selectedModel = route.selectedModel;
  const selectedThinking = input.thinking ?? route.thinking;
  const eventsFile = join(attemptPath, "events.jsonl");
  const handoffPath = join(attemptPath, "handoff.json");
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

  const status = await readStatus(root, featureId, taskId);
  Object.assign(status, {
    state: "running",
    currentAttempt: attempt,
    branch: undefined,
    worktree: undefined,
    message: undefined,
  });
  await writeStatus(root, status);

  if (input.mode === "write" && !input.skipRequirementsGate) {
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
      ? `Write the required handoff to: ${handoffPath}`
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

  try {
    const run = await runPi({ cwd: childCwd, args, eventsFile, signal, onProgress });
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
      });
      return {
        receipt: finalReceipt({ featureId, taskId, attempt, state: status.state, attemptPath, sessionFile, summary: status.message }),
        finalText: run.finalText,
        attemptPath,
        sessionFile,
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
        });
        return {
          receipt: finalReceipt({ featureId, taskId, attempt, state: status.state, attemptPath, sessionFile, summary: status.message }),
          finalText: run.finalText,
          attemptPath,
          sessionFile,
        };
      }
    }

    handoff.featureId = featureId;
    handoff.taskId = taskId;
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
    if (input.mode === "write" && handoff.status === "done") {
      const changes = (await command("git", ["status", "--porcelain"], childCwd)).stdout.trim();
      if (changes) {
        await command("git", ["add", "-A"], childCwd);
        await command("git", ["commit", "-m", `agent-work(${taskId}): ${input.title}`], childCwd);
        commit = (await command("git", ["rev-parse", "HEAD"], childCwd)).stdout.trim();
      }
    }

    status.state = handoff.status === "done" ? (input.mode === "write" && commit ? "review" : "done") : handoff.status;
    status.commit = commit;
    status.message = handoff.summary;
    await writeStatus(root, status);
    await appendJsonl(join(rootDir(root), "routing-decisions.jsonl"), {
      timestamp: now(), type: "outcome", featureId, taskId, attempt, model: selectedModel,
      state: status.state, durationMs: invocationRecord.durationMs, usage: run.usage,
      correction: attempt > 1,
    });
    return {
      receipt: finalReceipt({ featureId, taskId, attempt, state: status.state, attemptPath, sessionFile, commit, summary: handoff.summary }),
      finalText: run.finalText || handoff.summary,
      attemptPath,
      sessionFile,
    };
  } catch (error: any) {
    status.state = signal?.aborted ? "cancelled" : "failed";
    status.message = error?.message ?? String(error);
    await writeStatus(root, status);
    await appendJsonl(join(rootDir(root), "routing-decisions.jsonl"), {
      timestamp: now(), type: "outcome", featureId, taskId, attempt, model: selectedModel,
      state: status.state, correction: attempt > 1, error: status.message,
    });
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
  onProgress?: (text: string) => void,
): Promise<string> {
  const perspectives = perspectivesFor(input.targetType, input.depth);
  const attackFindings: CritiqueFinding[] = [];
  const reviewRootTask = safeId(`${input.taskId}-critique`);

  for (const perspective of perspectives) {
    if (signal?.aborted) throw new Error("Subagent aborted");
    onProgress?.(`Attacking via ${perspective}...`);
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
  }

  let findings = dedupeFindings(attackFindings);
  const dropped: CritiqueFinding[] = [];
  const verifyPool = findings
    .filter((f) => f.severity === "critical" || f.severity === "high")
    .slice(0, 10);

  for (const [index, finding] of verifyPool.entries()) {
    if (signal?.aborted) throw new Error("Subagent aborted");
    onProgress?.(`Verifying ${finding.severity} finding ${index + 1}/${verifyPool.length}...`);
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

export default function agentWorkExtension(pi: ExtensionAPI) {
  registerStatusFooter(pi);
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${CRITICAL_FEEDBACK_PROTOCOL}\n\n${ROUTER_ORCHESTRATION_PROTOCOL}`,
  }));

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
          text: `Created feature ${feature.id}\nBrief: ${join(featureDir(root, feature.id), "brief.md")}\nRequirements: ${reqDir}\nNext: run /requirements or agent_requirements until handoff-ready.`,
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
    description: "Run an isolated persistent Pi subagent. Writing tasks require a handoff-ready requirements package (or forceRequirements).",
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
      forceRequirements: Type.Optional(Type.Boolean({ description: "Allow write delegation with a forced risk-flagged requirements handoff" })),
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
      }, signal, (progress) => onUpdate?.({ content: [{ type: "text", text: progress }], details: {} }));
      return { content: [{ type: "text", text: result.receipt }], details: { attemptPath: result.attemptPath, sessionFile: result.sessionFile } };
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
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      const config = await loadRouterConfig(root);
      const logPath = join(rootDir(root), "routing-decisions.jsonl");
      if (params.action === "status") {
        return { content: [{ type: "text", text: `Config: ${routerConfigPath(root)}\nTelemetry: ${logPath}\n\n${JSON.stringify(config, null, 2)}` }], details: config };
      }
      if (params.action === "feedback") {
        if (!params.featureId || !params.taskId || !params.outcome) throw new Error("feedback requires featureId, taskId, and outcome");
        const status = await readStatus(root, params.featureId, params.taskId);
        const attempt = params.attempt ?? status.currentAttempt;
        await appendJsonl(logPath, { timestamp: now(), type: "feedback", featureId: params.featureId, taskId: params.taskId, attempt, outcome: params.outcome, note: params.note });
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
      const report = { generatedAt: now(), totals: { routes: routes.length, outcomes: outcomes.length, feedback: feedback.length }, models };
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: report };
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
      const result = await runPi({ cwd: session.cwd, args, eventsFile: queryFile, signal, onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }) });
      let amendedCommit: string | undefined;
      if (params.allowChanges && result.exitCode === 0) {
        const changes = (await command("git", ["status", "--porcelain"], session.cwd)).stdout.trim();
        if (changes) {
          await command("git", ["add", "-A"], session.cwd);
          if (status.commit) await command("git", ["commit", "--amend", "--no-edit"], session.cwd);
          else await command("git", ["commit", "-m", `agent-work(${params.taskId}): follow-up revision`], session.cwd);
          amendedCommit = (await command("git", ["rev-parse", "HEAD"], session.cwd)).stdout.trim();
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
      return {
        content: [{ type: "text", text: amendedCommit ? `${response}\n\nAmended task commit: ${amendedCommit}` : response }],
        details: { session: session.file, eventsFile: queryFile, commit: amendedCommit },
      };
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
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const root = await projectRoot(ctx.cwd);
      const source = await readStatus(root, params.featureId, params.taskId);
      if (!source.worktree) throw new Error(`Task ${params.taskId} has no worktree to review`);

      if (params.singleReviewer) {
        const result = await runTask(root, {
          featureId: params.featureId,
          taskId: `${params.taskId}-review`,
          title: `Review ${params.taskId}`,
          prompt: params.prompt ?? `Review task ${params.taskId}. Inspect HEAD, its diff, and the working tree.`,
          mode: "read",
          profile: "reviewer",
          dependsOn: [params.taskId],
          model: params.model,
          thinking: params.thinking,
          retry: params.retry,
          cwdOverride: source.worktree,
          skipRequirementsGate: true,
        }, signal, (progress) => onUpdate?.({ content: [{ type: "text", text: progress }], details: {} }));
        return { content: [{ type: "text", text: result.receipt }], details: {} };
      }

      const report = await runMultiPerspectiveReview(root, {
        featureId: params.featureId,
        taskId: params.taskId,
        worktree: source.worktree,
        depth: params.depth ?? "standard",
        targetType: params.targetType ?? "code",
        model: params.model,
        thinking: params.thinking,
        prompt: params.prompt,
        retry: params.retry,
      }, signal, (progress) => onUpdate?.({ content: [{ type: "text", text: progress }], details: {} }));
      return { content: [{ type: "text", text: report }], details: {} };
    },
  });

  pi.registerTool({
    name: "agent_integrate",
    label: "Integrate Task",
    description: "Cherry-pick a reviewed writing task's isolated commit into the coordinator worktree.",
    parameters: Type.Object({ featureId: Type.String(), taskId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await projectRoot(ctx.cwd);
      const status = await readStatus(root, params.featureId, params.taskId);
      if (status.state !== "review") throw new Error(`Task must be in review state, currently: ${status.state}`);
      if (!status.commit) throw new Error("Task has no commit to integrate");
      const task = await readTask(root, params.featureId, params.taskId);
      for (const dependency of task.dependsOn) {
        const dependencyStatus = await readStatus(root, params.featureId, dependency);
        if (!["done", "integrated"].includes(dependencyStatus.state)) {
          throw new Error(`Dependency ${dependency} is not complete: ${dependencyStatus.state}`);
        }
      }
      await withRootLock(root, async () => {
        await assertClean(root);
        await command("git", ["cherry-pick", status.commit!], root);
      });
      status.state = "integrated";
      status.message = `Integrated ${status.commit}`;
      await writeStatus(root, status);
      await appendJsonl(join(featureDir(root, params.featureId), "decisions.jsonl"), {
        timestamp: now(),
        type: "integration",
        taskId: params.taskId,
        commit: status.commit,
      });
      return { content: [{ type: "text", text: `Integrated ${params.taskId} via ${status.commit}` }], details: { commit: status.commit } };
    },
  });
}

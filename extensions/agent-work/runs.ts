import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { appendJsonl, atomicJson, exists, featureDir, now, readJson, rootDir, safeId } from "./storage.ts";
import type { TaskMode } from "./types.ts";

export const RUN_SCHEMA_VERSION = 1;
export const DEFAULT_RUN_CONCURRENCY = 3;
export const MAX_RUN_TASKS = 200;
const MAX_TASK_PROMPT_CHARS = 40_000;
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "blocked", "cancelled"]);
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_DECLARED_SURFACE_ENTRIES = 8;
const REPO_WIDE_SURFACE = /(?:^|[-_\s])(?:repo(?:sitory)?|codebase|all|whole|entire|everything)(?:$|[-_\s])/i;
const WILDCARD_SURFACE = /[*?[\]{}]/;
const SPECIFIC_SURFACE = /^(?:(?:[A-Za-z0-9][A-Za-z0-9._/@:-]*\/)+(?:[A-Za-z0-9][A-Za-z0-9._/@:-]*)?|[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9._-]+)$/;
const LIST_LIKE_OUTCOME = /[,;\n&+|/]|\b(?:and|then|also|plus|as well as|along with|while|before|with)\b|(?:^|\s)(?:\d+[.)]|[-*])\s/i;
const VACUOUS_NON_GOAL = /^(?:(?:none|nothing|n\/?a)(?:\b|[\s:,-])|not applicable\.?$|no (?:non-?goals?|exclusions?|unrelated changes?)\.?$|(?:do not|don't) (?:exclude|have|specify) (?:any )?(?:non-?goals?|exclusions?|changes)|avoid having any non-?goals|do not exclude changes outside scope|leave everything in scope\.?)$/i;
const MEANINGFUL_NON_GOAL = /\b(?:do not|exclude|out of scope|avoid|leave|no unrelated)\b/i;
const SHELL_META = /[;&|><`$(){}\[\]\\]|(?:^|\s)(?:<<|>>)(?:\s|$)/;
const INLINE_INTERPRETER = /(?:^|\s)(?:node|nodejs|python(?:3)?|ruby|perl)\s+(?:-e|-c|-)(?:\s|$)/i;
export type CommandFidelity = "static" | "unit" | "integration" | "realistic-smoke" | undefined;
export function commandFidelity(command: string): CommandFidelity {
  const value = command.trim();
  if (/^git diff --check$|^(?:npx )?(?:tsc|eslint)\b|^(?:npm|pnpm|yarn) run (?:lint|check|typecheck|static)\b/i.test(value)) return "static";
  if (/^(?:npm|pnpm|yarn) run smoke\b/i.test(value)) return "realistic-smoke";
  if (/^(?:npm|pnpm|yarn) run integration\b/i.test(value)) return "integration";
  if (/^(?:npm|pnpm|yarn) run unit\b/i.test(value)) return "unit";
  if (/(?:production-gates|lifecycle|integration)\b/i.test(value)) return "integration";
  if (/(?:\.unit\.|\.spec\.|\.test\.)|(?:jest|vitest)\b/i.test(value)) return "unit";
  if (/(?:production-gates|smoke)\b/i.test(value)) return "realistic-smoke";
  return undefined;
}
const DIRECT_VERIFICATION = /^(?:npm\s+(?:test|run\s+(?:test|lint|check|typecheck|build|smoke|integration|unit|static))(?:\s+--(?!help|version|dry-run)[A-Za-z0-9._=-]+)*|pnpm\s+(?:test|lint|check|typecheck|build)(?:\s+--[A-Za-z0-9._=-]+)*|yarn\s+(?:test|lint|check|typecheck|build)(?:\s+--[A-Za-z0-9._=-]+)*|(?:npx\s+)?(?:vitest|jest)\s+[A-Za-z0-9._/@-]+|git\s+diff\s+--check|(?:npx\s+)?(?:tsc|eslint)(?:\s+[A-Za-z0-9._/@=-]+)*|cargo\s+(?:test|check|clippy|build)(?:\s+[A-Za-z0-9._/@=-]+)*|go\s+test(?:\s+[A-Za-z0-9._/@=-]+)*|pytest(?:\s+[A-Za-z0-9._/@=-]+)*|ruff\s+(?:check|format)(?:\s+[A-Za-z0-9._/@=-]+)*|mypy(?:\s+[A-Za-z0-9._/@=-]+)*|make\s+(?:test|check|lint|build))$/i;

export function invalidSurface(surface: unknown): boolean {
  return !Array.isArray(surface) || surface.length === 0 || surface.length > MAX_DECLARED_SURFACE_ENTRIES
    || surface.some((item) => typeof item !== "string" || !item.trim() || REPO_WIDE_SURFACE.test(item.trim()) || WILDCARD_SURFACE.test(item) || !SPECIFIC_SURFACE.test(item.trim()) || /(?:^|[/\\])\.\.(?:[/\\]|$)|^(?:\/|~)/.test(item.trim()));
}

export function invalidOutcome(outcome: unknown): boolean {
  return typeof outcome !== "string" || !outcome.trim() || LIST_LIKE_OUTCOME.test(outcome.trim());
}

export function invalidNonGoals(nonGoals: unknown): boolean {
  return !Array.isArray(nonGoals) || nonGoals.length === 0 || nonGoals.some((item) => typeof item !== "string" || !item.trim() || VACUOUS_NON_GOAL.test(item.trim()) || !MEANINGFUL_NON_GOAL.test(item.trim()));
}

export function invalidVerificationCommands(commands: unknown): boolean {
  return !Array.isArray(commands) || commands.length === 0 || commands.some((item) => {
    if (typeof item !== "string" || !item.trim()) return true;
    const command = item.trim();
    return SHELL_META.test(command) || INLINE_INTERPRETER.test(command) || /(?:^|\s)(?:--(?:help|version|dry-run|if-present|silent-if-missing|collect-only|no-run|showConfig)|-list)\b/i.test(command) || !DIRECT_VERIFICATION.test(command);
  });
}

/** Shared pre-launch contract for every direct or scheduled delegation. */
export function boundedDelegationContractIssues(task: Pick<RunTaskDeclaration, "outcome" | "surface" | "nonGoals" | "verificationCommands">): string[] {
  const issues: string[] = [];
  if (invalidOutcome(task.outcome)) issues.push("outcome must be one non-list coherent outcome");
  if (invalidSurface(task.surface)) issues.push(`surface must contain 1-${MAX_DECLARED_SURFACE_ENTRIES} specific non-wildcard entries`);
  if (invalidNonGoals(task.nonGoals)) issues.push("nonGoals must contain at least one meaningful exclusion");
  if (invalidVerificationCommands(task.verificationCommands)) issues.push("verificationCommands must contain objective non-no-op checks");
  return issues;
}

export type RunTaskState = "queued" | "running" | "review" | "integration" | "blocked" | "failed" | "cancelled" | "completed";
export type RunOutcome = "success" | "failed" | "blocked" | "cancelled";
export type ReflectionStatus = "not-started" | "pending" | "complete" | "skipped" | "failed";
export type CheckpointReviewTrigger = "public-contract" | "architecture" | "security-trust-boundary" | "data-migration" | "concurrency" | "expanded-acceptance-scope" | "uncertain";
export type CheckpointReviewMode = "focused" | "broad";

export interface RunTaskDeclaration {
  id: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  profile?: string;
  dependsOn: string[];
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  complexity?: "tiny" | "small" | "medium" | "large";
  risk?: "low" | "medium" | "high";
  prefer?: "cost" | "speed" | "quality" | "balanced";
  /** Single, declarative outcome for this bounded delegation. */
  outcome: string;
  /** Files or components intentionally in scope; structural explicitness only. */
  surface: string[];
  /** Explicit exclusions that prevent accidental scope expansion. */
  nonGoals: string[];
  /** Commands whose success objectively verifies the declared outcome. */
  verificationCommands: string[];
  /** Optional ordered writing checkpoint; declaration order is turn order. */
  checkpoint?: string;
  /** Shared coherent outcome; required and identical for every member of a multi-turn checkpoint. */
  checkpointOutcome?: string;
  /** Shared allowed surface; required and identical for every member of a multi-turn checkpoint. */
  checkpointSurface?: string[];
  /** Conservative declared review triggers for the checkpoint containing this turn. */
  reviewTriggers?: CheckpointReviewTrigger[];
  /** Acceptance tests affected by this turn. Omission preserves legacy all-tests behavior. */
  affectedAcceptanceTestIds?: string[];
  /** Coordinator-owned canonical acceptance command mapping; never supplied by worker evidence. */
  acceptanceChecks?: Array<{ testId: string; command: string }>;
}

export interface RunDeclaration {
  schemaVersion: 1;
  id: string;
  featureId: string;
  tasks: RunTaskDeclaration[];
  concurrency?: number;
  /** Load-only marker for pre-bounded persisted graphs; never accepted on new submission. */
  legacy?: true;
}

export interface RunTaskRuntime {
  id: string;
  state: RunTaskState;
  stageAttempt: number;
  retryCount: number;
  waitReason?: "waiting-dependencies" | "waiting-capacity" | "waiting-integration-order" | "dependency-failed" | "integration-conflict" | "missing-implementation-commit";
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  cost: number;
  corrections: number;
  targetedEvidence?: { requirementsRevision: string; testIds: string[]; evidencePath: string; recordedAt: string };
}

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  featureId: string;
  state: "accepted" | "running" | "terminal";
  effectiveCap: number;
  activeCount: number;
  maxActiveCount: number;
  tasks: Record<string, RunTaskRuntime>;
  integrationOrder: string[];
  integrated: string[];
  checkpoints: Record<string, { members: string[]; finalTaskId: string; outcome: string; allowedSurface: string[]; reviewMode: CheckpointReviewMode; reviewRationale: string; affectedAcceptanceTestIds?: string[] }>;
  cancellationRequested: boolean;
  /** Exact coordinator HEAD returned after the latest checkpoint integration. */
  combinedCoordinatorCommit?: string;
  finalGate: {
    status: "pending" | "running" | "passed" | "blocked";
    reportPath?: string;
    reason?: string;
  };
  outcome?: RunOutcome;
  reflection: {
    status: ReflectionStatus;
    attempt: number;
    path?: string;
    reason?: "insufficient-evidence";
    diagnosticCode?: "reflection-generation-failed";
  };
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface RunTransition {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  type: "run-accepted" | "task-transition" | "retry-requested" | "cancel-requested" | "run-terminal" | "reflection-transition" | "final-gate-transition";
  taskId?: string;
  from?: RunTaskState;
  to?: RunTaskState;
  reason?: string;
  activeCount: number;
  cap: number;
}

export interface StageResult {
  outcome: "completed" | "review" | "failed" | "blocked" | "cancelled";
  durationMs?: number;
  cost?: number;
  corrections?: number;
  targetedEvidence?: { requirementsRevision: string; testIds: string[]; evidencePath: string; recordedAt: string };
  checkpointReview?: { mode: CheckpointReviewMode; rationale: string };
}

export interface RunExecutor {
  delegate(task: RunTaskDeclaration, context: { runId: string; retry: boolean; signal: AbortSignal; checkpointId?: string; checkpointFinal: boolean }): Promise<StageResult>;
  review(task: RunTaskDeclaration, context: { runId: string; signal: AbortSignal; mode: CheckpointReviewMode; rationale: string; checkpointMembers: string[]; affectedAcceptanceTestIds?: string[]; turnAcceptanceTestIds: Record<string, string[] | undefined>; turnAcceptanceChecks: Record<string, Array<{ testId: string; command: string }> | undefined> }): Promise<{ approved: boolean; corrections?: number }>;
  integrate(task: RunTaskDeclaration, context: { runId: string; signal: AbortSignal; affectedAcceptanceTestIds?: string[] }): Promise<void | { combinedCoordinatorCommit: string }>;
  /** Test/adapter supplied independent final verification; production wiring is intentionally separate. */
  finalGate?: (context: { runId: string; featureId: string; combinedCoordinatorCommit: string; signal: AbortSignal }) => Promise<{ combinedCoordinatorCommit: string; passed: boolean; evidenceComplete: boolean; findings: Array<{ severity: "critical" | "high" | "medium" | "low"; status: "open" | "resolved" | "false-positive" }>; reportPath?: string; reason?: string }>;
}

export interface ReflectionEvidence {
  schemaVersion: 1;
  runId: string;
  outcome: RunOutcome;
  elapsedMs: number;
  cap: number;
  maxActiveCount: number;
  tasks: Array<{
    id: string;
    state: RunTaskState;
    durationMs: number;
    cost: number;
    retryCount: number;
    corrections: number;
    waitReason?: string;
  }>;
  transitionCounts: Record<string, number>;
  integrationOrder: string[];
}

export type ReflectionCategory = "elapsed-cost-hotspots" | "idle-blocked-time" | "retries-corrections" | "duplicated-work" | "avoidable-serialization" | "quality-escapes";
export interface ReflectionConclusion {
  category: ReflectionCategory;
  kind: "finding" | "no-op";
  summary: string;
  evidence: Array<{ metric: string; value: number | string; taskId?: string }>;
  confidence: "low" | "medium" | "high";
  recommendation: string;
  opportunityKey?: string;
}
export interface ReflectionReport {
  schemaVersion: 1;
  runId: string;
  featureId: string;
  outcome: RunOutcome;
  generatedAt: string;
  evidenceBoundary: "sanitized-structured-lifecycle-v1";
  conclusions: ReflectionConclusion[];
}

export interface ProposalRecord {
  schemaVersion: 1;
  id: string;
  opportunityKey: string;
  state: "pending" | "approved" | "applied";
  sourceRuns: string[];
  createdAt: string;
  updatedAt: string;
  audit: Array<{ timestamp: string; action: "approved" | "applied"; operator: string }>;
}

export interface GraphValidationIssue { code: string; taskId?: string; dependency?: string; message: string }

const BROAD_CHECKPOINT_TRIGGERS = new Set<CheckpointReviewTrigger>(["public-contract", "architecture", "security-trust-boundary", "data-migration", "concurrency", "expanded-acceptance-scope", "uncertain"]);
export function selectCheckpointReview(triggers: readonly CheckpointReviewTrigger[] = []): { mode: CheckpointReviewMode; rationale: string } {
  const matched = [...new Set(triggers)].filter((trigger) => BROAD_CHECKPOINT_TRIGGERS.has(trigger));
  return matched.length
    ? { mode: "broad", rationale: `broad review required: ${matched.join(", ")}` }
    : { mode: "focused", rationale: "focused review: no broad-review trigger declared" };
}

export function selectSealedCheckpointReview(
  declaredTriggers: readonly CheckpointReviewTrigger[] = [],
  sealedKinds: readonly string[] = [],
  classificationSucceeded = true,
): { mode: CheckpointReviewMode; rationale: string } {
  const mapped = sealedKinds.flatMap((kind): CheckpointReviewTrigger[] => kind === "trust-security-boundary" ? ["security-trust-boundary"]
    : kind === "acceptance-scope" ? ["expanded-acceptance-scope"]
    : kind === "data-migration" || kind === "concurrency" || kind === "uncertain" ? [kind]
    : kind === "public-contract" || kind === "architecture" ? [kind]
    : []);
  const selected = selectCheckpointReview([...declaredTriggers, ...mapped, ...(classificationSucceeded ? [] : ["uncertain" as const])]);
  return selected.mode === "broad" && mapped.length
    ? { mode: "broad", rationale: `${selected.rationale}; sealed diff triggers: ${[...new Set(mapped)].join(", ")}` }
    : selected;
}

function runDir(root: string, featureId: string, runId: string): string {
  return join(featureDir(root, featureId), "runs", safeId(runId, "run id"));
}
function graphPath(root: string, featureId: string, runId: string): string { return join(runDir(root, featureId, runId), "graph.json"); }
function statePath(root: string, featureId: string, runId: string): string { return join(runDir(root, featureId, runId), "state.json"); }
function eventsPath(root: string, featureId: string, runId: string): string { return join(runDir(root, featureId, runId), "events.jsonl"); }
function reportPath(root: string, featureId: string, runId: string): string { return join(runDir(root, featureId, runId), "reflection.json"); }

export function validateRunDeclaration(input: unknown): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  if (!input || typeof input !== "object") return [{ code: "invalid-declaration", message: "Run declaration must be an object" }];
  const value = input as Partial<RunDeclaration>;
  if (value.schemaVersion !== RUN_SCHEMA_VERSION) issues.push({ code: "invalid-schema", message: "Run declaration schemaVersion must be 1" });
  if (typeof value.id !== "string" || !SAFE_IDENTIFIER.test(value.id)) issues.push({ code: "invalid-run-id", message: "Run id must match [a-z0-9][a-z0-9._-]{0,79}" });
  if (typeof value.featureId !== "string" || !SAFE_IDENTIFIER.test(value.featureId)) issues.push({ code: "invalid-feature-id", message: "Feature id must match [a-z0-9][a-z0-9._-]{0,79}" });
  if (value.concurrency !== undefined && (!Number.isInteger(value.concurrency) || value.concurrency < 1)) issues.push({ code: "invalid-concurrency", message: "Concurrency override must be a positive integer" });
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    issues.push({ code: "empty-graph", message: "Run declaration must contain at least one task" });
    return issues;
  }
  if (value.tasks.length > MAX_RUN_TASKS) issues.push({ code: "graph-too-large", message: `Run declaration exceeds the ${MAX_RUN_TASKS}-task bounded artifact limit` });
  const counts = new Map<string, number>();
  for (const task of value.tasks) {
    const id = typeof task?.id === "string" ? task.id : "";
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!SAFE_IDENTIFIER.test(id)) issues.push({ code: "invalid-task-id", taskId: id || undefined, message: `Task id ${JSON.stringify(id)} is invalid` });
    if (!task || typeof task.title !== "string" || !task.title.trim() || task.title.length > 500) issues.push({ code: "invalid-title", taskId: id, message: `Task ${id || "<unknown>"} requires a title of at most 500 characters` });
    if (!task || typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.length > MAX_TASK_PROMPT_CHARS) issues.push({ code: "invalid-prompt", taskId: id, message: `Task ${id || "<unknown>"} requires a prompt of at most ${MAX_TASK_PROMPT_CHARS} characters` });
    if (!task || !["read", "write"].includes(task.mode)) issues.push({ code: "invalid-mode", taskId: id, message: `Task ${id || "<unknown>"} mode must be read or write` });
    if (!task || !Array.isArray(task.dependsOn)) issues.push({ code: "invalid-dependencies", taskId: id, message: `Task ${id || "<unknown>"} dependsOn must be an array` });
    if (!task || invalidOutcome(task.outcome)) issues.push({ code: "invalid-outcome", taskId: id, message: `Task ${id || "<unknown>"} requires one non-list coherent outcome; split multiple outcomes into separate declarations` });
    if (!task || invalidSurface(task.surface)) issues.push({ code: "invalid-surface", taskId: id, message: `Task ${id || "<unknown>"} requires 1-${MAX_DECLARED_SURFACE_ENTRIES} specific non-wildcard file or component surfaces; repo-wide scope must be split` });
    if (!task || invalidNonGoals(task.nonGoals)) issues.push({ code: "invalid-non-goals", taskId: id, message: `Task ${id || "<unknown>"} requires explicit meaningful non-goals; none/N/A is not a scope boundary` });
    if (!task || invalidVerificationCommands(task.verificationCommands)) issues.push({ code: "invalid-verification-commands", taskId: id, message: `Task ${id || "<unknown>"} requires an objective verification command; echo, printf, and true are not verification` });
    if (task?.checkpoint !== undefined && (typeof task.checkpoint !== "string" || !SAFE_IDENTIFIER.test(task.checkpoint))) issues.push({ code: "invalid-checkpoint", taskId: id, message: `Task ${id || "<unknown>"} checkpoint must be a stable identifier` });
    if (task?.checkpoint && task.mode !== "write") issues.push({ code: "read-only-checkpoint", taskId: id, message: `Read-only task ${id} cannot join a writing checkpoint` });
    if (task?.reviewTriggers !== undefined && (!Array.isArray(task.reviewTriggers) || task.reviewTriggers.some((trigger) => typeof trigger !== "string" || !BROAD_CHECKPOINT_TRIGGERS.has(trigger as CheckpointReviewTrigger)))) issues.push({ code: "invalid-review-trigger", taskId: id, message: `Task ${id || "<unknown>"} has an invalid checkpoint review trigger` });
    if (task?.affectedAcceptanceTestIds !== undefined && (!Array.isArray(task.affectedAcceptanceTestIds) || !task.affectedAcceptanceTestIds.length || task.affectedAcceptanceTestIds.some((testId) => typeof testId !== "string" || !SAFE_IDENTIFIER.test(testId)) || new Set(task.affectedAcceptanceTestIds).size !== task.affectedAcceptanceTestIds.length)) issues.push({ code: "invalid-affected-acceptance-tests", taskId: id, message: `Task ${id || "<unknown>"} affectedAcceptanceTestIds must contain unique stable acceptance-test identifiers` });
    if (task?.acceptanceChecks !== undefined) {
      const checks = task.acceptanceChecks;
      if (!Array.isArray(checks) || !checks.length || checks.some((check) => !check || typeof check.testId !== "string" || typeof check.command !== "string" || invalidVerificationCommands([check.command])) || new Set(checks.map((check) => check.testId)).size !== checks.length) issues.push({ code: "invalid-acceptance-checks", taskId: id, message: `Task ${id || "<unknown>"} acceptanceChecks must contain unique testId/objective-command pairs` });
      else if (!task.affectedAcceptanceTestIds || checks.length !== task.affectedAcceptanceTestIds.length || checks.some((check) => !task.affectedAcceptanceTestIds!.includes(check.testId))) issues.push({ code: "acceptance-check-mapping-mismatch", taskId: id, message: `Task ${id || "<unknown>"} acceptanceChecks must map each declared affected acceptance test exactly once` });
    }
  }
  for (const [id, count] of counts) if (id && count > 1) issues.push({ code: "duplicate-task-id", taskId: id, message: `Duplicate task id: ${id}` });
  const canonicalByTest = new Map<string, { command: string; taskId: string }>();
  for (const task of value.tasks) for (const check of task?.acceptanceChecks ?? []) {
    const prior = canonicalByTest.get(check.testId);
    if (!prior) canonicalByTest.set(check.testId, { command: check.command, taskId: task.id });
    else if (prior.command !== check.command) issues.push({ code: "conflicting-acceptance-check", taskId: task.id, message: `Acceptance test ${check.testId} has conflicting coordinator commands in ${prior.taskId} and ${task.id}; rescope or declare one canonical command` });
  }
  const ids = new Set(value.tasks.map((task) => task?.id).filter((id): id is string => typeof id === "string"));
  for (const task of value.tasks) {
    if (!Array.isArray(task?.dependsOn)) continue;
    const seenDependencies = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (typeof dependency !== "string") {
        issues.push({ code: "invalid-dependency-id", taskId: task.id, message: `Task ${task.id} has a non-string dependency` });
        continue;
      }
      if (seenDependencies.has(dependency)) issues.push({ code: "duplicate-dependency", taskId: task.id, dependency, message: `Task ${task.id} repeats dependency ${dependency}` });
      seenDependencies.add(dependency);
      if (dependency === task.id) issues.push({ code: "self-dependency", taskId: task.id, dependency, message: `Task ${task.id} cannot depend on itself` });
      if (!ids.has(dependency)) issues.push({ code: "missing-dependency", taskId: task.id, dependency, message: `Task ${task.id} depends on unknown task ${dependency}` });
    }
  }
  const validUnique = value.tasks.filter((task) => task && counts.get(task.id) === 1 && SAFE_IDENTIFIER.test(task.id));
  const validIds = new Set(validUnique.map((task) => task.id));
  const indegree = new Map(validUnique.map((task) => [task.id, 0]));
  const followers = new Map(validUnique.map((task) => [task.id, [] as string[]]));
  const edges = new Set<string>();
  const addEdge = (from: string, to: string) => {
    const key = `${from}\0${to}`; if (edges.has(key)) return; edges.add(key);
    indegree.set(to, (indegree.get(to) ?? 0) + 1); followers.get(from)!.push(to);
  };
  for (const task of validUnique) for (const dependency of task.dependsOn ?? []) if (validIds.has(dependency) && dependency !== task.id) addEdge(dependency, task.id);
  const checkpointMembers = new Map<string, RunTaskDeclaration[]>();
  for (const task of validUnique) if (task.mode === "write") {
    const checkpointId = task.checkpoint ?? task.id;
    checkpointMembers.set(checkpointId, [...(checkpointMembers.get(checkpointId) ?? []), task]);
  }
  const checkpointByMember = new Map<string, { id: string; finalTaskId: string }>();
  for (const [checkpointId, members] of checkpointMembers) for (const member of members) checkpointByMember.set(member.id, { id: checkpointId, finalTaskId: members.at(-1)!.id });
  for (const task of validUnique) for (const dependency of task.dependsOn ?? []) {
    const target = checkpointByMember.get(dependency); const source = checkpointByMember.get(task.id);
    if (target && dependency !== target.finalTaskId && source?.id !== target.id) issues.push({ code: "external-dependency-nonfinal-checkpoint-member", taskId: task.id, dependency, message: `Task ${task.id} must depend on final checkpoint member ${target.finalTaskId}, not intermediate member ${dependency}` });
  }
  for (const [checkpointId, members] of checkpointMembers) {
    if (members.length > 1) {
      const expectedOutcome = members[0].checkpointOutcome;
      const expectedSurface = members[0].checkpointSurface;
      for (const member of members) {
        if (invalidOutcome(member.checkpointOutcome)) issues.push({ code: "missing-checkpoint-outcome", taskId: member.id, message: `Checkpoint ${checkpointId} member ${member.id} requires a shared checkpointOutcome` });
        else if (member.checkpointOutcome !== expectedOutcome) issues.push({ code: "checkpoint-outcome-mismatch", taskId: member.id, message: `Checkpoint ${checkpointId} members must declare exactly the same checkpointOutcome` });
        if (invalidSurface(member.checkpointSurface)) issues.push({ code: "invalid-checkpoint-surface", taskId: member.id, message: `Checkpoint ${checkpointId} member ${member.id} requires 1-${MAX_DECLARED_SURFACE_ENTRIES} specific non-wildcard shared checkpointSurface entries` });
        else if (JSON.stringify(member.checkpointSurface) !== JSON.stringify(expectedSurface)) issues.push({ code: "checkpoint-surface-mismatch", taskId: member.id, message: `Checkpoint ${checkpointId} members must declare exactly the same checkpointSurface` });
        else if (member.surface.some((item) => !member.checkpointSurface!.includes(item))) issues.push({ code: "turn-surface-outside-checkpoint", taskId: member.id, message: `Checkpoint ${checkpointId} turn ${member.id} surface must be a subset of checkpointSurface` });
      }
    }
    for (let index = 1; index < members.length; index++) {
      const prior = members[index - 1]; const current = members[index];
      if (prior.dependsOn.includes(current.id)) issues.push({ code: "checkpoint-order-dependency", taskId: prior.id, dependency: current.id, message: `Checkpoint ${checkpointId} turn ${prior.id} cannot depend on later turn ${current.id}` });
      addEdge(prior.id, current.id);
    }
  }
  const queue = validUnique.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!; visited++;
    for (const follower of followers.get(id) ?? []) {
      const next = (indegree.get(follower) ?? 1) - 1; indegree.set(follower, next);
      if (next === 0) queue.push(follower);
    }
  }
  if (visited !== validUnique.length) {
    const cyclic = validUnique.filter((task) => (indegree.get(task.id) ?? 0) > 0).map((task) => task.id);
    issues.push({ code: "dependency-cycle", message: `Dependency cycle includes: ${cyclic.join(", ")}` });
  }
  return issues;
}

export function stableTopologicalOrder(tasks: RunTaskDeclaration[]): string[] {
  const index = new Map(tasks.map((task, i) => [task.id, i]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const followers = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const edges = new Set<string>();
  const addEdge = (from: string, to: string) => {
    const key = `${from}\0${to}`; if (edges.has(key)) return; edges.add(key);
    indegree.set(to, indegree.get(to)! + 1); followers.get(from)?.push(to);
  };
  for (const task of tasks) for (const dependency of task.dependsOn) addEdge(dependency, task.id);
  const checkpoints = new Map<string, RunTaskDeclaration[]>();
  for (const task of tasks) if (task.mode === "write") {
    const id = task.checkpoint ?? task.id; checkpoints.set(id, [...(checkpoints.get(id) ?? []), task]);
  }
  for (const members of checkpoints.values()) for (let position = 1; position < members.length; position++) addEdge(members[position - 1].id, members[position].id);
  const ready = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const result: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => index.get(a)! - index.get(b)!);
    const id = ready.shift()!; result.push(id);
    for (const follower of followers.get(id) ?? []) {
      indegree.set(follower, indegree.get(follower)! - 1);
      if (indegree.get(follower) === 0) ready.push(follower);
    }
  }
  return result;
}

export function chooseFeatureWorkflow(tasks: Array<{ id: string; dependsOn: string[] }>): "serial" | "run" {
  if (tasks.length < 2) return "serial";
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    return (dependencies.get(from) ?? []).some((dependency) => dependency === target || reaches(dependency, target, seen));
  };
  for (let left = 0; left < tasks.length; left++) for (let right = left + 1; right < tasks.length; right++) {
    if (!reaches(tasks[left].id, tasks[right].id) && !reaches(tasks[right].id, tasks[left].id)) return "run";
  }
  return "serial";
}

async function repositoryCap(root: string): Promise<number> {
  const path = join(rootDir(root), "config.json");
  if (!(await exists(path))) return DEFAULT_RUN_CONCURRENCY;
  const config = await readJson<{ runConcurrency?: unknown }>(path);
  if (config.runConcurrency === undefined) return DEFAULT_RUN_CONCURRENCY;
  if (!Number.isInteger(config.runConcurrency) || (config.runConcurrency as number) < 1) throw new Error(".agent-work/config.json runConcurrency must be a positive integer");
  return config.runConcurrency as number;
}

export async function acceptRun(root: string, declaration: RunDeclaration): Promise<RunRecord> {
  const issues = validateRunDeclaration(declaration);
  if (issues.length) {
    const error = new Error(`Run declaration rejected:\n${issues.map((issue) => `- [${issue.code}] ${issue.message}`).join("\n")}`);
    (error as any).issues = issues;
    throw error;
  }
  const dir = runDir(root, declaration.featureId, declaration.id);
  if (await exists(dir)) throw new Error(`Run already exists: ${declaration.id}`);
  const cap = declaration.concurrency ?? await repositoryCap(root);
  const timestamp = now();
  const order = stableTopologicalOrder(declaration.tasks);
  const checkpoints = new Map<string, string[]>();
  for (const task of declaration.tasks) if (task.mode === "write") {
    const id = task.checkpoint ?? task.id;
    checkpoints.set(id, [...(checkpoints.get(id) ?? []), task.id]);
  }
  const checkpointRecord = Object.fromEntries([...checkpoints].map(([id, members]) => {
    const checkpointTasks = declaration.tasks.filter((task) => members.includes(task.id));
    const triggers = checkpointTasks.flatMap((task) => task.reviewTriggers ?? []);
    const selected = selectCheckpointReview(triggers);
    const affectedAcceptanceTestIds = checkpointTasks.every((task) => task.affectedAcceptanceTestIds !== undefined)
      ? [...new Set(checkpointTasks.flatMap((task) => task.affectedAcceptanceTestIds!))]
      : undefined;
    return [id, { members, finalTaskId: members.at(-1)!, outcome: checkpointTasks[0].checkpointOutcome ?? checkpointTasks[0].outcome, allowedSurface: checkpointTasks[0].checkpointSurface ?? checkpointTasks[0].surface, reviewMode: selected.mode, reviewRationale: selected.rationale, ...(affectedAcceptanceTestIds ? { affectedAcceptanceTestIds } : {}) }];
  }));
  const record: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: declaration.id,
    featureId: declaration.featureId,
    state: "accepted",
    effectiveCap: cap,
    activeCount: 0,
    maxActiveCount: 0,
    tasks: Object.fromEntries(declaration.tasks.map((task) => [task.id, { id: task.id, state: "queued", stageAttempt: 0, retryCount: 0, durationMs: 0, cost: 0, corrections: 0 }])),
    integrationOrder: order.filter((id) => declaration.tasks.find((task) => task.id === id)?.mode === "write" && checkpointRecord[declaration.tasks.find((task) => task.id === id)!.checkpoint ?? id]?.finalTaskId === id),
    integrated: [],
    checkpoints: checkpointRecord,
    cancellationRequested: false,
    finalGate: { status: "pending" },
    reflection: { status: "not-started", attempt: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await mkdir(dir, { recursive: true });
  await atomicJson(graphPath(root, declaration.featureId, declaration.id), declaration);
  await atomicJson(statePath(root, declaration.featureId, declaration.id), record);
  await appendJsonl(eventsPath(root, declaration.featureId, declaration.id), {
    schemaVersion: 1, sequence: 1, timestamp, type: "run-accepted", activeCount: 0, cap,
  } satisfies RunTransition);
  return record;
}

const activeSchedulers = new Map<string, RunScheduler>();
function schedulerKey(root: string, featureId: string, runId: string): string { return `${root}\0${featureId}\0${runId}`; }

class RunScheduler {
  private record!: RunRecord;
  private declaration!: RunDeclaration;
  private sequence = 1;
  private active = new Map<string, { stage: "delegate" | "review"; controller: AbortController }>();
  private integrating?: { taskId: string; controller: AbortController };
  private finalizing?: AbortController;
  private pending = new Set<Promise<void>>();
  private suspended = false;
  private pumping = false;
  private pumpRequested = false;
  private completionResolve!: (record: RunRecord) => void;
  readonly completion = new Promise<RunRecord>((resolve) => { this.completionResolve = resolve; });
  private root: string;
  private featureId: string;
  private runId: string;
  private executor: RunExecutor;

  constructor(root: string, featureId: string, runId: string, executor: RunExecutor) {
    this.root = root;
    this.featureId = featureId;
    this.runId = runId;
    this.executor = executor;
  }

  async start(): Promise<void> {
    this.record = await readJson<RunRecord>(statePath(this.root, this.featureId, this.runId));
    this.declaration = await readJson<RunDeclaration>(graphPath(this.root, this.featureId, this.runId));
    // Detect genuinely old persisted graphs before reading any bounded/checkpoint fields.
    const rawTasks = this.declaration.tasks as unknown[];
    if (!Array.isArray(rawTasks) || rawTasks.some((task: any) => !task || typeof task.id !== "string" || typeof task.title !== "string" || typeof task.prompt !== "string" || !["read", "write"].includes(task.mode))) throw new Error("Legacy persisted run graph is malformed; inspect or migrate it before resume");
    if (rawTasks.some((task: any) => !Object.hasOwn(task, "outcome") || !Object.hasOwn(task, "surface") || !Object.hasOwn(task, "nonGoals") || !Object.hasOwn(task, "verificationCommands"))) {
      this.declaration.legacy = true;
      // Safe old-shape normalization only: arrays needed by the original scheduler, never synthetic bounds/checkpoints.
      for (const task of rawTasks as any[]) task.dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      await atomicJson(graphPath(this.root, this.featureId, this.runId), this.declaration);
    }
    // Migration-safe defaults reconstruct checkpoint scheduling state for persisted pre-checkpoint runs.
    this.record.finalGate ??= { status: "pending" };
    this.record.integrated ??= [];
    this.record.cancellationRequested ??= false;
    this.record.activeCount ??= 0;
    this.record.maxActiveCount ??= 0;
    this.record.reflection ??= { status: "not-started", attempt: 0 };
    this.record.checkpoints ??= {};
    for (const task of this.declaration.tasks.filter((item) => item.mode === "write")) {
      const checkpointId = task.checkpoint ?? task.id;
      const members = this.declaration.tasks.filter((item) => item.mode === "write" && (item.checkpoint ?? item.id) === checkpointId).map((item) => item.id);
      if (!this.record.checkpoints[checkpointId]) {
        const checkpointTasks = this.declaration.tasks.filter((item) => members.includes(item.id));
        const selected = selectCheckpointReview(checkpointTasks.flatMap((item) => item.reviewTriggers ?? []));
        this.record.checkpoints[checkpointId] = { members, finalTaskId: members.at(-1)!, outcome: task.checkpointOutcome ?? task.outcome ?? task.title, allowedSurface: task.checkpointSurface ?? task.surface ?? [], reviewMode: selected.mode, reviewRationale: selected.rationale };
      } else {
        const checkpoint = this.record.checkpoints[checkpointId] as any;
        checkpoint.members ??= members; checkpoint.finalTaskId ??= members.at(-1)!;
        checkpoint.outcome ??= task.checkpointOutcome ?? task.outcome ?? task.title;
        checkpoint.allowedSurface ??= task.checkpointSurface ?? task.surface ?? [];
        checkpoint.reviewMode ??= "focused"; checkpoint.reviewRationale ??= "Legacy persisted checkpoint defaulted to focused review";
      }
    }
    this.record.integrationOrder ??= stableTopologicalOrder(this.declaration.tasks).filter((id) => {
      const task = this.declaration.tasks.find((item) => item.id === id);
      return task?.mode === "write" && this.record.checkpoints[task.checkpoint ?? task.id]?.finalTaskId === id;
    });
    for (const [id, runtime] of Object.entries(this.record.tasks)) {
      runtime.id ??= id; runtime.stageAttempt ??= 0; runtime.retryCount ??= 0; runtime.durationMs ??= 0; runtime.cost ??= 0; runtime.corrections ??= 0;
    }
    await this.save();
    const eventFile = eventsPath(this.root, this.featureId, this.runId);
    if (await exists(eventFile)) this.sequence = (await readFile(eventFile, "utf8")).split(/\r?\n/).filter(Boolean).length;
    if (this.record.state === "terminal") {
      this.completionResolve(this.record);
      if (this.record.reflection.status === "pending") void runReflection(this.root, this.featureId, this.runId);
      return;
    }
    // A restarted Pi cannot retain child process handles. Requeue only nonterminal claimed stages.
    for (const task of Object.values(this.record.tasks)) {
      if (task.state === "running") { task.state = "queued"; task.waitReason = undefined; }
    }
    if (this.record.finalGate.status === "running") this.record.finalGate = { status: "pending", reason: "final gate interrupted; rerun required" };
    this.record.activeCount = 0;
    this.record.state = "running";
    await this.save();
    void this.pump();
  }

  private taskDeclaration(id: string): RunTaskDeclaration { return this.declaration.tasks.find((task) => task.id === id)!; }
  private async save(): Promise<void> { this.record.updatedAt = now(); await atomicJson(statePath(this.root, this.featureId, this.runId), this.record); }
  private async event(event: Omit<RunTransition, "schemaVersion" | "sequence" | "timestamp" | "activeCount" | "cap">): Promise<void> {
    await appendJsonl(eventsPath(this.root, this.featureId, this.runId), {
      schemaVersion: 1, sequence: ++this.sequence, timestamp: now(), ...event,
      activeCount: this.record.activeCount, cap: this.record.effectiveCap,
    } satisfies RunTransition);
  }
  private async transition(task: RunTaskRuntime, to: RunTaskState, reason?: string): Promise<void> {
    if (task.state === to && task.waitReason === reason) return;
    const from = task.state;
    task.state = to;
    task.waitReason = reason as RunTaskRuntime["waitReason"];
    if ((to === "running" || to === "review") && !task.startedAt) task.startedAt = now();
    if (TERMINAL_TASK_STATES.has(to)) task.endedAt ??= now();
    await this.event({ type: "task-transition", taskId: task.id, from, to, reason });
  }

  private dependencies(task: RunTaskDeclaration): RunTaskRuntime[] { return task.dependsOn.map((id) => this.record.tasks[id]); }
  private checkpoint(task: RunTaskDeclaration): RunRecord["checkpoints"][string] | undefined { return task.mode === "write" ? this.record.checkpoints[task.checkpoint ?? task.id] : undefined; }
  private priorCheckpointTurn(task: RunTaskDeclaration): RunTaskRuntime | undefined {
    const checkpoint = this.checkpoint(task); const index = checkpoint?.members.indexOf(task.id) ?? -1;
    return index > 0 ? this.record.tasks[checkpoint!.members[index - 1]] : undefined;
  }
  private async blockFailedDependents(): Promise<void> {
    let changed = true;
    while (changed) {
      changed = false;
      for (const declaration of this.declaration.tasks) {
        const task = this.record.tasks[declaration.id];
        if (TERMINAL_TASK_STATES.has(task.state)) continue;
        const priorTurn = this.priorCheckpointTurn(declaration);
        if (this.dependencies(declaration).some((dependency) => ["failed", "blocked", "cancelled"].includes(dependency.state)) || (priorTurn && ["failed", "blocked", "cancelled"].includes(priorTurn.state))) {
          await this.transition(task, "blocked", "dependency-failed"); changed = true;
        }
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.suspended) return;
    if (this.pumping) { this.pumpRequested = true; return; }
    this.pumping = true;
    this.pumpRequested = false;
    try {
      await this.blockFailedDependents();
      // Reviews are pipelined and prioritized, but share exactly the delegation cap.
      for (const declaration of this.declaration.tasks) {
        if (this.active.size >= this.record.effectiveCap) break;
        const task = this.record.tasks[declaration.id];
        if (task.state === "review" && !this.active.has(task.id) && this.checkpoint(declaration)?.finalTaskId === task.id) this.launchReview(declaration, task);
      }
      for (const declaration of this.declaration.tasks) {
        const task = this.record.tasks[declaration.id];
        if (task.state !== "queued") continue;
        const priorTurn = this.priorCheckpointTurn(declaration);
        if (!this.dependencies(declaration).every((dependency) => dependency.state === "completed") || (priorTurn && priorTurn.state !== "completed")) {
          task.waitReason = "waiting-dependencies"; continue;
        }
        if (this.active.size >= this.record.effectiveCap) { task.waitReason = "waiting-capacity"; continue; }
        this.launchDelegate(declaration, task);
      }
      if (!this.integrating) await this.startNextIntegration();
      if (!this.finalizing) await this.startFinalGate();
      this.record.activeCount = this.active.size;
      this.record.maxActiveCount = Math.max(this.record.maxActiveCount, this.record.activeCount);
      await this.save();
      await this.maybeSettle();
    } finally {
      this.pumping = false;
      if (this.pumpRequested && !this.suspended) { this.pumpRequested = false; queueMicrotask(() => { void this.pump(); }); }
    }
  }

  private launchDelegate(declaration: RunTaskDeclaration, task: RunTaskRuntime): void {
    const controller = new AbortController();
    this.active.set(task.id, { stage: "delegate", controller });
    this.record.activeCount = this.active.size;
    this.record.maxActiveCount = Math.max(this.record.maxActiveCount, this.record.activeCount);
    task.stageAttempt++;
    void this.transition(task, "running").then(() => this.save());
    const checkpoint = this.checkpoint(declaration);
    const pending = this.executor.delegate(declaration, { runId: this.runId, retry: task.stageAttempt > 1, signal: controller.signal, checkpointId: checkpoint ? (declaration.checkpoint ?? declaration.id) : undefined, checkpointFinal: checkpoint?.finalTaskId === declaration.id })
      .then((result) => this.finishDelegate(declaration, task, result))
      .catch(() => this.finishDelegate(declaration, task, { outcome: controller.signal.aborted ? "cancelled" : "failed" }));
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
  }

  private async finishDelegate(declaration: RunTaskDeclaration, task: RunTaskRuntime, result: StageResult): Promise<void> {
    this.active.delete(task.id); this.record.activeCount = this.active.size;
    task.durationMs += Math.max(0, result.durationMs ?? 0); task.cost += Math.max(0, result.cost ?? 0); task.corrections += Math.max(0, result.corrections ?? 0);
    if (result.targetedEvidence) task.targetedEvidence = result.targetedEvidence;
    if (result.checkpointReview && declaration.mode === "write") {
      const checkpoint = this.checkpoint(declaration)!;
      if (result.checkpointReview.mode === "broad" && checkpoint.reviewMode === "broad") {
        if (!checkpoint.reviewRationale.includes(result.checkpointReview.rationale)) checkpoint.reviewRationale = `${checkpoint.reviewRationale}; ${result.checkpointReview.rationale}`;
      } else if (result.checkpointReview.mode === "broad" || checkpoint.reviewMode !== "broad") {
        checkpoint.reviewMode = result.checkpointReview.mode; checkpoint.reviewRationale = result.checkpointReview.rationale;
      }
    }
    if (this.suspended) {
      if (!TERMINAL_TASK_STATES.has(task.state)) { task.state = "queued"; task.waitReason = undefined; await this.save(); }
      return;
    }
    if (task.state === "cancelled") { await this.save(); void this.pump(); return; }
    if (result.outcome === "review" && declaration.mode === "write") {
      const checkpoint = this.checkpoint(declaration)!;
      // Intermediate turns are durable evidence only; they never independently enter review.
      if (checkpoint.finalTaskId !== declaration.id) await this.transition(task, "completed");
      else await this.transition(task, "review");
    } else if (result.outcome === "completed" && declaration.mode === "write" && this.checkpoint(declaration)?.finalTaskId === declaration.id) await this.transition(task, "blocked", "missing-implementation-commit");
    else if (result.outcome === "completed") await this.transition(task, "completed");
    else await this.transition(task, result.outcome === "blocked" ? "blocked" : result.outcome === "cancelled" ? "cancelled" : "failed", result.outcome === "blocked" ? "dependency-failed" : undefined);
    await this.save(); void this.pump();
  }

  private launchReview(declaration: RunTaskDeclaration, task: RunTaskRuntime): void {
    const controller = new AbortController();
    this.active.set(task.id, { stage: "review", controller });
    this.record.activeCount = this.active.size;
    this.record.maxActiveCount = Math.max(this.record.maxActiveCount, this.record.activeCount);
    const checkpoint = this.checkpoint(declaration)!;
    const pending = this.executor.review(declaration, { runId: this.runId, signal: controller.signal, mode: checkpoint.reviewMode, rationale: checkpoint.reviewRationale, checkpointMembers: checkpoint.members, affectedAcceptanceTestIds: checkpoint.affectedAcceptanceTestIds, turnAcceptanceTestIds: Object.fromEntries(checkpoint.members.map((id) => [id, this.taskDeclaration(id).affectedAcceptanceTestIds])), turnAcceptanceChecks: Object.fromEntries(checkpoint.members.map((id) => [id, this.taskDeclaration(id).acceptanceChecks]) ) })
      .then((result) => this.finishReview(task, result.approved, result.corrections ?? 0))
      .catch(() => this.finishReview(task, false, 0, controller.signal.aborted));
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
  }

  private async finishReview(task: RunTaskRuntime, approved: boolean, corrections: number, cancelled = false): Promise<void> {
    this.active.delete(task.id); this.record.activeCount = this.active.size; task.corrections += Math.max(0, corrections);
    if (this.suspended) { await this.save(); return; }
    if (task.state === "cancelled") { await this.save(); void this.pump(); return; }
    await this.transition(task, cancelled ? "cancelled" : approved ? "integration" : "failed");
    await this.save(); void this.pump();
  }

  private async startNextIntegration(): Promise<void> {
    for (const id of this.record.integrationOrder) {
      const task = this.record.tasks[id];
      if (this.record.integrated.includes(id) || TERMINAL_TASK_STATES.has(task.state)) continue;
      if (task.state !== "integration") { if (task.state === "review") task.waitReason = "waiting-integration-order"; return; }
      const declaration = this.taskDeclaration(id);
      const controller = new AbortController(); this.integrating = { taskId: id, controller };
      const checkpoint = this.checkpoint(declaration);
      const pending = this.executor.integrate(declaration, { runId: this.runId, signal: controller.signal, affectedAcceptanceTestIds: checkpoint?.affectedAcceptanceTestIds })
        .then((result) => this.finishIntegration(task, true, false, result?.combinedCoordinatorCommit))
        .catch(() => this.finishIntegration(task, false, controller.signal.aborted));
      this.pending.add(pending);
      void pending.finally(() => this.pending.delete(pending));
      return;
    }
  }

  private async finishIntegration(task: RunTaskRuntime, success: boolean, cancelled = false, combinedCoordinatorCommit?: string): Promise<void> {
    this.integrating = undefined;
    if (this.suspended) { task.state = "integration"; await this.save(); return; }
    if (task.state === "cancelled") { await this.save(); void this.pump(); return; }
    if (success) {
      if (!combinedCoordinatorCommit || !/^[0-9a-f]{40,64}$/i.test(combinedCoordinatorCommit)) {
        await this.transition(task, "blocked", "integration-conflict");
        await this.save(); void this.pump(); return;
      }
      this.record.combinedCoordinatorCommit = combinedCoordinatorCommit;
      if (!this.record.integrated.includes(task.id)) this.record.integrated.push(task.id);
      const checkpoint = this.checkpoint(this.taskDeclaration(task.id));
      for (const member of checkpoint?.members ?? [task.id]) if (this.record.tasks[member].state !== "completed") await this.transition(this.record.tasks[member], "completed");
    }
    else await this.transition(task, cancelled ? "cancelled" : "blocked", cancelled ? undefined : "integration-conflict");
    await this.save(); void this.pump();
  }

  private async startFinalGate(): Promise<void> {
    if (this.record.finalGate.status !== "pending" || this.record.cancellationRequested || !this.record.integrationOrder.length || this.record.integrated.length !== this.record.integrationOrder.length) return;
    if (!this.record.combinedCoordinatorCommit || !this.executor.finalGate) {
      this.record.finalGate = { status: "blocked", reason: !this.executor.finalGate ? "final gate executor unavailable; rerun with final-gate executor" : "combined coordinator commit missing; rerun integration" };
      await this.event({ type: "final-gate-transition", reason: this.record.finalGate.reason });
      await this.save();
      return;
    }
    const controller = new AbortController(); this.finalizing = controller;
    this.record.finalGate = { status: "running" };
    await this.event({ type: "final-gate-transition", reason: this.record.combinedCoordinatorCommit });
    await this.save();
    const expectedCommit = this.record.combinedCoordinatorCommit;
    const pending = this.executor.finalGate({ runId: this.runId, featureId: this.featureId, combinedCoordinatorCommit: expectedCommit, signal: controller.signal })
      .then((report) => this.finishFinalGate(report, expectedCommit, controller.signal.aborted))
      .catch(() => this.finishFinalGate(undefined, expectedCommit, controller.signal.aborted));
    this.pending.add(pending); void pending.finally(() => this.pending.delete(pending));
  }

  private async finishFinalGate(report: { combinedCoordinatorCommit: string; passed: boolean; evidenceComplete: boolean; findings: Array<{ severity: "critical" | "high" | "medium" | "low"; status: "open" | "resolved" | "false-positive" }>; reportPath?: string; reason?: string } | undefined, expectedCommit: string, cancelled: boolean): Promise<void> {
    this.finalizing = undefined;
    if (this.suspended) { this.record.finalGate = { status: "pending", reason: "final gate interrupted; rerun required" }; await this.save(); return; }
    if (this.record.cancellationRequested || cancelled) { await this.save(); void this.pump(); return; }
    const severe = report?.findings?.some((finding) => ["critical", "high"].includes(finding.severity) && finding.status === "open") ?? false;
    if (report?.passed && report.evidenceComplete && !severe && report.combinedCoordinatorCommit === expectedCommit && expectedCommit === this.record.combinedCoordinatorCommit) {
      this.record.finalGate = { status: "passed", reportPath: report.reportPath };
    } else {
      const reason = !report
        ? "final gate executor failed; repair infrastructure and rerun final gate"
        : report.combinedCoordinatorCommit !== expectedCommit
          ? "final report commit is stale or mismatched; rerun final gate"
          : severe ? "final report contains unresolved critical/high findings; resolve and rerun final gate"
          : !report.evidenceComplete ? "final evidence is missing or incomplete; rerun every applicable layer"
          : report.reason ?? "final gate failed; rerun final gate";
      this.record.finalGate = { status: "blocked", reportPath: report?.reportPath, reason };
    }
    await this.event({ type: "final-gate-transition", reason: this.record.finalGate.status === "passed" ? expectedCommit : this.record.finalGate.reason });
    await this.save(); void this.pump();
  }

  private async maybeSettle(): Promise<void> {
    if (this.active.size || this.integrating || this.finalizing || Object.values(this.record.tasks).some((task) => !TERMINAL_TASK_STATES.has(task.state))) return;
    const allCheckpointsIntegrated = this.record.integrationOrder.length > 0 && this.record.integrated.length === this.record.integrationOrder.length;
    if (!this.record.cancellationRequested && allCheckpointsIntegrated && this.record.finalGate.status === "pending") return;
    if (!this.record.cancellationRequested && allCheckpointsIntegrated && this.record.finalGate.status === "running") return;
    if (this.record.state === "terminal") return;
    const states = Object.values(this.record.tasks).map((task) => task.state);
    this.record.outcome = this.record.cancellationRequested ? "cancelled"
      : this.record.finalGate.status === "blocked" ? "blocked"
      : states.includes("failed") ? "failed"
      : states.includes("blocked") ? "blocked"
      : states.includes("cancelled") ? "cancelled" : "success";
    this.record.state = "terminal"; this.record.terminalAt = now();
    this.record.reflection = { status: "pending", attempt: Math.max(1, this.record.reflection.attempt) };
    await this.event({ type: "run-terminal", reason: this.record.outcome });
    await this.save();
    this.completionResolve(this.record);
    activeSchedulers.delete(schedulerKey(this.root, this.featureId, this.runId));
    queueMicrotask(() => { void runReflection(this.root, this.featureId, this.runId); });
  }

  async cancel(taskId?: string): Promise<void> {
    if (this.record.state === "terminal") return;
    await this.event({ type: "cancel-requested", taskId, reason: taskId ? "task" : "run" });
    if (!taskId) {
      this.record.cancellationRequested = true;
      for (const task of Object.values(this.record.tasks)) if (!TERMINAL_TASK_STATES.has(task.state)) await this.transition(task, "cancelled");
      for (const item of this.active.values()) item.controller.abort();
      this.integrating?.controller.abort();
      this.finalizing?.abort();
    } else {
      const task = this.record.tasks[taskId]; if (!task) throw new Error(`Unknown run task: ${taskId}`);
      if (!TERMINAL_TASK_STATES.has(task.state)) await this.transition(task, "cancelled");
      this.active.get(taskId)?.controller.abort(); if (this.integrating?.taskId === taskId) this.integrating.controller.abort();
      await this.blockFailedDependents();
    }
    await this.save(); void this.pump();
  }

  async retry(taskId: string): Promise<void> {
    if (this.record.state === "terminal" && ["pending", "not-started"].includes(this.record.reflection.status)) {
      await runReflection(this.root, this.featureId, this.runId);
    }
    const task = this.record.tasks[taskId]; if (!task) throw new Error(`Unknown run task: ${taskId}`);
    if (!["failed", "cancelled", "blocked"].includes(task.state)) throw new Error(`Task ${taskId} is not retryable from ${task.state}`);
    if (task.state === "blocked" && task.waitReason === "dependency-failed") throw new Error(`Retry the failed prerequisite for ${taskId} instead`);
    const integrationRetry = task.state === "blocked" && task.waitReason === "integration-conflict";
    const from = task.state; task.state = integrationRetry ? "integration" : "queued"; task.waitReason = undefined; task.endedAt = undefined; task.retryCount++;
    this.record.state = "running"; this.record.outcome = undefined; this.record.terminalAt = undefined; this.record.reflection = { status: "not-started", attempt: this.record.reflection.attempt };
    await this.event({ type: "retry-requested", taskId, from, to: task.state, reason: "explicit" });
    // Dependents blocked solely by this branch are re-evaluated, never launched until prerequisites complete.
    for (const declaration of this.declaration.tasks) {
      const dependent = this.record.tasks[declaration.id];
      if (dependent.state === "blocked" && dependent.waitReason === "dependency-failed") { dependent.state = "queued"; dependent.waitReason = "waiting-dependencies"; dependent.endedAt = undefined; }
    }
    await this.save(); void this.pump();
  }

  async retryFinalGate(): Promise<void> {
    if (this.record.state === "terminal" && ["pending", "not-started"].includes(this.record.reflection.status)) {
      await runReflection(this.root, this.featureId, this.runId);
      this.record = await readJson<RunRecord>(statePath(this.root, this.featureId, this.runId));
    }
    if (this.record.finalGate.status !== "blocked" || this.record.outcome !== "blocked") throw new Error("Final gate is not blocked and retryable");
    this.record.finalGate = { status: "pending", reason: "explicit final-gate rerun requested" };
    this.record.state = "running"; this.record.outcome = undefined; this.record.terminalAt = undefined;
    this.record.reflection = { status: "not-started", attempt: this.record.reflection.attempt };
    await this.event({ type: "retry-requested", reason: "final-gate" });
    await this.save(); void this.pump();
  }

  async suspend(): Promise<void> {
    this.suspended = true;
    for (const item of this.active.values()) item.controller.abort();
    this.integrating?.controller.abort();
    this.finalizing?.abort();
    await Promise.allSettled([...this.pending]);
    this.active.clear(); this.integrating = undefined; this.record.activeCount = 0;
    await this.save();
    activeSchedulers.delete(schedulerKey(this.root, this.featureId, this.runId));
  }
}

export async function startRun(root: string, featureId: string, runId: string, executor: RunExecutor): Promise<{ completion: Promise<RunRecord> }> {
  const key = schedulerKey(root, featureId, runId);
  const existing = activeSchedulers.get(key); if (existing) return { completion: existing.completion };
  const scheduler = new RunScheduler(root, featureId, runId, executor); activeSchedulers.set(key, scheduler);
  try { await scheduler.start(); } catch (error) { activeSchedulers.delete(key); throw error; }
  return { completion: scheduler.completion };
}

export async function getRun(root: string, featureId: string, runId: string): Promise<RunRecord> {
  return readJson<RunRecord>(statePath(root, featureId, runId));
}

export async function cancelRun(root: string, featureId: string, runId: string, taskId?: string): Promise<void> {
  const scheduler = activeSchedulers.get(schedulerKey(root, featureId, runId));
  if (!scheduler) throw new Error("Run is not active; resume it before cancellation");
  await scheduler.cancel(taskId);
}
export async function retryRunTask(root: string, featureId: string, runId: string, taskId: string): Promise<void> {
  const scheduler = activeSchedulers.get(schedulerKey(root, featureId, runId));
  if (!scheduler) throw new Error("Run is not active; resume it before retry");
  await scheduler.retry(taskId);
}
export async function retryRunFinalGate(root: string, featureId: string, runId: string): Promise<void> {
  const scheduler = activeSchedulers.get(schedulerKey(root, featureId, runId));
  if (!scheduler) throw new Error("Run is not active; resume it before final-gate retry");
  await scheduler.retryFinalGate();
}
export async function suspendRuns(root?: string): Promise<void> {
  await Promise.all([...activeSchedulers.entries()].filter(([key]) => !root || key.startsWith(`${root}\0`)).map(([, scheduler]) => scheduler.suspend()));
  await Promise.allSettled([...activeReflections.entries()].filter(([key]) => !root || key.startsWith(`${root}\0`)).map(([, reflection]) => reflection));
}

export async function listRuns(root: string, featureId?: string): Promise<Array<{ featureId: string; runId: string; state: RunRecord["state"] }>> {
  const featuresRoot = join(rootDir(root), "features"); if (!(await exists(featuresRoot))) return [];
  const featureNames = featureId ? [safeId(featureId)] : (await readdir(featuresRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const result: Array<{ featureId: string; runId: string; state: RunRecord["state"] }> = [];
  for (const currentFeature of featureNames) {
    const runsRoot = join(featuresRoot, currentFeature, "runs"); if (!(await exists(runsRoot))) continue;
    for (const entry of await readdir(runsRoot, { withFileTypes: true })) if (entry.isDirectory() && await exists(join(runsRoot, entry.name, "state.json"))) {
      const state = await readJson<RunRecord>(join(runsRoot, entry.name, "state.json")); result.push({ featureId: currentFeature, runId: entry.name, state: state.state });
    }
  }
  return result;
}

function boundedNumber(value: unknown, maximum = 1_000_000_000): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : 0;
}
function allowedTaskState(value: unknown): value is RunTaskState {
  return typeof value === "string" && ["queued", "running", "review", "integration", "blocked", "failed", "cancelled", "completed"].includes(value);
}
function sanitizedEvidence(record: RunRecord, transitions: RunTransition[]): ReflectionEvidence | undefined {
  if (!record.outcome || !["success", "failed", "blocked", "cancelled"].includes(record.outcome) || !record.terminalAt) return undefined;
  const tasks = Object.values(record.tasks).filter((task) => SAFE_IDENTIFIER.test(task.id) && allowedTaskState(task.state));
  if (!tasks.length || tasks.every((task) => !task.startedAt && boundedNumber(task.durationMs) === 0)) return undefined;
  const counts: Record<string, number> = {};
  for (const event of transitions) if (["run-accepted", "task-transition", "retry-requested", "cancel-requested", "run-terminal", "reflection-transition", "final-gate-transition"].includes(event.type)) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return {
    schemaVersion: 1, runId: SAFE_IDENTIFIER.test(record.runId) ? record.runId : "invalid-run", outcome: record.outcome,
    elapsedMs: boundedNumber(Date.parse(record.terminalAt) - Date.parse(record.createdAt)), cap: Math.max(1, boundedNumber(record.effectiveCap, 1_000)), maxActiveCount: boundedNumber(record.maxActiveCount, 1_000),
    tasks: tasks.map((task) => ({ id: task.id, state: task.state, durationMs: boundedNumber(task.durationMs), cost: boundedNumber(task.cost), retryCount: boundedNumber(task.retryCount, 10_000), corrections: boundedNumber(task.corrections, 10_000), waitReason: ["waiting-dependencies", "waiting-capacity", "waiting-integration-order", "dependency-failed", "integration-conflict"].includes(task.waitReason ?? "") ? task.waitReason : undefined })),
    transitionCounts: counts, integrationOrder: record.integrated.filter((id) => SAFE_IDENTIFIER.test(id)).slice(0, tasks.length),
  };
}

export function buildReflection(featureId: string, input: ReflectionEvidence): ReflectionReport {
  const evidence: ReflectionEvidence = {
    ...input,
    runId: SAFE_IDENTIFIER.test(input.runId) ? input.runId : "invalid-run",
    elapsedMs: boundedNumber(input.elapsedMs), cap: Math.max(1, boundedNumber(input.cap, 1_000)), maxActiveCount: boundedNumber(input.maxActiveCount, 1_000),
    tasks: (Array.isArray(input.tasks) ? input.tasks : []).filter((task) => SAFE_IDENTIFIER.test(task.id) && allowedTaskState(task.state)).slice(0, 1_000).map((task) => ({ ...task, durationMs: boundedNumber(task.durationMs), cost: boundedNumber(task.cost), retryCount: boundedNumber(task.retryCount, 10_000), corrections: boundedNumber(task.corrections, 10_000), waitReason: undefined })),
    transitionCounts: {}, integrationOrder: (Array.isArray(input.integrationOrder) ? input.integrationOrder : []).filter((id) => SAFE_IDENTIFIER.test(id)).slice(0, 1_000),
  };
  const tasksByDuration = [...evidence.tasks].sort((a, b) => b.durationMs - a.durationMs);
  const hotspot = tasksByDuration[0];
  const blocked = evidence.tasks.filter((task) => task.state === "blocked");
  const retries = evidence.tasks.reduce((sum, task) => sum + task.retryCount, 0);
  const corrections = evidence.tasks.reduce((sum, task) => sum + task.corrections, 0);
  const conclusions: ReflectionConclusion[] = [
    hotspot && hotspot.durationMs > 0
      ? { category: "elapsed-cost-hotspots", kind: "finding", summary: "One task was the largest measured elapsed hotspot.", evidence: [{ metric: "durationMs", value: hotspot.durationMs, taskId: hotspot.id }, { metric: "cost", value: hotspot.cost, taskId: hotspot.id }], confidence: "high", recommendation: "Inspect this task's bounded routing and lifecycle telemetry before changing its decomposition.", opportunityKey: "inspect-dominant-task-hotspots" }
      : { category: "elapsed-cost-hotspots", kind: "no-op", summary: "No measured task hotspot was available.", evidence: [], confidence: "low", recommendation: "No change recommended until duration telemetry is available." },
    blocked.length
      ? { category: "idle-blocked-time", kind: "finding", summary: "Blocked work was observed after scheduling settled.", evidence: [{ metric: "blockedTasks", value: blocked.length }], confidence: "high", recommendation: "Review dependency declarations and conflict boundaries for the blocked branch.", opportunityKey: "reduce-blocked-branches" }
      : { category: "idle-blocked-time", kind: "no-op", summary: "No terminal blocked work was observed.", evidence: [{ metric: "blockedTasks", value: 0 }], confidence: "high", recommendation: "No change recommended." },
    retries + corrections > 0
      ? { category: "retries-corrections", kind: "finding", summary: "Explicit retries or corrections occurred.", evidence: [{ metric: "retries", value: retries }, { metric: "corrections", value: corrections }], confidence: "high", recommendation: "Compare the diagnosed retry causes before adjusting prompts or routing.", opportunityKey: "reduce-explicit-corrections" }
      : { category: "retries-corrections", kind: "no-op", summary: "No retries or corrections were recorded.", evidence: [{ metric: "retries", value: 0 }, { metric: "corrections", value: 0 }], confidence: "high", recommendation: "No change recommended." },
    { category: "duplicated-work", kind: "no-op", summary: "No duplicate terminal effects were present in structured lifecycle evidence.", evidence: [{ metric: "integratedTasks", value: evidence.integrationOrder.length }], confidence: "medium", recommendation: "No change recommended; raw commands and session prose were intentionally not inspected." },
    evidence.tasks.length > 1 && evidence.maxActiveCount < Math.min(evidence.cap, evidence.tasks.length)
      ? { category: "avoidable-serialization", kind: "finding", summary: "Observed agent concurrency stayed below available task and configured capacity.", evidence: [{ metric: "maxActiveCount", value: evidence.maxActiveCount }, { metric: "cap", value: evidence.cap }], confidence: "medium", recommendation: "Check dependency and review readiness before increasing or changing concurrency.", opportunityKey: "reduce-avoidable-serialization" }
      : { category: "avoidable-serialization", kind: "no-op", summary: "No clear underuse of available concurrency was observed.", evidence: [{ metric: "maxActiveCount", value: evidence.maxActiveCount }, { metric: "cap", value: evidence.cap }], confidence: "medium", recommendation: "No change recommended." },
    corrections > 0
      ? { category: "quality-escapes", kind: "finding", summary: "Corrections indicate work escaped an earlier quality stage.", evidence: [{ metric: "corrections", value: corrections }], confidence: "medium", recommendation: "Inspect sanitized verification findings and strengthen the earliest applicable objective check.", opportunityKey: "reduce-quality-corrections" }
      : { category: "quality-escapes", kind: "no-op", summary: "No structured correction signal indicated a quality escape.", evidence: [{ metric: "corrections", value: 0 }], confidence: "medium", recommendation: "No change recommended." },
  ];
  const safeFeatureId = SAFE_IDENTIFIER.test(featureId) ? featureId : "invalid-feature";
  const outcome = ["success", "failed", "blocked", "cancelled"].includes(evidence.outcome) ? evidence.outcome : "failed";
  return { schemaVersion: 1, runId: evidence.runId, featureId: safeFeatureId, outcome: outcome as RunOutcome, generatedAt: now(), evidenceBoundary: "sanitized-structured-lifecycle-v1", conclusions };
}

async function readTransitions(root: string, featureId: string, runId: string): Promise<RunTransition[]> {
  const path = eventsPath(root, featureId, runId); if (!(await exists(path))) return [];
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).slice(-5_000);
  return lines.flatMap((line) => { try { const value = JSON.parse(line); return value && value.schemaVersion === 1 ? [value as RunTransition] : []; } catch { return []; } });
}

const activeReflections = new Map<string, Promise<RunRecord>>();

export async function runReflection(root: string, featureId: string, runId: string, force = false, generator: (featureId: string, evidence: ReflectionEvidence) => ReflectionReport = buildReflection): Promise<RunRecord> {
  const key = schedulerKey(root, featureId, runId);
  const active = activeReflections.get(key);
  if (active) return active;
  const operation = performReflection(root, featureId, runId, force, generator);
  activeReflections.set(key, operation);
  try { return await operation; } finally { if (activeReflections.get(key) === operation) activeReflections.delete(key); }
}

async function performReflection(root: string, featureId: string, runId: string, force: boolean, generator: (featureId: string, evidence: ReflectionEvidence) => ReflectionReport): Promise<RunRecord> {
  const path = statePath(root, featureId, runId);
  const record = await readJson<RunRecord>(path);
  if (record.state !== "terminal") throw new Error("Reflection requires a terminal run");
  if (!force && ["complete", "skipped"].includes(record.reflection.status)) return record;
  if (force) record.reflection.attempt++;
  else record.reflection.attempt = Math.max(1, record.reflection.attempt);
  record.reflection.status = "pending"; delete record.reflection.diagnosticCode; delete record.reflection.reason;
  await atomicJson(path, record);
  try {
    const evidence = sanitizedEvidence(record, await readTransitions(root, featureId, runId));
    if (!evidence) {
      record.reflection = { status: "skipped", attempt: record.reflection.attempt, reason: "insufficient-evidence" };
    } else {
      const report = generator(featureId, evidence);
      await atomicJson(reportPath(root, featureId, runId), report);
      record.reflection = { status: "complete", attempt: record.reflection.attempt, path: relative(root, reportPath(root, featureId, runId)) };
      await aggregateProposals(root, report);
    }
  } catch {
    record.reflection = { status: "failed", attempt: record.reflection.attempt, diagnosticCode: "reflection-generation-failed" };
  }
  record.updatedAt = now(); await atomicJson(path, record);
  await appendJsonl(eventsPath(root, featureId, runId), { schemaVersion: 1, sequence: (await readTransitions(root, featureId, runId)).length + 1, timestamp: now(), type: "reflection-transition", reason: record.reflection.status, activeCount: 0, cap: record.effectiveCap } satisfies RunTransition);
  return record;
}

function proposalPath(root: string, id: string): string { return join(rootDir(root), "proposals", `${safeId(id, "proposal id")}.json`); }
async function aggregateProposals(root: string, report: ReflectionReport): Promise<void> {
  const reports: ReflectionReport[] = [];
  for (const run of await listRuns(root)) {
    const path = reportPath(root, run.featureId, run.runId);
    if (await exists(path)) { try { reports.push(await readJson<ReflectionReport>(path)); } catch { /* corrupt reports do not become evidence */ } }
  }
  const opportunities = new Map<string, Set<string>>();
  for (const candidate of reports) for (const finding of candidate.conclusions ?? []) if (finding.kind === "finding" && finding.opportunityKey && finding.confidence !== "low") {
    const runs = opportunities.get(finding.opportunityKey) ?? new Set<string>(); runs.add(`${candidate.featureId}/${candidate.runId}`); opportunities.set(finding.opportunityKey, runs);
  }
  for (const [key, runs] of opportunities) if (runs.size >= 2) {
    const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const path = proposalPath(root, id);
    const timestamp = now();
    const existing = await exists(path) ? await readJson<ProposalRecord>(path) : undefined;
    const proposal: ProposalRecord = existing ?? { schemaVersion: 1, id, opportunityKey: key, state: "pending", sourceRuns: [], createdAt: timestamp, updatedAt: timestamp, audit: [] };
    proposal.sourceRuns = [...new Set([...proposal.sourceRuns, ...runs])].sort(); proposal.updatedAt = timestamp;
    await atomicJson(path, proposal);
  }
}

export async function listProposals(root: string): Promise<ProposalRecord[]> {
  const dir = join(rootDir(root), "proposals"); if (!(await exists(dir))) return [];
  const result: ProposalRecord[] = [];
  for (const entry of await readdir(dir)) if (entry.endsWith(".json")) { try { result.push(await readJson<ProposalRecord>(join(dir, entry))); } catch { /* surfaced by omission, never applied */ } }
  return result;
}
function safeOperator(operator: string): string {
  const value = operator.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,119}$/.test(value)) throw new Error("Operator identity must be a bounded account identifier");
  return value;
}
export async function approveProposal(root: string, id: string, operator: string): Promise<ProposalRecord> {
  const approvedBy = safeOperator(operator);
  const path = proposalPath(root, id); const proposal = await readJson<ProposalRecord>(path);
  if (proposal.state === "pending") { proposal.state = "approved"; proposal.audit.push({ timestamp: now(), action: "approved", operator: approvedBy }); proposal.updatedAt = now(); await atomicJson(path, proposal); }
  return proposal;
}
export async function applyProposal(root: string, id: string, operator: string): Promise<ProposalRecord> {
  const appliedBy = safeOperator(operator);
  const path = proposalPath(root, id); const proposal = await readJson<ProposalRecord>(path);
  if (proposal.state === "pending") throw new Error("Proposal application requires explicit operator approval");
  if (proposal.state === "approved") { proposal.state = "applied"; proposal.audit.push({ timestamp: now(), action: "applied", operator: appliedBy }); proposal.updatedAt = now(); await atomicJson(path, proposal); }
  // Application is an auditable acknowledgement only; automatic behavior/config/code mutation is prohibited.
  return proposal;
}

export const SCHEMA_VERSION = 1;

export type TaskMode = "read" | "write";
export type TaskState = "pending" | "running" | "stalled" | "review" | "done" | "blocked" | "failed" | "cancelled" | "integrated";
export type ProgressOperationKind = "delegation" | "review" | "verification" | "follow-up" | "integration";
export type ProgressTerminalState = "success" | "failure" | "timeout" | "cancelled" | "unreachable";

export interface ProgressCounts {
  completed: number;
  active: number;
  total?: number;
}

export interface ProgressEvent {
  schemaVersion: number;
  sequence: number;
  timestamp: string;
  featureId: string;
  taskId: string;
  attempt: number;
  operationId: string;
  operation: ProgressOperationKind;
  kind: "start" | "phase" | "milestone" | "heartbeat" | "stall" | "recovery" | "retry" | "terminal";
  elapsedMs: number;
  phase: string;
  counts: ProgressCounts;
  lastMilestone: string;
  summary: string;
  activity: "active" | "inactive" | "cancelled";
  terminal?: ProgressTerminalState;
  deliveryDegraded?: boolean;
}

export interface FeatureRecord {
  schemaVersion: number;
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  state: "active" | "done" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  schemaVersion: number;
  id: string;
  featureId: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  profile: string;
  dependsOn: string[];
  createdAt: string;
}

export interface TaskStatus {
  schemaVersion: number;
  featureId: string;
  taskId: string;
  state: TaskState;
  currentAttempt: number;
  commit?: string;
  branch?: string;
  worktree?: string;
  message?: string;
  updatedAt: string;
}

export interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface InvocationRecord {
  schemaVersion: number;
  featureId: string;
  taskId: string;
  attempt: number;
  profile: string;
  mode: TaskMode;
  cwd: string;
  command: string;
  args: string[];
  model?: string;
  thinking?: string;
  route?: unknown;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  usage?: UsageRecord;
  exitCode?: number;
}

export interface SessionReference {
  schemaVersion: number;
  id?: string;
  file?: string;
  eventsFile: string;
  cwd: string;
  updatedAt: string;
}

export interface Handoff {
  schemaVersion: number;
  featureId: string;
  taskId: string;
  attempt: number;
  status: "done" | "blocked" | "failed";
  summary: string;
  changedFiles: Array<{ path: string; summary: string }>;
  checks: Array<{ command: string; status: "passed" | "failed" | "not-run"; exitCode?: number; evidence?: string }>;
  decisions: Array<{ decision: string; rationale: string }>;
  risks: string[];
  blockers: string[];
  nextSteps: string[];
  session: { id?: string; file?: string; eventsFile: string };
  createdAt: string;
}

export interface RunResult {
  exitCode: number;
  stderr: string;
  finalText: string;
  sessionId?: string;
  usage: UsageRecord;
}

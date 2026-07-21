import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { appendJsonl, exists, rootDir } from "./storage.ts";
import { SCHEMA_VERSION, type ProgressCounts, type ProgressEvent, type ProgressOperationKind, type ProgressTerminalState } from "./types.ts";

export interface ProgressClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: ProgressClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Default liveness threshold: long work is never killed merely for elapsed duration. */
export const DEFAULT_STALL_MS = 10 * 60_000;

export interface ProgressLiveness {
  lastProgressAt: number;
  stalled: boolean;
  stalledAt?: number;
}

/**
 * Deterministically derives liveness from persisted progress timestamps. Reprocessing the
 * same timeline (including after a restart) produces the same result and never emits data.
 */
export function deriveProgressLiveness(
  progressAt: readonly number[],
  nowMs: number,
  inactivityMs = DEFAULT_STALL_MS,
): ProgressLiveness {
  const lastProgressAt = progressAt.reduce((latest, timestamp) => Math.max(latest, timestamp), 0);
  const stalled = nowMs - lastProgressAt >= inactivityMs;
  return { lastProgressAt, stalled, stalledAt: stalled ? lastProgressAt + inactivityMs : undefined };
}

export interface ProgressMonitorOptions {
  root: string;
  featureId: string;
  taskId: string;
  attempt: number;
  operationId: string;
  operation: ProgressOperationKind;
  phase?: string;
  counts?: Partial<ProgressCounts>;
  heartbeatMs?: number;
  inactivityMs?: number;
  hardTimeoutMs?: number;
  clock?: ProgressClock;
  livenessCheck?: () => boolean | Promise<boolean>;
  onUnreachable?: () => void | Promise<void>;
  onStall?: () => void | Promise<void>;
  onRecovery?: () => void | Promise<void>;
  onDelivery?: (event: ProgressEvent) => void | Promise<void>;
}

interface ActiveOperation {
  monitor: ProgressMonitor;
  cancel?: () => void | Promise<void>;
}

const activeOperations = new Map<string, ActiveOperation>();

export function progressFile(root: string, operationId: string): string {
  return join(rootDir(root), "progress", `${operationId.replace(/[^a-zA-Z0-9._-]+/g, "-")}.jsonl`);
}

export function formatProgress(event: ProgressEvent): string {
  const elapsed = event.elapsedMs < 60_000
    ? `${Math.floor(event.elapsedMs / 1000)}s`
    : `${Math.floor(event.elapsedMs / 60_000)}m${Math.floor((event.elapsedMs % 60_000) / 1000)}s`;
  const count = event.counts.total === undefined
    ? `${event.counts.completed} done, ${event.counts.active} active`
    : `${event.counts.completed}/${event.counts.total} done, ${event.counts.active} active`;
  const degradation = event.deliveryDegraded ? " Live progress delivery recovered after an earlier failure." : "";
  const update = event.summary === event.lastMilestone ? event.summary : `${event.summary}; last: ${event.lastMilestone}`;
  const activity = event.activity === "inactive"
    ? "inactive"
    : event.activity === "cancelled"
      ? "cancelled"
      : event.lastMilestone === "No milestone completed yet" ? "active, no milestone yet" : "active";
  return `[${elapsed}] ${event.phase} (${activity}) — ${count}; ${update}.${degradation}`;
}

export class ProgressMonitor {
  readonly file: string;
  readonly options: ProgressMonitorOptions;
  private readonly clock: ProgressClock;
  private readonly startedAt: number;
  private phase: string;
  private counts: ProgressCounts;
  private lastMilestone = "No milestone completed yet";
  private lastActivityAt: number;
  private lastWarningAt?: number;
  private sequence = 0;
  private terminalState?: ProgressTerminalState;
  private terminating = false;
  private heartbeatHandle?: unknown;
  private inactivityHandle?: unknown;
  private timeoutHandle?: unknown;
  private deliveryFailed = false;
  private livenessPending = false;
  private livenessCheck?: () => boolean | Promise<boolean>;
  private queue: Promise<void> = Promise.resolve();

  private constructor(options: ProgressMonitorOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.startedAt = this.clock.now();
    this.lastActivityAt = this.startedAt;
    this.phase = options.phase ?? "starting";
    this.livenessCheck = options.livenessCheck;
    this.counts = { completed: options.counts?.completed ?? 0, active: options.counts?.active ?? 1, total: options.counts?.total };
    this.file = progressFile(options.root, options.operationId);
  }

  static async start(options: ProgressMonitorOptions): Promise<ProgressMonitor> {
    if (options.hardTimeoutMs !== undefined && options.hardTimeoutMs <= 0) throw new Error("hardTimeoutMs must be greater than zero");
    if (activeOperations.has(options.operationId)) throw new Error(`Operation already active: ${options.operationId}`);
    const monitor = new ProgressMonitor(options);
    activeOperations.set(options.operationId, { monitor });
    await monitor.emit("start", "Operation started");
    monitor.startTimers();
    return monitor;
  }

  get isTerminal(): boolean { return this.terminalState !== undefined; }
  get isStalled(): boolean { return !this.isTerminal && this.activityState() === "inactive"; }

  setCancelHandler(cancel: () => void | Promise<void>): void {
    const active = activeOperations.get(this.options.operationId);
    if (active) active.cancel = cancel;
  }

  setLivenessCheck(check: () => boolean | Promise<boolean>): void {
    this.livenessCheck = check;
  }

  async phaseChange(phase: string, milestone?: string, counts?: Partial<ProgressCounts>): Promise<void> {
    if (this.isTerminal) return;
    this.phase = phase;
    if (counts) this.updateCounts(counts);
    if (milestone) this.lastMilestone = sanitizeSummary(milestone);
    await this.emit("phase", milestone ?? `Entered ${phase} phase`);
  }

  async milestone(summary: string, counts?: Partial<ProgressCounts>): Promise<void> {
    if (this.isTerminal) return;
    if (counts) this.updateCounts(counts);
    this.lastMilestone = sanitizeSummary(summary);
    await this.emit("milestone", this.lastMilestone);
  }

  updateCounts(counts: Partial<ProgressCounts>): void {
    this.counts = { ...this.counts, ...counts };
  }

  observe(event: any): void {
    if (this.isTerminal || !event || typeof event !== "object") return;
    const wasInactive = this.lastWarningAt !== undefined;
    this.lastActivityAt = this.clock.now();
    this.lastWarningAt = undefined;
    this.scheduleInactivityCheck();
    if (wasInactive) { void this.options.onRecovery?.(); void this.enqueueEmit("recovery", "Structured event activity resumed", "active"); }

    const type = String(event.type ?? "");
    if (type === "agent_start") void this.changeFromEvent("generating", "Child agent started");
    else if (type === "turn_start") void this.changeFromEvent("generating", "Agent turn started");
    else if (type === "tool_execution_start") this.observeToolStart(event);
    else if (type === "tool_execution_end") this.observeToolEnd(event);
    else if (type === "message_end" && event.message?.role === "assistant") {
      this.counts.completed++;
      void this.eventMilestone("Agent response turn completed");
    } else if (type === "auto_retry_start") {
      void this.eventMilestone(`Retry ${Number(event.attempt) || 1} started`, "retry");
    } else if (type === "auto_retry_end") {
      void this.eventMilestone(event.success ? "Retry completed" : "Retry failed", "retry");
    } else if (type === "compaction_start") void this.changeFromEvent("compacting", "Context compaction started");
    else if (type === "compaction_end") void this.eventMilestone(event.aborted ? "Context compaction aborted" : "Context compaction completed");
  }

  async terminal(state: ProgressTerminalState, summary: string): Promise<void> {
    if (this.isTerminal || this.terminating) return;
    this.terminating = true;
    await this.finalizeTerminal(state, summary);
  }

  async cancel(summary = "Cancelled by user"): Promise<void> {
    await this.forceTerminate("cancelled", summary);
  }

  async flush(): Promise<void> { await this.queue; }

  snapshot(): ProgressEvent {
    const timestampMs = this.clock.now();
    return {
      schemaVersion: SCHEMA_VERSION,
      sequence: this.sequence,
      timestamp: new Date(timestampMs).toISOString(),
      featureId: this.options.featureId,
      taskId: this.options.taskId,
      attempt: this.options.attempt,
      operationId: this.options.operationId,
      operation: this.options.operation,
      kind: this.isTerminal ? "terminal" : "heartbeat",
      elapsedMs: Math.max(0, timestampMs - this.startedAt),
      phase: this.phase,
      counts: { ...this.counts },
      lastMilestone: this.lastMilestone,
      summary: this.isTerminal ? this.lastMilestone : "Operation is active",
      activity: this.activityState(),
      terminal: this.terminalState,
    };
  }

  private startTimers(): void {
    const heartbeatMs = this.options.heartbeatMs ?? 20_000;
    const inactivityMs = this.options.inactivityMs ?? DEFAULT_STALL_MS;
    this.heartbeatHandle = this.clock.setInterval(() => {
      if (!this.isTerminal) void this.enqueueEmit("heartbeat", "Heartbeat", this.activityState());
    }, heartbeatMs);
    this.scheduleInactivityCheck(inactivityMs);
    if (this.options.hardTimeoutMs !== undefined) {
      this.timeoutHandle = this.clock.setTimeout(() => {
        void this.forceTerminate("timeout", `Configured hard timeout expired after ${this.options.hardTimeoutMs}ms`);
      }, this.options.hardTimeoutMs);
    }
  }

  private cleanup(): void {
    if (this.heartbeatHandle !== undefined) this.clock.clearInterval(this.heartbeatHandle);
    if (this.inactivityHandle !== undefined) this.clock.clearInterval(this.inactivityHandle);
    if (this.timeoutHandle !== undefined) this.clock.clearTimeout(this.timeoutHandle);
    this.heartbeatHandle = this.inactivityHandle = this.timeoutHandle = undefined;
  }

  private scheduleInactivityCheck(inactivityMs = this.options.inactivityMs ?? DEFAULT_STALL_MS): void {
    if (this.inactivityHandle !== undefined) this.clock.clearTimeout(this.inactivityHandle);
    this.inactivityHandle = this.clock.setTimeout(() => { void this.checkInactivity(); }, inactivityMs);
  }

  private activityState(): ProgressEvent["activity"] {
    return this.clock.now() - this.lastActivityAt >= (this.options.inactivityMs ?? DEFAULT_STALL_MS) ? "inactive" : "active";
  }

  private async checkInactivity(): Promise<void> {
    if (this.isTerminal || this.livenessPending) return;
    const inactivityMs = this.options.inactivityMs ?? DEFAULT_STALL_MS;
    const now = this.clock.now();
    if (now - this.lastActivityAt < inactivityMs || (this.lastWarningAt !== undefined && now - this.lastWarningAt < inactivityMs)) return;
    this.livenessPending = true;
    try {
      const alive = await (this.livenessCheck?.() ?? true);
      this.lastWarningAt = now;
      await this.emit("stall", alive
        ? `No structured output for ${Math.floor((now - this.lastActivityAt) / 1000)}s; child is reachable`
        : "Child process is unreachable", "inactive");
      if (alive) await this.options.onStall?.();
      if (!alive) await this.forceTerminate("unreachable", "Child process became unreachable");
    } finally {
      this.livenessPending = false;
      if (!this.isTerminal) this.scheduleInactivityCheck(inactivityMs);
    }
  }

  private async forceTerminate(state: "cancelled" | "timeout" | "unreachable", summary: string): Promise<void> {
    if (this.isTerminal || this.terminating) return;
    this.terminating = true;
    const active = activeOperations.get(this.options.operationId);
    const persisted = this.finalizeTerminal(state, summary);
    try { await active?.cancel?.(); } catch { /* diagnostics remain in the timeline */ }
    await persisted;
    try { await this.options.onUnreachable?.(); } catch { /* best effort */ }
  }

  private async finalizeTerminal(state: ProgressTerminalState, summary: string): Promise<void> {
    this.terminalState = state;
    this.counts.active = 0;
    if (state === "success") this.counts.completed = Math.max(1, this.counts.completed);
    this.lastMilestone = sanitizeSummary(summary);
    this.cleanup();
    activeOperations.delete(this.options.operationId);
    await this.emit("terminal", this.lastMilestone, state === "cancelled" ? "cancelled" : state === "success" ? "active" : "inactive", state);
    await this.flush();
  }

  private observeToolStart(event: any): void {
    const tool = String(event.toolName ?? "tool");
    if (tool === "write" || tool === "edit") void this.changeFromEvent("editing", "Editing files");
    else if (tool === "bash" && isTestCommand(event.args?.command)) void this.changeFromEvent("testing", "Running tests");
    else if (tool === "bash") void this.changeFromEvent("command", "Running command");
    else void this.changeFromEvent("inspecting", `Using ${safeToolName(tool)}`);
  }

  private observeToolEnd(event: any): void {
    const tool = String(event.toolName ?? "tool");
    const failed = Boolean(event.isError);
    if (tool === "write" || tool === "edit") {
      const path = sanitizePath(event.args?.path ?? event.args?.file_path);
      this.counts.completed++;
      void this.eventMilestone(failed ? `File update failed${path ? `: ${path}` : ""}` : `Updated file${path ? `: ${path}` : ""}`);
    } else if (tool === "bash") {
      this.counts.completed++;
      void this.eventMilestone(isTestCommand(event.args?.command)
        ? `Tests ${failed ? "failed" : "completed"}`
        : `Command ${failed ? "failed" : "completed"}`);
    }
  }

  private async changeFromEvent(phase: string, summary: string): Promise<void> {
    if (this.isTerminal || this.phase === phase) return;
    this.phase = phase;
    await this.enqueueEmit("phase", summary, "active");
  }

  private async eventMilestone(summary: string, kind: ProgressEvent["kind"] = "milestone"): Promise<void> {
    if (this.isTerminal) return;
    this.lastMilestone = sanitizeSummary(summary);
    await this.enqueueEmit(kind, this.lastMilestone, "active");
  }

  private enqueueEmit(kind: ProgressEvent["kind"], summary: string, activity: ProgressEvent["activity"]): Promise<void> {
    return this.emit(kind, summary, activity);
  }

  private emit(
    kind: ProgressEvent["kind"],
    summary: string,
    activity: ProgressEvent["activity"] = "active",
    terminal?: ProgressTerminalState,
  ): Promise<void> {
    const timestampMs = this.clock.now();
    const event: ProgressEvent = {
      schemaVersion: SCHEMA_VERSION,
      sequence: ++this.sequence,
      timestamp: new Date(timestampMs).toISOString(),
      featureId: this.options.featureId,
      taskId: this.options.taskId,
      attempt: this.options.attempt,
      operationId: this.options.operationId,
      operation: this.options.operation,
      kind,
      elapsedMs: Math.max(0, timestampMs - this.startedAt),
      phase: this.phase,
      counts: { ...this.counts },
      lastMilestone: this.lastMilestone,
      summary: sanitizeSummary(summary),
      activity,
      terminal,
    };
    const operation = async () => {
      event.deliveryDegraded = this.deliveryFailed || undefined;
      await appendJsonl(this.file, event);
      if (this.options.onDelivery) {
        try {
          const delivery = this.options.onDelivery(event);
          void Promise.resolve(delivery).then(
            () => { this.deliveryFailed = false; },
            () => { this.deliveryFailed = true; },
          );
        } catch {
          this.deliveryFailed = true;
        }
      }
    };
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }
}

export function getActiveOperation(operationId: string): ProgressEvent | undefined {
  const active = activeOperations.get(operationId);
  return active?.monitor.snapshot();
}

export function listActiveOperations(): ProgressEvent[] {
  return [...activeOperations.values()].map(({ monitor }) => monitor.snapshot());
}

export async function cancelActiveOperation(operationId: string): Promise<boolean> {
  const active = activeOperations.get(operationId);
  if (!active) return false;
  await active.monitor.cancel();
  return true;
}

export async function readProgressTimeline(root: string, operationId: string): Promise<ProgressEvent[]> {
  const path = progressFile(root, operationId);
  if (!(await exists(path))) return [];
  return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProgressEvent);
}

export async function findProgressTimelines(root: string, filters: { featureId?: string; taskId?: string } = {}): Promise<ProgressEvent[][]> {
  const { readdir } = await import("node:fs/promises");
  const dir = join(rootDir(root), "progress");
  if (!(await exists(dir))) return [];
  const timelines: ProgressEvent[][] = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const events = (await readFile(join(dir, file), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProgressEvent);
    if (!events.length) continue;
    if (filters.featureId && events[0].featureId !== filters.featureId) continue;
    if (filters.taskId && events[0].taskId !== filters.taskId) continue;
    timelines.push(events);
  }
  return timelines.sort((a, b) => a[0].timestamp.localeCompare(b[0].timestamp));
}

function sanitizeSummary(value: unknown): string {
  const text = String(value ?? "Progress updated")
    .replace(/\b(bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|credential|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "Progress updated").slice(0, 240);
}

function sanitizePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const name = basename(value);
  if (/(^|\.)(env|pem|key|credentials?|secrets?)(\.|$)/i.test(name)) return "[sensitive file]";
  return name.slice(0, 120);
}

function safeToolName(value: string): string {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(value) ? value : "tool";
}

function isTestCommand(value: unknown): boolean {
  return typeof value === "string" && /(^|\s)(npm\s+(test|run\s+test)|pnpm\s+test|yarn\s+test|pytest|vitest|jest|cargo\s+test|go\s+test)(\s|$)/i.test(value);
}

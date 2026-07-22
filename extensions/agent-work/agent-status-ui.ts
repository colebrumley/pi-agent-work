import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { subscribeProgress } from "./progress.ts";
import type { ProgressEvent, ProgressTerminalState } from "./types.ts";

export const AGENT_STATUS_WIDGET_ID = "agent-work-active-agents";
export const AGENT_STATUS_ENTRY_TYPE = "agent-work-run-summary";

type DisplayState = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "stale" | "unreachable";

export interface AgentStatusRow {
  operationId: string;
  label: string;
  state: DisplayState;
  lastKnownState?: Exclude<DisplayState, "stale" | "unreachable">;
  lastCheckinAt: number;
  sequence: number;
  terminal: boolean;
}

export interface AgentStatusSnapshot {
  active: number;
  outcomes: Partial<Record<"completed" | "failed" | "cancelled" | "blocked" | "unreachable", number>>;
  rows: AgentStatusRow[];
}

export interface AgentStatusUpdate {
  current?: AgentStatusSnapshot;
  completed?: AgentStatusSnapshot;
}

function cleanLabel(value: unknown): string {
  const text = String(value ?? "Agent task")
    .replace(/\b(bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|credential|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "Agent task").slice(0, 120);
}

function runningState(event: ProgressEvent): "queued" | "running" {
  return ["starting", "preparing", "requirements", "isolating", "launching"].includes(event.phase) ? "queued" : "running";
}

function terminalState(value: ProgressTerminalState): Extract<DisplayState, "blocked" | "completed" | "failed" | "cancelled" | "unreachable"> {
  if (value === "success") return "completed";
  if (value === "cancelled") return "cancelled";
  if (value === "unreachable") return "unreachable";
  if (value === "blocked") return "blocked";
  return "failed";
}

function validEvent(value: unknown): value is ProgressEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ProgressEvent>;
  return typeof event.operationId === "string" && event.operationId.length > 0
    && typeof event.sequence === "number" && Number.isSafeInteger(event.sequence) && event.sequence >= 0
    && typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp))
    && typeof event.phase === "string";
}

export class AgentStatusAggregator {
  private rows = new Map<string, AgentStatusRow>();
  private runStarted = false;

  ingest(value: unknown): AgentStatusUpdate {
    if (!validEvent(value)) return { current: this.runStarted ? this.snapshot() : undefined };
    const event = value;
    const existing = this.rows.get(event.operationId);
    if (existing && event.sequence <= existing.sequence) return { current: this.snapshot() };

    const timestamp = Date.parse(event.timestamp);
    const isTerminal = event.kind === "terminal" && event.terminal !== undefined;
    const lastHealthy = existing?.state === "queued" || existing?.state === "running"
      ? existing.state
      : existing?.lastKnownState ?? runningState(event);
    const state: DisplayState = isTerminal
      ? terminalState(event.terminal!)
      : event.activity === "inactive" || event.kind === "stall" ? "stale" : runningState(event);

    this.rows.set(event.operationId, {
      operationId: event.operationId,
      label: cleanLabel(event.taskLabel ?? event.taskId),
      state,
      lastKnownState: state === "stale" || state === "unreachable" ? lastHealthy : undefined,
      lastCheckinAt: timestamp,
      sequence: event.sequence,
      terminal: isTerminal,
    });
    if (!isTerminal) this.runStarted = true;

    const current = this.snapshot();
    if (this.runStarted && current.active === 0) {
      this.rows.clear();
      this.runStarted = false;
      return { completed: current };
    }
    return { current };
  }

  reset(): void {
    this.rows.clear();
    this.runStarted = false;
  }

  private snapshot(): AgentStatusSnapshot {
    const rows = [...this.rows.values()];
    const outcomes: AgentStatusSnapshot["outcomes"] = {};
    for (const row of rows) {
      if (!row.terminal) continue;
      const outcome = row.state === "completed" || row.state === "failed" || row.state === "cancelled" || row.state === "blocked" || row.state === "unreachable"
        ? row.state : "failed";
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    return { active: rows.filter((row) => !row.terminal).length, outcomes, rows };
  }
}

function age(timestamp: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function renderAgentStatus(snapshot: AgentStatusSnapshot, nowMs = Date.now()): string[] {
  const totals = Object.entries(snapshot.outcomes)
    .filter(([, count]) => count)
    .map(([state, count]) => `${count} ${state}`);
  const lines = [`Agents: ${snapshot.active} active${totals.length ? ` · ${totals.join(" · ")}` : ""}`];
  for (const row of snapshot.rows) {
    const warning = row.state === "stale" || row.state === "unreachable";
    const state = warning && row.lastKnownState ? `${row.lastKnownState} · ${row.state}` : row.state;
    lines.push(`• ${row.label} — ${state} · checked in ${age(row.lastCheckinAt, nowMs)}`);
  }
  return lines;
}

export function registerAgentStatusUi(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(AGENT_STATUS_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { lines?: unknown };
    const lines = Array.isArray(data?.lines) ? data.lines.filter((line): line is string => typeof line === "string").slice(0, 100) : [];
    return new Text(lines.map((line, index) => theme.fg(index === 0 ? "accent" : "muted", cleanLabel(line))).join("\n"), 0, 0);
  });

  let unsubscribe: (() => void) | undefined;
  let aggregator = new AgentStatusAggregator();

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    aggregator = new AgentStatusAggregator();
    if (ctx.mode !== "tui") return;
    unsubscribe = subscribeProgress((event) => updateUi(pi, ctx, aggregator, event));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    aggregator.reset();
    if (ctx.mode === "tui") ctx.ui.setWidget(AGENT_STATUS_WIDGET_ID, undefined);
  });
}

function updateUi(pi: ExtensionAPI, ctx: ExtensionContext, aggregator: AgentStatusAggregator, event: ProgressEvent): void {
  const update = aggregator.ingest(event);
  if (update.completed) {
    ctx.ui.setWidget(AGENT_STATUS_WIDGET_ID, undefined);
    pi.appendEntry(AGENT_STATUS_ENTRY_TYPE, { lines: renderAgentStatus(update.completed, Date.parse(event.timestamp)) });
    return;
  }
  if (update.current) ctx.ui.setWidget(AGENT_STATUS_WIDGET_ID, renderAgentStatus(update.current));
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_STATUS_ENTRY_TYPE,
  AGENT_STATUS_WIDGET_ID,
  AgentStatusAggregator,
  registerAgentStatusUi,
  renderAgentStatus,
} from "./agent-status-ui.ts";
import { ProgressMonitor } from "./progress.ts";
import type { ProgressEvent } from "./types.ts";

function event(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    schemaVersion: 1,
    sequence: 1,
    timestamp: "2026-07-22T12:00:00.000Z",
    featureId: "feature-a",
    taskId: "task-a",
    taskLabel: "Review tests",
    attempt: 1,
    operationId: "operation-a",
    operation: "delegation",
    kind: "phase",
    elapsedMs: 1000,
    phase: "generating",
    counts: { completed: 0, active: 1 },
    lastMilestone: "Started",
    summary: "Running",
    activity: "active",
    ...overrides,
  };
}

test("aggregates concurrent operations, ignores older updates, and completes once", () => {
  const aggregator = new AgentStatusAggregator();
  aggregator.ingest(event());
  const two = aggregator.ingest(event({ operationId: "operation-b", taskId: "task-b", taskLabel: "Implement UI" }));
  assert.equal(two.current?.active, 2);

  const newer = aggregator.ingest(event({ sequence: 3, phase: "testing", timestamp: "2026-07-22T12:00:10.000Z" }));
  const older = aggregator.ingest(event({ sequence: 2, phase: "preparing", timestamp: "2026-07-22T12:00:05.000Z" }));
  assert.equal(newer.current?.rows[0]?.state, "running");
  assert.equal(older.current?.rows[0]?.state, "running");
  assert.equal(older.current?.rows[0]?.sequence, 3);

  const one = aggregator.ingest(event({ sequence: 4, kind: "terminal", terminal: "success", counts: { completed: 1, active: 0 }, timestamp: "2026-07-22T12:00:20.000Z" }));
  assert.equal(one.current?.active, 1);
  assert.equal(one.current?.outcomes.completed, 1);
  const done = aggregator.ingest(event({ operationId: "operation-b", taskId: "task-b", taskLabel: "Implement UI", sequence: 2, kind: "terminal", terminal: "failure", activity: "inactive", counts: { completed: 0, active: 0 }, timestamp: "2026-07-22T12:00:30.000Z" }));
  assert.equal(done.current, undefined);
  assert.equal(done.completed?.active, 0);
  assert.equal(done.completed?.outcomes.completed, 1);
  assert.equal(done.completed?.outcomes.failed, 1);
});

test("shows stale and unreachable as warnings on last-known state", () => {
  const aggregator = new AgentStatusAggregator();
  aggregator.ingest(event());
  const stale = aggregator.ingest(event({ sequence: 2, kind: "stall", activity: "inactive", timestamp: "2026-07-22T12:10:00.000Z" }));
  assert.equal(stale.current?.rows[0]?.state, "stale");
  assert.equal(stale.current?.rows[0]?.lastKnownState, "running");
  const unreachable = aggregator.ingest(event({ sequence: 3, kind: "terminal", terminal: "unreachable", activity: "inactive", counts: { completed: 0, active: 0 }, timestamp: "2026-07-22T12:11:00.000Z" }));
  const lines = renderAgentStatus(unreachable.completed!, Date.parse("2026-07-22T12:12:00.000Z"));
  assert.match(lines.join("\n"), /running · unreachable/);
  assert.match(lines.join("\n"), /checked in 1m ago/);
});

test("malformed events and sensitive labels fail safely", () => {
  const aggregator = new AgentStatusAggregator();
  assert.doesNotThrow(() => aggregator.ingest({ operationId: "bad", sequence: "newest" }));
  const update = aggregator.ingest(event({ taskLabel: "Deploy token=super-secret\nnext line" }));
  const output = renderAgentStatus(update.current!).join("\n");
  assert.doesNotMatch(output, /super-secret|\nnext line/);
  assert.match(output, /token=\[redacted\]/);
});

test("progress integration updates one widget and appends one terminal entry", async () => {
  const handlers = new Map<string, Function[]>();
  const widgets = new Map<string, unknown>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    registerEntryRenderer() {},
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as any;
  registerAgentStatusUi(pi);
  const ctx = {
    mode: "tui",
    ui: { setWidget(id: string, value: unknown) { if (value === undefined) widgets.delete(id); else widgets.set(id, value); } },
  } as any;
  await handlers.get("session_start")?.[0]?.({}, ctx);

  const root = await mkdtemp(join(tmpdir(), "agent-status-ui-"));
  try {
    const first = await ProgressMonitor.start({ root, featureId: "feature-a", taskId: "one", taskLabel: "First task", attempt: 1, operationId: "one", operation: "delegation" });
    const second = await ProgressMonitor.start({ root, featureId: "feature-a", taskId: "two", taskLabel: "Second task", attempt: 1, operationId: "two", operation: "delegation" });
    assert.match((widgets.get(AGENT_STATUS_WIDGET_ID) as string[]).join("\n"), /Agents: 2 active/);
    await first.terminal("success", "done");
    assert.equal(entries.length, 0);
    await second.terminal("blocked", "needs clarification");
    assert.equal(widgets.has(AGENT_STATUS_WIDGET_ID), false);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.type, AGENT_STATUS_ENTRY_TYPE);
    assert.match(JSON.stringify(entries[0]?.data), /0 active/);
    assert.match(JSON.stringify(entries[0]?.data), /1 completed/);
    assert.match(JSON.stringify(entries[0]?.data), /1 blocked/);
  } finally {
    await handlers.get("session_shutdown")?.[0]?.({}, ctx);
    await rm(root, { recursive: true, force: true });
  }
});

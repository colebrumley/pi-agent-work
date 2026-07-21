import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelActiveOperation,
  findProgressTimelines,
  formatProgress,
  getActiveOperation,
  ProgressMonitor,
  readProgressTimeline,
  DEFAULT_STALL_MS,
  deriveProgressLiveness,
  type ProgressClock,
} from "./progress.ts";
import { runPi } from "./runner.ts";
import type { ProgressEvent } from "./types.ts";

class FakeClock implements ProgressClock {
  time = 0;
  nextId = 1;
  timers = new Map<number, { at: number; ms: number; interval: boolean; callback: () => void }>();
  now(): number { return this.time; }
  setInterval(callback: () => void, ms: number): number { return this.add(callback, ms, true); }
  clearInterval(handle: unknown): void { this.timers.delete(handle as number); }
  setTimeout(callback: () => void, ms: number): number { return this.add(callback, ms, false); }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  private add(callback: () => void, ms: number, interval: boolean): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, ms, interval, callback });
    return id;
  }
  async tick(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.time = timer.at;
      if (timer.interval) timer.at += timer.ms;
      else this.timers.delete(id);
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
    await Promise.resolve();
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-progress-test-"));
}

function base(root: string, clock: FakeClock, operationId: string, extra: Record<string, unknown> = {}) {
  return {
    root, clock, operationId,
    featureId: "feature-a", taskId: "task-a", attempt: 1,
    operation: "delegation" as const,
    ...extra,
  };
}

async function deterministicMonitorTests(): Promise<void> {
  const root = await tempRoot();
  try {
    const clock = new FakeClock();
    const delivered: ProgressEvent[] = [];
    let livenessChecks = 0;
    const monitor = await ProgressMonitor.start(base(root, clock, "timeline", {
      livenessCheck: () => { livenessChecks++; return true; },
      onDelivery: (event: ProgressEvent) => { delivered.push(event); },
    }));
    assert.equal(delivered[0].kind, "start", "start is delivered immediately");
    assert.deepEqual(delivered[0].counts, { completed: 0, active: 1, total: undefined });
    assert.match(formatProgress(delivered[0]), /active, no milestone yet/);

    await clock.tick(19_999);
    assert.equal(delivered.filter((event) => event.kind === "heartbeat").length, 0);
    await clock.tick(1);
    await monitor.flush();
    assert.equal(delivered.at(-1)?.kind, "heartbeat");
    await monitor.phaseChange("editing", "Prepared implementation");
    assert.equal(delivered.at(-1)?.kind, "phase", "phase changes are immediate");

    // Token/event activity prevents a false stall without persisting token-level spam.
    await clock.tick(39_000);
    monitor.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
    await clock.tick(21_000);
    await monitor.flush();
    assert.equal(livenessChecks, 0);
    assert.equal(delivered.some((event) => event.kind === "stall"), false);
    assert.equal(JSON.stringify(delivered).includes("private reasoning"), false);

    await clock.tick(DEFAULT_STALL_MS - 21_001);
    await monitor.flush();
    assert.equal(livenessChecks, 0, "default liveness remains active until ten silent minutes");
    await clock.tick(1);
    await monitor.flush();
    assert.equal(livenessChecks, 1);
    assert.equal(delivered.some((event) => event.kind === "stall"), true);
    assert.match(formatProgress(delivered.find((event) => event.kind === "stall")!), /inactive.*No structured output/);
    await clock.tick(DEFAULT_STALL_MS);
    await monitor.flush();
    assert.equal(livenessChecks, 2, "stall warning repeats every inactivity interval");
    monitor.observe({ type: "tool_execution_start", toolName: "read", args: { path: "/tmp/secret.env" } });
    await monitor.flush();
    assert.equal(delivered.some((event) => event.kind === "recovery"), true);

    await monitor.milestone("authorization=super-secret-value");
    monitor.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "OPENAI_API_KEY=secret npm test -- --token abc" } });
    monitor.observe({ type: "tool_execution_end", toolName: "bash", args: { command: "OPENAI_API_KEY=secret npm test -- --token abc" }, isError: false });
    monitor.observe({ type: "tool_execution_start", toolName: "edit", args: { path: "/tmp/credentials.pem", newText: "secret" } });
    monitor.observe({ type: "tool_execution_end", toolName: "edit", args: { path: "/tmp/credentials.pem", newText: "secret" }, isError: false });
    await monitor.flush();
    const exposed = JSON.stringify(delivered);
    assert.equal(exposed.includes("super-secret-value"), false);
    assert.equal(exposed.includes("OPENAI_API_KEY"), false);
    assert.equal(exposed.includes("--token"), false);
    assert.equal(exposed.includes("credentials.pem"), false);
    assert.equal(exposed.includes("[sensitive file]"), true);

    await monitor.terminal("success", "Implementation completed");
    const countAfterTerminal = delivered.length;
    await clock.tick(120_000);
    await monitor.flush();
    assert.equal(delivered.length, countAfterTerminal, "terminal cleanup stops all timers");
    assert.equal(clock.timers.size, 0);
    assert.equal(getActiveOperation("timeline"), undefined);
    const replay = await readProgressTimeline(root, "timeline");
    const gaps = replay.slice(1).map((event, index) => event.elapsedMs - replay[index].elapsedMs);
    assert(Math.max(...gaps) <= 20_000, "visible updates have no gap above the 20-second heartbeat interval");
    assert.equal(JSON.stringify(replay), JSON.stringify(delivered), "durable replay preserves the ordered UI/API timeline");
    assert.deepEqual(replay.map((event) => event.sequence), replay.map((_, index) => index + 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function degradationConcurrencyAndCancellationTests(): Promise<void> {
  const root = await tempRoot();
  try {
    const clock = new FakeClock();
    const recovered: ProgressEvent[] = [];
    let calls = 0;
    const degraded = await ProgressMonitor.start(base(root, clock, "degraded", {
      onDelivery: (event: ProgressEvent) => {
        calls++;
        if (calls === 1) throw new Error("UI channel down");
        recovered.push(event);
      },
    }));
    await degraded.milestone("Files inspected");
    assert.equal(recovered[0].deliveryDegraded, true, "delivery recovery is surfaced without stopping work");
    assert.equal((await readProgressTimeline(root, "degraded")).length, 2, "events persist while delivery fails");
    await degraded.terminal("success", "Done");

    const a = await ProgressMonitor.start(base(root, clock, "concurrent-a", { taskId: "task-a" }));
    const b = await ProgressMonitor.start(base(root, clock, "concurrent-b", { taskId: "task-b", attempt: 2, operation: "verification" }));
    a.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "raw A" }] } });
    b.observe({ type: "tool_execution_end", toolName: "write", args: { path: "b.ts", content: "secret" } });
    await Promise.all([a.flush(), b.flush()]);
    const timelines = await findProgressTimelines(root, { featureId: "feature-a" });
    assert.equal(timelines.length, 3);
    const aReplay = await readProgressTimeline(root, "concurrent-a");
    const bReplay = await readProgressTimeline(root, "concurrent-b");
    assert(aReplay.every((event) => event.taskId === "task-a" && event.operationId === "concurrent-a"));
    assert(bReplay.every((event) => event.taskId === "task-b" && event.attempt === 2 && event.operationId === "concurrent-b"));
    assert.equal(JSON.stringify([...aReplay, ...bReplay]).includes("raw A"), false);

    let kills = 0;
    a.setCancelHandler(() => { kills++; });
    await Promise.all([cancelActiveOperation("concurrent-a"), cancelActiveOperation("concurrent-a")]);
    assert.equal(kills, 1);
    const cancelled = await readProgressTimeline(root, "concurrent-a");
    assert.equal(cancelled.filter((event) => event.terminal === "cancelled").length, 1);
    await b.terminal("failure", "Verification failed");
    assert.equal(clock.timers.size, 0);

    const silent = await ProgressMonitor.start(base(root, clock, "no-default-timeout"));
    await clock.tick(DEFAULT_STALL_MS - 1);
    await silent.flush();
    assert.equal(silent.isStalled, false);
    await clock.tick(1);
    await silent.flush();
    assert.equal(silent.isStalled, true, "silence becomes visibly stalled at exactly ten minutes without aborting");
    silent.observe({ type: "heartbeat" });
    await silent.flush();
    assert.equal(silent.isStalled, false, "child heartbeat clears the stalled condition");
    assert.equal(silent.isTerminal, false, "silence alone never aborts and no timeout exists by default");
    await silent.cancel();

    let timeoutKills = 0;
    const timed = await ProgressMonitor.start(base(root, clock, "configured-timeout", { hardTimeoutMs: 1000 }));
    timed.setCancelHandler(() => { timeoutKills++; });
    await clock.tick(1000);
    await timed.flush();
    assert.equal(timed.snapshot().terminal, "timeout");
    assert.equal(timeoutKills, 1);
    assert.equal(clock.timers.size, 0);

    let unreachableKills = 0;
    const unreachable = await ProgressMonitor.start(base(root, clock, "unreachable", {
      inactivityMs: 1000,
      livenessCheck: () => false,
    }));
    unreachable.setCancelHandler(() => { unreachableKills++; });
    await clock.tick(1000);
    await unreachable.flush();
    await Promise.resolve();
    assert.equal(unreachable.snapshot().terminal, "unreachable");
    assert.equal(unreachableKills, 1);
    assert.equal(clock.timers.size, 0);

    for (const operation of ["review", "verification", "follow-up", "integration"] as const) {
      const lifecycle = await ProgressMonitor.start(base(root, clock, `coverage-${operation}`, { operation }));
      await lifecycle.phaseChange(`${operation}-active`, `${operation} active`);
      await lifecycle.terminal("success", `${operation} completed`);
      const events = await readProgressTimeline(root, `coverage-${operation}`);
      assert.deepEqual([events[0].kind, events[1].kind, events[2].kind], ["start", "phase", "terminal"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Timeline reconstruction is pure and idempotent across restart/reprocessing.
{
  const progress = [0, 120_000, 599_999];
  assert.deepEqual(deriveProgressLiveness(progress, 1_199_999), deriveProgressLiveness(progress, 1_199_999));
  assert.equal(deriveProgressLiveness(progress, 1_199_998).stalled, false);
  assert.equal(deriveProgressLiveness(progress, 1_199_999).stalled, true);
  assert.equal(deriveProgressLiveness([...progress, 1_200_000], 1_200_000).stalled, false, "new output resumes liveness");
}

async function realChildSmokeTest(): Promise<void> {
  const root = await tempRoot();
  try {
    const monitor = await ProgressMonitor.start({
      root, featureId: "smoke", taskId: "child", attempt: 1,
      operationId: "real-child", operation: "delegation", heartbeatMs: 25, inactivityMs: 500,
    });
    const eventsFile = join(root, "child-events.jsonl");
    const script = [
      "console.log(JSON.stringify({type:'agent_start'}));",
      "console.log(JSON.stringify({type:'tool_execution_start',toolName:'bash',args:{command:'npm test'}}));",
      "console.log(JSON.stringify({type:'tool_execution_end',toolName:'bash',args:{command:'npm test'},isError:false}));",
      "console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'raw hidden output'}],usage:{input:1,output:2,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));",
    ].join("");
    const result = await runPi({
      cwd: root, args: [], eventsFile, monitor,
      invocation: { command: process.execPath, args: ["-e", script] },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.finalText, "raw hidden output", "raw text remains available only as the final child result");
    await monitor.terminal("success", "Smoke child completed");
    const timeline = await readProgressTimeline(root, "real-child");
    assert.equal(timeline[0].kind, "start");
    assert.equal(timeline.at(-1)?.terminal, "success");
    assert.equal(JSON.stringify(timeline).includes("raw hidden output"), false);
    assert.equal((await readFile(eventsFile, "utf8")).includes("raw hidden output"), true, "raw child stream remains in its restricted diagnostic artifact");

    const cancelMonitor = await ProgressMonitor.start({
      root, featureId: "smoke", taskId: "cancel", attempt: 1,
      operationId: "real-child-cancel", operation: "delegation",
    });
    const controller = new AbortController();
    const descendantMarker = join(root, "descendant-survived");
    const descendantScript = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(descendantMarker)},'alive'),300);setInterval(()=>{},1000)`;
    const parentScript = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:'ignore'});console.log(JSON.stringify({type:'agent_start'}));setInterval(()=>{},1000)`;
    const longRun = runPi({
      cwd: root, args: [], eventsFile: join(root, "cancel-events.jsonl"), signal: controller.signal, monitor: cancelMonitor,
      invocation: { command: process.execPath, args: ["-e", parentScript] },
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(longRun, /aborted/);
    const cancelled = await readProgressTimeline(root, "real-child-cancel");
    assert.equal(cancelled.filter((event) => event.terminal === "cancelled").length, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(readFile(descendantMarker), "cancellation terminates the full descendant process group");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await deterministicMonitorTests();
await degradationConcurrencyAndCancellationTests();
await realChildSmokeTest();
console.log("progress tests passed");

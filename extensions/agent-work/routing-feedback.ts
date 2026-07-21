import { readFile } from "node:fs/promises";
import { appendJsonl, exists, rootDir } from "./storage.ts";
import type { EscalationDiagnosis, RouteRequest } from "./router.ts";

export type RouteFeedbackOutcome = "accepted" | "corrected" | "failed";
const diagnosisCategories = new Set(["task-complexity", "missing-context", "infrastructure", "prompt-quality"]);

// Serialize read-before-append settlement in this process so simultaneous terminal paths stay idempotent.
let settlementQueue: Promise<void> = Promise.resolve();

export interface TerminalRouteAttempt {
  featureId: string;
  taskId: string;
  attempt: number;
  model?: string;
}

export interface RouteFeedbackRecord extends TerminalRouteAttempt {
  outcome: RouteFeedbackOutcome;
  timestamp: string;
  diagnosis?: EscalationDiagnosis;
  note?: string;
}

export function routeFeedbackKey(attempt: TerminalRouteAttempt): string {
  return `${attempt.featureId}\u0000${attempt.taskId}\u0000${attempt.attempt}`;
}

export function routingFeedbackFile(root: string): string {
  return `${rootDir(root)}/routing-feedback.jsonl`;
}

export async function readRouteFeedback(root: string): Promise<RouteFeedbackRecord[]> {
  const file = routingFeedbackFile(root);
  if (!(await exists(file))) return [];
  return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RouteFeedbackRecord);
}

/** Persist exactly one settlement per terminal route attempt; retries/restarts return the original record. */
export async function settleTerminalRoute(
  root: string,
  record: Omit<RouteFeedbackRecord, "timestamp"> & { timestamp?: string },
): Promise<{ created: boolean; record: RouteFeedbackRecord }> {
  const previous = settlementQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  settlementQueue = previous.then(() => current);
  await previous;
  try {
    const existing = (await readRouteFeedback(root)).find((item) => routeFeedbackKey(item) === routeFeedbackKey(record));
    if (existing) return { created: false, record: existing };
    const settled: RouteFeedbackRecord = { ...record, timestamp: record.timestamp ?? new Date().toISOString() };
    await appendJsonl(routingFeedbackFile(root), settled);
    return { created: true, record: settled };
  } finally {
    release();
  }
}

/** Only a persisted failed settlement with a diagnosis can authorize a higher-tier retry. */
export function escalationFromRouteFeedback(
  feedback: RouteFeedbackRecord,
): NonNullable<RouteRequest["escalation"]> | undefined {
  if (feedback.outcome !== "failed" || !feedback.model || !validEscalationDiagnosis(feedback.diagnosis)) return undefined;
  return { previousModel: feedback.model, diagnosis: feedback.diagnosis };
}

export function validEscalationDiagnosis(value: unknown): value is EscalationDiagnosis {
  if (!value || typeof value !== "object") return false;
  const diagnosis = value as Partial<EscalationDiagnosis>;
  return typeof diagnosis.category === "string" && diagnosisCategories.has(diagnosis.category) && typeof diagnosis.reason === "string" && diagnosis.reason.trim().length > 0;
}

export interface MissingRouteFeedbackDiagnostic {
  terminalRoutes: number;
  feedbackRecords: number;
  missing: TerminalRouteAttempt[];
  duplicateFeedbackKeys: string[];
}

/** Report-only reconciliation for telemetry integrations; it does not mutate persisted feedback. */
export function diagnoseMissingRouteFeedback(
  terminalRoutes: TerminalRouteAttempt[],
  feedback: RouteFeedbackRecord[],
): MissingRouteFeedbackDiagnostic {
  const terminal = new Map(terminalRoutes.map((route) => [routeFeedbackKey(route), route]));
  const counts = new Map<string, number>();
  for (const item of feedback) counts.set(routeFeedbackKey(item), (counts.get(routeFeedbackKey(item)) ?? 0) + 1);
  return {
    terminalRoutes: terminal.size,
    feedbackRecords: feedback.length,
    missing: [...terminal].filter(([key]) => !counts.has(key)).map(([, route]) => route),
    duplicateFeedbackKeys: [...counts].filter(([, count]) => count > 1).map(([key]) => key),
  };
}

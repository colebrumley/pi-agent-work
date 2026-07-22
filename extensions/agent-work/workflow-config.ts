import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists, rootDir } from "./storage.ts";
import type { RetentionPolicyOverrides } from "./retention.ts";

export interface WorkflowConfig {
  schemaVersion: 1;
  review?: { cadence?: "adaptive" | "always-broad"; reuseEvidence?: boolean };
  routing?: { enabled?: boolean; allowEscalation?: boolean };
  liveness?: { inactivityMs?: number; hardTimeoutMs?: number };
  retention?: RetentionPolicyOverrides;
  cleanup?: { retainWorktree?: boolean };
}

export type WorkflowOverrides = Omit<WorkflowConfig, "schemaVersion">;
export function workflowConfigPath(root: string): string { return join(rootDir(root), "workflow.json"); }

function validateNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`workflow config ${name} must be a positive integer`);
  return value as number;
}
function validateBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`workflow config ${name} must be a boolean`);
  return value;
}
export function validateWorkflowConfig(raw: unknown): WorkflowConfig {
  if (!raw || typeof raw !== "object") throw new Error("workflow config must be an object");
  const value = raw as WorkflowConfig;
  if (value.schemaVersion !== 1) throw new Error("workflow config schemaVersion must be 1");
  if (value.review?.cadence !== undefined && value.review.cadence !== "adaptive" && value.review.cadence !== "always-broad") throw new Error("workflow config review.cadence must be adaptive or always-broad");
  validateBoolean(value.review?.reuseEvidence, "review.reuseEvidence");
  validateBoolean(value.routing?.enabled, "routing.enabled"); validateBoolean(value.routing?.allowEscalation, "routing.allowEscalation");
  validateNumber(value.liveness?.inactivityMs, "liveness.inactivityMs"); validateNumber(value.liveness?.hardTimeoutMs, "liveness.hardTimeoutMs");
  if (value.retention) {
    if (value.retention.failureRetentionDays !== undefined && (!Number.isInteger(value.retention.failureRetentionDays) || value.retention.failureRetentionDays < 0 || value.retention.failureRetentionDays > 3650)) throw new Error("workflow config retention.failureRetentionDays must be an integer between 0 and 3650");
    validateBoolean(value.retention.compaction, "retention.compaction");
  }
  validateBoolean(value.cleanup?.retainWorktree, "cleanup.retainWorktree");
  return value;
}
export async function loadWorkflowConfig(root: string, override: WorkflowOverrides = {}): Promise<WorkflowConfig> {
  const path = workflowConfigPath(root);
  const repository = await exists(path) ? validateWorkflowConfig(JSON.parse(await readFile(path, "utf8"))) : { schemaVersion: 1 };
  return validateWorkflowConfig({ ...repository, ...override, schemaVersion: 1, review: { ...repository.review, ...override.review }, routing: { ...repository.routing, ...override.routing }, liveness: { ...repository.liveness, ...override.liveness }, retention: { ...repository.retention, ...override.retention }, cleanup: { ...repository.cleanup, ...override.cleanup } });
}

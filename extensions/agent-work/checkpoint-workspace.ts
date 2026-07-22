import { resolve } from "node:path";

export interface CheckpointWorkspaceMetadata {
  schemaVersion: 1;
  worktree: string;
  branch: string;
  baseCommit: string;
}

export function checkpointWorkspaceMetadataIssues(
  metadata: CheckpointWorkspaceMetadata,
  expected: { worktree: string; branch: string },
  actual?: { worktree: string; branch: string },
): string[] {
  const issues: string[] = [];
  if (metadata.schemaVersion !== 1) issues.push("unsupported checkpoint workspace metadata schema");
  if (resolve(metadata.worktree) !== resolve(expected.worktree) || metadata.branch !== expected.branch) issues.push("checkpoint workspace metadata does not match the declared run/checkpoint identity");
  if (!/^[0-9a-f]{40,64}$/i.test(metadata.baseCommit)) issues.push("checkpoint workspace base commit is invalid");
  if (actual && (resolve(actual.worktree) !== resolve(metadata.worktree) || actual.branch !== metadata.branch)) issues.push("persisted checkpoint workspace identity does not match Git");
  return issues;
}

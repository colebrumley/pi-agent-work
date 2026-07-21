import type { RequirementsState } from "../../requirements/src/types.ts";
import type { ChangedSurface, ConsolidatedFinding } from "./review-lifecycle.ts";

export type PromptSliceRole = "builder" | "broad-reviewer" | "focused-reviewer" | "final-gate";

export interface PromptSliceRequest {
  role: PromptSliceRole;
  sourcePath: string;
  sourceHash: string;
  requirementIds: string[];
  criterionIds: string[];
  boundaryIds?: string[];
  findings?: ConsolidatedFinding[];
  changedSurface?: ChangedSurface;
  checks?: string[];
}

export interface PromptSlice {
  role: PromptSliceRole;
  requirementsRevision: string;
  sourcePath: string;
  sourceHash: string;
  requirements: Array<{ id: string; text: string }>;
  criteria: Array<{ id: string; criterion: string }>;
  boundaries: Array<{ id: string; text: string }>;
  findings: ConsolidatedFinding[];
  changedSurface?: ChangedSurface;
  checks: string[];
}

export function createPromptSlice(requirements: RequirementsState, request: PromptSliceRequest): PromptSlice {
  const ids = new Set(request.requirementIds);
  const criterionIds = new Set(request.criterionIds);
  const boundaryIds = new Set(request.boundaryIds ?? []);
  return {
    role: request.role,
    requirementsRevision: requirements.requirementsRevision,
    sourcePath: request.sourcePath,
    sourceHash: request.sourceHash,
    requirements: requirements.functionalRequirements.filter((item) => ids.has(item.id)).map(({ id, text }) => ({ id, text })),
    criteria: requirements.acceptanceCriteria.filter((item) => criterionIds.has(item.id) || (item.linkedRequirement && ids.has(item.linkedRequirement))).map(({ id, criterion }) => ({ id, criterion })),
    boundaries: [...requirements.constraints, ...requirements.nonGoals]
      .filter((item) => boundaryIds.has(item.id)).map(({ id, text }) => ({ id, text })),
    findings: structuredClone(request.findings ?? []),
    changedSurface: request.changedSurface && structuredClone(request.changedSurface),
    checks: [...new Set(request.checks ?? [])],
  };
}

export function renderPromptSlice(slice: PromptSlice): string {
  return JSON.stringify(slice, null, 2);
}

import { createHash } from "node:crypto";

export type ReviewMode = "broad" | "focused" | "final-gate" | "none";
export type ChangedSurfaceKind = "architecture" | "trust-security-boundary" | "public-contract" | "acceptance-scope";

export interface ChangedSurface {
  files: string[];
  affectedRequirementIds: string[];
  kinds: ChangedSurfaceKind[];
}

export interface ReviewFinding {
  id?: string;
  severity: "critical" | "high" | "medium" | "low";
  location: string;
  description: string;
  status?: "open" | "resolved" | "false-positive";
  sourceReviewId: string;
}

export interface ConsolidatedFinding extends Required<Omit<ReviewFinding, "id" | "status">> {
  id: string;
  status: "open" | "resolved" | "false-positive";
  firstSeenCommit: string;
  lastSeenCommit: string;
  reviewIds: string[];
}

export interface ReviewLifecycleState {
  requirementsRevision: string;
  broadReviews: number;
  findings: ConsolidatedFinding[];
}

export interface ReviewRequest {
  phase: "initial" | "amendment" | "final";
  requirementsRevision: string;
  commit: string;
  highRisk: boolean;
  changedSurface?: ChangedSurface;
  explicitBroad?: boolean;
}

export interface ReviewPlan {
  mode: ReviewMode;
  panel: boolean;
  reason: string;
  findingsToVerify: string[];
  changedSurface?: ChangedSurface;
}

export function classifyChangedSurface(input: {
  files: string[];
  affectedRequirementIds?: string[];
  architectureChanged?: boolean;
  trustSecurityBoundaryChanged?: boolean;
  publicContractChanged?: boolean;
  acceptanceScopeExpanded?: boolean;
}): ChangedSurface {
  const kinds: ChangedSurfaceKind[] = [];
  if (input.architectureChanged) kinds.push("architecture");
  if (input.trustSecurityBoundaryChanged) kinds.push("trust-security-boundary");
  if (input.publicContractChanged) kinds.push("public-contract");
  if (input.acceptanceScopeExpanded) kinds.push("acceptance-scope");
  return {
    files: [...new Set(input.files)].sort(),
    affectedRequirementIds: [...new Set(input.affectedRequirementIds ?? [])].sort(),
    kinds,
  };
}

/** Conservative bounded-diff classifier. It never reads unrelated repository history. */
export function classifyChangedSurfaceFromDiff(input: { files: string[]; diff: string; affectedRequirementIds?: string[] }): ChangedSurface {
  const text = `${input.files.join("\n")}\n${input.diff}`.toLowerCase();
  return classifyChangedSurface({
    files: input.files,
    affectedRequirementIds: input.affectedRequirementIds,
    architectureChanged: /(^|\n)(src|extensions|lib)\/.*(router|lifecycle|storage|schema|migration|architecture)|\b(architecture|migration|concurrency|persistence)\b/.test(text),
    trustSecurityBoundaryChanged: /\b(auth|authoriz|permission|credential|secret|token|security|trust.boundary)\b/.test(text),
    publicContractChanged: /\b(public|export|api|endpoint|contract|schema|cli|registertool|parameters)\b/.test(text),
    acceptanceScopeExpanded: /\b(acceptance|acceptancecriteria|acceptancetests|at-[a-z0-9_-]+)\b/.test(text),
  });
}

export function reviewPlan(state: ReviewLifecycleState, request: ReviewRequest): ReviewPlan {
  if (state.requirementsRevision !== request.requirementsRevision) throw new Error("review lifecycle requirements revision mismatch");
  if (request.phase === "final") {
    return {
      mode: request.highRisk ? "final-gate" : "none",
      panel: false,
      reason: request.highRisk ? "high-risk exact-current release gate" : "final gate is only required for high-risk work",
      findingsToVerify: state.findings.filter((finding) => finding.status === "open").map((finding) => finding.id),
      changedSurface: request.changedSurface,
    };
  }
  if (request.phase === "initial") {
    return { mode: "broad", panel: true, reason: "initial independent adversarial review", findingsToVerify: [] };
  }
  const expandsRisk = Boolean(request.changedSurface?.kinds.length);
  if (request.explicitBroad || (expandsRisk && state.broadReviews < 2)) {
    return {
      mode: "broad", panel: true,
      reason: request.explicitBroad ? "operator requested broad review" : "amendment expands risk surface",
      findingsToVerify: state.findings.filter((finding) => finding.status === "open").map((finding) => finding.id),
      changedSurface: request.changedSurface,
    };
  }
  return {
    mode: "focused", panel: false,
    reason: expandsRisk ? "risk-expansion broad rerun already scheduled" : "amendment is limited to the existing risk surface",
    findingsToVerify: state.findings.filter((finding) => finding.status === "open").map((finding) => finding.id),
    changedSurface: request.changedSurface,
  };
}

function findingId(finding: ReviewFinding): string {
  return `finding:${createHash("sha256").update(`${finding.location}\n${finding.description.trim().toLowerCase()}`).digest("hex").slice(0, 16)}`;
}

export function consolidateFindings(
  state: ReviewLifecycleState,
  commit: string,
  findings: ReviewFinding[],
): ReviewLifecycleState {
  const existing = new Map(state.findings.map((finding) => [finding.id, structuredClone(finding)]));
  for (const finding of findings) {
    const id = finding.id ?? findingId(finding);
    const prior = existing.get(id);
    existing.set(id, prior
      ? { ...prior, severity: finding.severity, status: finding.status ?? prior.status, lastSeenCommit: commit, reviewIds: [...new Set([...prior.reviewIds, finding.sourceReviewId])].sort() }
      : { id, severity: finding.severity, location: finding.location, description: finding.description, sourceReviewId: finding.sourceReviewId, status: finding.status ?? "open", firstSeenCommit: commit, lastSeenCommit: commit, reviewIds: [finding.sourceReviewId] });
  }
  return {
    ...state,
    findings: [...existing.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Applies a completed plan without inferring lifecycle transitions from agent-supplied labels. */
export function recordReviewCompletion(
  state: ReviewLifecycleState,
  plan: ReviewPlan,
  commit: string,
  findings: ReviewFinding[],
): ReviewLifecycleState {
  const consolidated = consolidateFindings(state, commit, findings);
  return { ...consolidated, broadReviews: consolidated.broadReviews + (plan.mode === "broad" ? 1 : 0) };
}

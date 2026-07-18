/**
 * Deterministic validator.
 *
 * Two layers:
 *   1. Structural / schema check  -> `validateSchema`  (shape, enums, unique ids)
 *   2. Completeness + integrity   -> `validateRequirements` (tier rules, links)
 *
 * `errors` block a handoff. `warnings` are advisory. Handoff is gated on
 * `report.handoffReady` (no errors AND no unresolved blockers).
 *
 * The JSON Schema in requirements.schema.json is the canonical external
 * contract; `validateSchema` is a dependency-free mirror so the CLI can refuse
 * to emit a handoff from invalid state without any third-party validator.
 */

import type {
  RequirementsState,
  Tier,
  DecisionStatus,
  DecisionSource,
  Confidence,
  QuestionBlocking,
  QuestionStatus,
  AssumptionStatus,
  Testability,
  Priority,
} from "./types.ts";
import { TIERS } from "./types.ts";

export interface Issue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean; // no schema/structural errors and no completeness errors
  handoffReady: boolean; // valid AND no unresolved blockers
  tier: Tier;
  errors: Issue[];
  warnings: Issue[];
  blockers: Issue[]; // unresolved items that must be cleared before handoff
}

// Which collections each tier requires to be non-empty.
const REQUIRED_COLLECTIONS: Record<Tier, string[]> = {
  tiny: [],
  small: ["goals", "nonGoals", "acceptanceCriteria"],
  medium: [
    "goals",
    "nonGoals",
    "acceptanceCriteria",
    "actors",
    "userJourneys",
    "constraints",
    "functionalRequirements",
  ],
  large: [
    "goals",
    "nonGoals",
    "acceptanceCriteria",
    "actors",
    "userJourneys",
    "constraints",
    "functionalRequirements",
    "risks",
  ],
  epic: [
    "goals",
    "nonGoals",
    "acceptanceCriteria",
    "actors",
    "userJourneys",
    "constraints",
    "functionalRequirements",
    "risks",
    "dependencies",
  ],
};

// Tiers that require explicit treatment of the operational sections.
const REQUIRE_OP_SECTIONS: Tier[] = ["large", "epic"];
const REQUIRE_RISK_REVIEW: Tier[] = ["large", "epic"];
const REQUIRE_ROLLOUT_PHASES: Tier[] = ["epic"];

const LABELS: Record<string, string> = {
  goals: "goal",
  nonGoals: "non-goal",
  acceptanceCriteria: "acceptance criterion",
  actors: "actor",
  userJourneys: "user journey",
  constraints: "constraint",
  functionalRequirements: "functional requirement",
  risks: "risk",
  dependencies: "dependency",
};

function err(code: string, message: string, path?: string): Issue {
  return { code, severity: "error", message, path };
}
function warn(code: string, message: string, path?: string): Issue {
  return { code, severity: "warning", message, path };
}

// ---------------------------------------------------------------------------
// Layer 1: structural / schema validation (dependency-free)
// ---------------------------------------------------------------------------

const ENUMS = {
  decisionStatus: ["proposed", "confirmed", "rejected", "deferred"],
  decisionSource: ["user", "interviewer", "inferred", "existing-doc"],
  confidence: ["low", "medium", "high"],
  questionBlocking: ["blocking", "non-blocking", "optional"],
  questionStatus: ["open", "answered", "deferred", "accepted-risk"],
  assumptionStatus: ["proposed", "confirmed", "rejected", "accepted-risk"],
  testability: ["testable", "manual", "unclear"],
  priority: ["must", "should", "could"],
  riskLikelihood: ["low", "medium", "high"],
  riskImpact: ["low", "medium", "high"],
  riskStatus: ["open", "mitigated", "accepted"],
  constraintKind: ["technical", "business", "legal", "ux", "other"],
  dependencyKind: ["internal", "external", "team", "service", "data", "other"],
  dependencyStatus: ["available", "pending", "at-risk", "unknown"],
};

function checkEnum(
  issues: Issue[],
  value: unknown,
  allowed: string[],
  path: string
) {
  if (!allowed.includes(value as string))
    issues.push(
      err("schema.enum", `Invalid value "${value}" (allowed: ${allowed.join(", ")})`, path)
    );
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const isStrArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Push a schema.field error when a required field check fails. */
function checkField(issues: Issue[], ok: boolean, path: string, msg: string) {
  if (!ok) issues.push(err("schema.field", `${path}: ${msg}`, path));
}

export function validateSchema(state: any): Issue[] {
  const issues: Issue[] = [];
  const req = (cond: boolean, code: string, msg: string, path?: string) => {
    if (!cond) issues.push(err(code, msg, path));
  };

  req(typeof state === "object" && state !== null, "schema.root", "State must be an object");
  if (issues.length) return issues;

  req(typeof state.featureName === "string", "schema.featureName", "featureName must be a string");
  req(typeof state.problemStatement === "string", "schema.problemStatement", "problemStatement must be a string");
  req(TIERS.includes(state.tier), "schema.tier", `tier must be one of ${TIERS.join(", ")}`);

  // Unique id check across each collection.
  const collections = [
    "goals", "nonGoals", "actors", "userJourneys", "functionalRequirements",
    "nonFunctionalRequirements", "constraints", "assumptions", "risks",
    "openQuestions", "acceptanceCriteria", "outOfScope", "dependencies", "decisions",
  ];
  for (const key of collections) {
    const list = state[key];
    if (!Array.isArray(list)) {
      issues.push(err("schema.array", `${key} must be an array`, key));
      continue;
    }
    const seen = new Set<string>();
    list.forEach((item: any, i: number) => {
      if (!item || typeof item.id !== "string")
        issues.push(err("schema.id", `${key}[${i}] missing string id`, `${key}[${i}]`));
      else if (seen.has(item.id))
        issues.push(err("schema.dupId", `Duplicate id "${item.id}" in ${key}`, `${key}`));
      else seen.add(item.id);
    });
  }

  // Per-collection required fields + enums. These mirror requirements.schema.json
  // so malformed-but-id-bearing items are rejected at `apply` instead of
  // crashing renderers or reaching the builder handoff.
  for (const key of ["goals", "nonGoals", "outOfScope"]) {
    (state[key] ?? []).forEach((g: any, i: number) =>
      checkField(issues, isStr(g?.text), `${key}[${i}].text`, "must be a string")
    );
  }
  (state.actors ?? []).forEach((a: any, i: number) =>
    checkField(issues, isStr(a?.name), `actors[${i}].name`, "must be a string")
  );
  (state.userJourneys ?? []).forEach((j: any, i: number) => {
    checkField(issues, isStr(j?.name), `userJourneys[${i}].name`, "must be a string");
    checkField(issues, isStrArray(j?.steps), `userJourneys[${i}].steps`, "must be an array of strings");
  });
  for (const key of ["functionalRequirements", "nonFunctionalRequirements"]) {
    (state[key] ?? []).forEach((r: any, i: number) => {
      checkField(issues, isStr(r?.text), `${key}[${i}].text`, "must be a string");
      checkEnum(issues, r?.priority, ENUMS.priority, `${key}[${i}].priority`);
    });
  }
  (state.constraints ?? []).forEach((c: any, i: number) => {
    checkField(issues, isStr(c?.text), `constraints[${i}].text`, "must be a string");
    if (c?.kind !== undefined) checkEnum(issues, c.kind, ENUMS.constraintKind, `constraints[${i}].kind`);
  });
  (state.assumptions ?? []).forEach((a: any, i: number) => {
    checkField(issues, isStr(a?.text), `assumptions[${i}].text`, "must be a string");
    checkEnum(issues, a.status, ENUMS.assumptionStatus, `assumptions[${i}].status`);
  });
  (state.risks ?? []).forEach((r: any, i: number) => {
    checkField(issues, isStr(r?.text), `risks[${i}].text`, "must be a string");
    checkEnum(issues, r?.likelihood, ENUMS.riskLikelihood, `risks[${i}].likelihood`);
    checkEnum(issues, r?.impact, ENUMS.riskImpact, `risks[${i}].impact`);
    checkEnum(issues, r?.status, ENUMS.riskStatus, `risks[${i}].status`);
  });
  (state.openQuestions ?? []).forEach((q: any, i: number) => {
    checkField(issues, isStr(q?.question), `openQuestions[${i}].question`, "must be a string");
    checkField(issues, isStr(q?.category), `openQuestions[${i}].category`, "must be a string");
    checkField(issues, isStr(q?.whyItMatters), `openQuestions[${i}].whyItMatters`, "must be a string");
    checkEnum(issues, q.blocking, ENUMS.questionBlocking, `openQuestions[${i}].blocking`);
    checkEnum(issues, q.status, ENUMS.questionStatus, `openQuestions[${i}].status`);
  });
  (state.acceptanceCriteria ?? []).forEach((c: any, i: number) => {
    checkField(issues, isStr(c?.criterion), `acceptanceCriteria[${i}].criterion`, "must be a string");
    checkEnum(issues, c.testability, ENUMS.testability, `acceptanceCriteria[${i}].testability`);
    checkEnum(issues, c.priority, ENUMS.priority, `acceptanceCriteria[${i}].priority`);
  });
  (state.dependencies ?? []).forEach((d: any, i: number) => {
    checkField(issues, isStr(d?.name), `dependencies[${i}].name`, "must be a string");
    checkEnum(issues, d?.kind, ENUMS.dependencyKind, `dependencies[${i}].kind`);
    checkEnum(issues, d?.status, ENUMS.dependencyStatus, `dependencies[${i}].status`);
  });
  (state.decisions ?? []).forEach((d: any, i: number) => {
    checkField(issues, isStr(d?.decision), `decisions[${i}].decision`, "must be a string");
    checkField(issues, isStrArray(d?.alternatives), `decisions[${i}].alternatives`, "must be an array of strings");
    checkField(issues, isStrArray(d?.relatedRequirements), `decisions[${i}].relatedRequirements`, "must be an array of strings");
    checkEnum(issues, d.status, ENUMS.decisionStatus, `decisions[${i}].status`);
    checkEnum(issues, d.source, ENUMS.decisionSource, `decisions[${i}].source`);
    checkEnum(issues, d.confidence, ENUMS.confidence, `decisions[${i}].confidence`);
  });

  // riskReviews has no id (not in `collections`); validate its shape here so an
  // empty `{}` cannot satisfy the large/epic risk-review gate.
  if (!Array.isArray(state.riskReviews)) {
    issues.push(err("schema.array", "riskReviews must be an array", "riskReviews"));
  } else {
    state.riskReviews.forEach((r: any, i: number) => {
      checkField(issues, isNonEmptyStr(r?.reviewer), `riskReviews[${i}].reviewer`, "must be a non-empty string");
      checkField(issues, isNonEmptyStr(r?.summary), `riskReviews[${i}].summary`, "must be a non-empty string");
    });
  }

  for (const sec of ["rollout", "observability", "security", "operational"]) {
    const s = state[sec];
    if (typeof s !== "object" || s === null || typeof s.applicable !== "boolean")
      issues.push(err("schema.section", `${sec} must be an object with boolean "applicable"`, sec));
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Layer 2: completeness + integrity
// ---------------------------------------------------------------------------

export function validateRequirements(state: RequirementsState): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const blockers: Issue[] = [];

  // Structural errors first — if shape is broken, stop here.
  const schemaIssues = validateSchema(state);
  if (schemaIssues.length) {
    return {
      valid: false,
      handoffReady: false,
      tier: (state.tier as Tier) ?? "small",
      errors: schemaIssues,
      warnings,
      blockers,
    };
  }

  const tier = state.tier;

  // --- core fields ---
  if (!state.featureName.trim())
    errors.push(err("core.featureName", "featureName is required"));
  if (tier !== "tiny" && !state.problemStatement.trim())
    errors.push(err("core.problemStatement", "problemStatement is required for non-tiny features"));

  // --- required collections per tier ---
  for (const key of REQUIRED_COLLECTIONS[tier]) {
    const list = (state as any)[key] as unknown[];
    if (!list || list.length === 0)
      errors.push(err("tier.required", `${tier} features require at least one ${LABELS[key] ?? key}`, key));
  }

  // --- acceptance criteria must map to a goal or requirement ---
  const goalIds = new Set(state.goals.map((g) => g.id));
  const reqIds = new Set([
    ...state.functionalRequirements.map((r) => r.id),
    ...state.nonFunctionalRequirements.map((r) => r.id),
  ]);
  for (const ac of state.acceptanceCriteria) {
    const hasGoal = ac.linkedGoal && goalIds.has(ac.linkedGoal);
    const hasReq = ac.linkedRequirement && reqIds.has(ac.linkedRequirement);
    if (!hasGoal && !hasReq)
      errors.push(err("ac.unmapped", `Acceptance criterion "${ac.id}" must link to an existing goal or requirement`, ac.id));
    if (ac.testability === "unclear")
      warnings.push(warn("ac.testability", `Acceptance criterion "${ac.id}" has unclear testability`, ac.id));
  }

  // --- every confirmed decision must have rationale ---
  for (const d of state.decisions) {
    if (d.status === "confirmed" && !d.rationale?.trim())
      errors.push(err("decision.rationale", `Confirmed decision "${d.id}" must have a rationale`, d.id));
    if (d.status === "confirmed" && d.alternatives.length === 0)
      warnings.push(warn("decision.alternatives", `Confirmed decision "${d.id}" records no alternatives considered`, d.id));
    // referential integrity for related requirements
    for (const rid of d.relatedRequirements) {
      if (!goalIds.has(rid) && !reqIds.has(rid))
        warnings.push(warn("decision.relatedRef", `Decision "${d.id}" references unknown id "${rid}"`, d.id));
    }
  }

  // --- assumptions must be resolved (confirmed / rejected / accepted-risk) ---
  for (const a of state.assumptions) {
    if (a.status === "proposed") {
      const issue = warn("assumption.unresolved", `Assumption "${a.id}" is still proposed — confirm, reject, or accept as risk`, a.id);
      warnings.push(issue);
      blockers.push(issue);
    }
  }

  // --- blocking open questions must be answered / deferred / accepted-risk ---
  for (const q of state.openQuestions) {
    if (q.blocking === "blocking" && q.status === "open") {
      const issue = err("question.blocking", `Blocking question "${q.id}" is unanswered: ${q.question}`, q.id);
      blockers.push(issue);
      // not pushed to errors: it blocks handoff but state can still be "valid" mid-interview
    }
    if (q.linked) {
      const known =
        goalIds.has(q.linked) || reqIds.has(q.linked) ||
        state.decisions.some((d) => d.id === q.linked);
      if (!known)
        warnings.push(warn("question.linkRef", `Question "${q.id}" links unknown id "${q.linked}"`, q.id));
    }
  }

  // --- large/epic require at least one risk review ---
  if (REQUIRE_RISK_REVIEW.includes(tier) && state.riskReviews.length === 0)
    errors.push(err("risk.review", `${tier} features require at least one recorded risk review`, "riskReviews"));

  // --- operational sections must be non-empty OR explicitly not-applicable ---
  if (REQUIRE_OP_SECTIONS.includes(tier)) {
    for (const sec of ["security", "observability", "operational"] as const) {
      const s = state[sec];
      const empty = s.notes.length === 0;
      if (s.applicable && empty)
        errors.push(err("section.empty", `${sec} section is empty — add notes or mark applicable=false with a reason`, sec));
      if (!s.applicable && !s.notApplicableReason?.trim())
        errors.push(err("section.reason", `${sec} marked not applicable but missing notApplicableReason`, sec));
    }
  }

  // --- epic requires rollout phases ---
  if (REQUIRE_ROLLOUT_PHASES.includes(tier)) {
    const r = state.rollout;
    if (r.applicable && r.phases.length === 0)
      errors.push(err("rollout.phases", "epic features require phased delivery — add rollout phases or mark not applicable with a reason", "rollout"));
    if (!r.applicable && !r.notApplicableReason?.trim())
      errors.push(err("rollout.reason", "rollout marked not applicable but missing notApplicableReason", "rollout"));
  }

  const valid = errors.length === 0;
  const handoffReady = valid && blockers.length === 0;

  return { valid, handoffReady, tier, errors, warnings, blockers };
}

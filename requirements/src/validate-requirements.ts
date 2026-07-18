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
import { ADVERSARIAL_CATEGORIES, FIDELITY_LAYERS, READINESS_DOMAINS, TIERS } from "./types.ts";
import { requirementsRevision } from "./revision.ts";

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
    "openQuestions", "acceptanceCriteria", "acceptanceTests", "outOfScope", "dependencies", "decisions",
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
    if (q.answerSource !== undefined) checkEnum(issues, q.answerSource, ["user", "interviewer"], `openQuestions[${i}].answerSource`);
    for (const field of ["recommendation", "recommendationRationale", "answer", "acceptedRiskAssumption", "stopCondition"])
      if (q[field] !== undefined) checkField(issues, isStr(q[field]), `openQuestions[${i}].${field}`, "must be a string");
  });
  (state.acceptanceCriteria ?? []).forEach((c: any, i: number) => {
    checkField(issues, isStr(c?.criterion), `acceptanceCriteria[${i}].criterion`, "must be a string");
    checkEnum(issues, c.testability, ENUMS.testability, `acceptanceCriteria[${i}].testability`);
    checkEnum(issues, c.priority, ENUMS.priority, `acceptanceCriteria[${i}].priority`);
  });
  (state.acceptanceTests ?? []).forEach((t: any, i: number) => {
    for (const field of ["name", "setup", "action", "expectedResult", "linkedRequirement", "requiredEvidence"])
      checkField(issues, isNonEmptyStr(t?.[field]), `acceptanceTests[${i}].${field}`, "must be a non-empty string");
    checkEnum(issues, t?.fidelityLayer, [...FIDELITY_LAYERS], `acceptanceTests[${i}].fidelityLayer`);
    checkField(issues, Array.isArray(t?.categories) && t.categories.every((x: any) => ADVERSARIAL_CATEGORIES.includes(x)), `acceptanceTests[${i}].categories`, "must contain valid adversarial categories");
  });
  checkField(issues, state.schemaVersion === 2, "schemaVersion", "must be 2");
  checkField(issues, isNonEmptyStr(state.requirementsRevision), "requirementsRevision", "must be a non-empty content hash");
  checkField(issues, state.readiness && typeof state.readiness === "object", "readiness", "must be an object");
  checkEnum(issues, state.readiness?.buildableEndToEnd, ["yes", "no", "unanswered"], "readiness.buildableEndToEnd");
  checkField(issues, isStr(state.readiness?.rationale), "readiness.rationale", "must be a string");
  checkField(issues, isStr(state.readiness?.workingParameters), "readiness.workingParameters", "must be a string");
  checkField(issues, isStrArray(state.readiness?.assumptions), "readiness.assumptions", "must be an array of strings");
  checkField(issues, isStrArray(state.readiness?.stopConditions), "readiness.stopConditions", "must be an array of strings");
  checkField(issues, Array.isArray(state.readiness?.domains), "readiness.domains", "must be an array");
  (state.readiness?.domains ?? []).forEach((d: any, i: number) => {
    checkEnum(issues, d?.domain, [...READINESS_DOMAINS], `readiness.domains[${i}].domain`);
    checkEnum(issues, d?.status, ["resolved", "not-applicable", "open"], `readiness.domains[${i}].status`);
    checkField(issues, isStr(d?.rationale), `readiness.domains[${i}].rationale`, "must be a string");
  });
  checkField(issues, state.testingStandards && Array.isArray(state.testingStandards.fidelity) && Array.isArray(state.testingStandards.adversarial), "testingStandards", "must contain fidelity and adversarial arrays");
  for (const [field, names] of [["fidelity", FIDELITY_LAYERS], ["adversarial", ADVERSARIAL_CATEGORIES]] as const) {
    (state.testingStandards?.[field] ?? []).forEach((a: any, i: number) => {
      checkEnum(issues, a?.name, [...names], `testingStandards.${field}[${i}].name`);
      checkField(issues, typeof a?.applicable === "boolean", `testingStandards.${field}[${i}].applicable`, "must be a boolean");
      checkField(issues, isStr(a?.rationale), `testingStandards.${field}[${i}].rationale`, "must be a string");
    });
  }
  checkField(issues, Array.isArray(state.testExceptions), "testExceptions", "must be an array");
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
  if (state.requirementsRevision !== requirementsRevision(state))
    errors.push(err("revision.stale", "requirementsRevision does not match deterministic requirements content hash", "requirementsRevision"));

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

  // --- every material/open ambiguity remains blocking and visibly recommended ---
  for (const q of state.openQuestions) {
    if (q.status === "open" || q.status === "deferred") {
      const issue = err("question.unresolved", `Clarification "${q.id}" is unresolved: ${q.question}`, q.id);
      blockers.push(issue);
      if (!q.recommendation?.trim() || !q.recommendationRationale?.trim())
        errors.push(err("question.recommendation", `Open clarification "${q.id}" requires exactly one visible recommendation and rationale`, q.id));
    }
    if (q.status === "answered" && (!q.answer?.trim() || !["user", "interviewer"].includes(q.answerSource ?? "")))
      errors.push(err("question.answer", `Answered clarification "${q.id}" must record its answer and source`, q.id));
    if (q.status === "accepted-risk" && (!q.acceptedRiskAssumption?.trim() || !q.stopCondition?.trim()))
      errors.push(err("question.acceptedRisk", `Accepted risk "${q.id}" requires an explicit assumption and stop condition`, q.id));
    if (q.linked) {
      const known =
        goalIds.has(q.linked) || reqIds.has(q.linked) ||
        state.decisions.some((d) => d.id === q.linked);
      if (!known)
        warnings.push(warn("question.linkRef", `Question "${q.id}" links unknown id "${q.linked}"`, q.id));
    }
  }

  // --- explicit end-to-end semantic readiness gate (all tiers) ---
  const readiness = state.readiness;
  const domainMap = new Map(readiness.domains.map((d) => [d.domain, d]));
  if (domainMap.size !== readiness.domains.length)
    errors.push(err("readiness.domainDuplicate", "Each readiness domain must appear exactly once", "readiness.domains"));
  for (const domain of READINESS_DOMAINS) {
    const item = domainMap.get(domain);
    if (!item || item.status === "open" || !item.rationale?.trim())
      blockers.push(err("readiness.domain", `Readiness domain "${domain}" must be resolved or not applicable with rationale`, `readiness.${domain}`));
  }
  if (!readiness.workingParameters?.trim())
    blockers.push(err("readiness.parameters", "Readiness must define builder working parameters", "readiness.workingParameters"));
  if (!readiness.rationale?.trim())
    blockers.push(err("readiness.rationale", "Readiness answer requires rationale", "readiness.rationale"));
  if (!readiness.stopConditions.length || readiness.stopConditions.some((x) => !x.trim()))
    blockers.push(err("readiness.stopConditions", "Readiness must list explicit bailout stop conditions", "readiness.stopConditions"));

  const optOut = state.readinessOptOut;
  let optOutValid = false;
  if (optOut) {
    if (!(["tiny", "small"] as Tier[]).includes(tier))
      errors.push(err("readiness.optOutTier", `Readiness opt-out is unavailable for ${tier} features`, "readinessOptOut"));
    else if (!optOut.requestedByUser || !optOut.approvedBy?.trim() || !optOut.requestText?.trim())
      errors.push(err("readiness.optOutApproval", "Tiny/small opt-out requires an explicit user request and named approver", "readinessOptOut"));
    else if (optOut.choices.some((c) => !c.questionId?.trim() || !c.answer?.trim() || !c.rationale?.trim()))
      errors.push(err("readiness.optOutChoices", "Every opt-out choice requires question, answer, and rationale", "readinessOptOut.choices"));
    else if (optOut.choices.some((c) => !state.openQuestions.some((q) => q.id === c.questionId && q.status === "answered" && q.answerSource === "interviewer" && q.answer === c.answer)) ||
             state.openQuestions.some((q) => q.answerSource === "interviewer" && !optOut.choices.some((c) => c.questionId === q.id && c.answer === q.answer)))
      errors.push(err("readiness.optOutDisclosure", "Every and only interviewer-selected answers must be disclosed in opt-out choices", "readinessOptOut.choices"));
    else optOutValid = true;
  }
  if (!optOutValid && readiness.buildableEndToEnd !== "yes")
    blockers.push(err("readiness.attestation", "Can this specification be built end to end as-is without further clarification or inventing requirements? Answer must be unambiguously yes", "readiness.buildableEndToEnd"));
  if (!optOutValid) {
    for (const q of state.openQuestions) {
      if (q.status === "answered" && q.answerSource === "interviewer")
        errors.push(err("question.silentAdoption", `Interviewer answer "${q.id}" requires explicit user acceptance`, q.id));
    }
    for (const d of state.decisions) {
      if (d.status === "confirmed" && d.source === "interviewer")
        errors.push(err("decision.silentAdoption", `Interviewer recommendation "${d.id}" cannot be confirmed without user acceptance`, d.id));
    }
  }

  // --- executable acceptance contract and ordered fidelity/adversarial assessments ---
  for (const q of state.openQuestions.filter((item) => item.status === "accepted-risk")) {
    if (!readiness.assumptions.includes(q.acceptedRiskAssumption!) || !readiness.stopConditions.includes(q.stopCondition!))
      errors.push(err("readiness.acceptedRisk", `Accepted risk "${q.id}" must be listed in readiness assumptions and stop conditions`, q.id));
  }
  if (state.acceptanceTests.length === 0)
    errors.push(err("tests.required", "At least one structured acceptance test is required at every tier", "acceptanceTests"));
  const linkIds = new Set([...goalIds, ...reqIds, ...state.acceptanceCriteria.map((x) => x.id)]);
  for (const test of state.acceptanceTests) {
    if (!linkIds.has(test.linkedRequirement))
      errors.push(err("tests.link", `Acceptance test "${test.id}" links unknown requirement or criterion "${test.linkedRequirement}"`, test.id));
  }
  for (const [field, required] of [["fidelity", FIDELITY_LAYERS], ["adversarial", ADVERSARIAL_CATEGORIES]] as const) {
    const entries = state.testingStandards[field];
    const byName = new Map(entries.map((x) => [x.name, x]));
    if (byName.size !== entries.length) errors.push(err("tests.applicabilityDuplicate", `Testing ${field} entries must be unique`, `testingStandards.${field}`));
    for (const name of required) {
      const entry = byName.get(name as any);
      if (!entry || !entry.rationale?.trim())
        errors.push(err("tests.applicability", `Testing ${field} "${name}" requires an applicability rationale`, `testingStandards.${field}`));
    }
  }
  for (const category of state.testingStandards.adversarial.filter((item) => item.applicable).map((item) => item.name)) {
    if (!state.acceptanceTests.some((test) => test.categories.includes(category)))
      errors.push(err("tests.adversarialCoverage", `Applicable adversarial category "${category}" is not assigned to any acceptance test`, "acceptanceTests"));
  }
  for (const exception of state.testExceptions) {
    if (!state.acceptanceTests.some((t) => t.id === exception.testId) || !exception.reason?.trim() ||
        !exception.substituteVerification?.trim() || !exception.residualRisk?.trim() ||
        !exception.explicitUserApproval || !exception.approvedBy?.trim() ||
        exception.requirementsRevision !== state.requirementsRevision)
      errors.push(err("tests.exception", `Test exception for "${exception.testId}" is incomplete, unapproved, stale, or names no test`, "testExceptions"));
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

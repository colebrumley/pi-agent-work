/**
 * Canonical TypeScript model for the requirements state.
 *
 * This is the deterministic source of truth. The interviewer LLM proposes
 * changes as structured patches (see `apply` in state.ts); it never edits these
 * objects directly and never freewrites the rendered spec.
 *
 * Two files back this model:
 *   - requirements.json   -> everything except `decisions`
 *   - decision-log.json   -> `decisions` only (the decision log)
 * They are merged into a single in-memory `RequirementsState`.
 */

export type Tier = "tiny" | "small" | "medium" | "large" | "epic";

export const TIERS: Tier[] = ["tiny", "small", "medium", "large", "epic"];

export type DecisionStatus = "proposed" | "confirmed" | "rejected" | "deferred";
export type DecisionSource = "user" | "interviewer" | "inferred" | "existing-doc";
export type Confidence = "low" | "medium" | "high";

export type QuestionBlocking = "blocking" | "non-blocking" | "optional";
export type QuestionStatus = "open" | "answered" | "deferred" | "accepted-risk";

export type AssumptionStatus =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "accepted-risk";

export type Testability = "testable" | "manual" | "unclear";
export type Priority = "must" | "should" | "could";

export type RiskLikelihood = "low" | "medium" | "high";
export type RiskImpact = "low" | "medium" | "high";
export type RiskStatus = "open" | "mitigated" | "accepted";

export interface NamedItem {
  id: string;
  text: string;
}

export interface Actor {
  id: string;
  name: string;
  description?: string;
}

export interface UserJourney {
  id: string;
  name: string;
  actor?: string; // Actor id
  steps: string[];
}

export interface Requirement {
  id: string;
  text: string;
  priority: Priority;
  rationale?: string;
}

export interface Constraint {
  id: string;
  text: string;
  kind?: "technical" | "business" | "legal" | "ux" | "other";
}

export interface Assumption {
  id: string;
  text: string;
  status: AssumptionStatus;
  rationale?: string;
}

export interface Decision {
  id: string;
  decision: string;
  status: DecisionStatus;
  rationale?: string;
  alternatives: string[]; // rejected / considered options, captured explicitly
  source: DecisionSource;
  confidence: Confidence;
  relatedRequirements: string[]; // Requirement / goal ids
  sequence: number; // monotonic, assigned by the store
  timestamp: string; // ISO-8601, assigned by the store
}

export interface Risk {
  id: string;
  text: string;
  likelihood: RiskLikelihood;
  impact: RiskImpact;
  mitigation?: string;
  status: RiskStatus;
}

export interface OpenQuestion {
  id: string;
  question: string;
  category: string;
  whyItMatters: string;
  blocking: QuestionBlocking;
  /** Exactly one visible recommendation; required while the question is open. */
  recommendation?: string;
  recommendationRationale?: string;
  possibleDefault?: string; // legacy alias, retained for v1 migration
  status: QuestionStatus;
  linked?: string; // linked decision or requirement id
  answer?: string;
  answerSource?: "user" | "interviewer";
  acceptedRiskAssumption?: string;
  stopCondition?: string;
}

export interface AcceptanceCriterion {
  id: string;
  criterion: string;
  linkedGoal?: string; // Goal id
  linkedRequirement?: string; // Requirement id
  testability: Testability;
  priority: Priority;
}

export const READINESS_DOMAINS = [
  "scope", "non-scope", "behavior", "ux", "errors", "edge-cases", "data",
  "integrations", "compatibility", "security", "operations", "rollout",
  "tests", "bailout-conditions",
] as const;
export type ReadinessDomain = (typeof READINESS_DOMAINS)[number];
export type DomainResolution = "resolved" | "not-applicable" | "open";

export interface ReadinessDomainAssessment {
  domain: ReadinessDomain;
  status: DomainResolution;
  rationale: string;
}

export interface ReadinessAssessment {
  buildableEndToEnd: "yes" | "no" | "unanswered";
  rationale: string;
  workingParameters: string;
  assumptions: string[];
  stopConditions: string[];
  domains: ReadinessDomainAssessment[];
  assessedBy?: string;
}

export interface ReadinessOptOutChoice {
  questionId: string;
  answer: string;
  rationale: string;
}

export interface ReadinessOptOut {
  requestedByUser: boolean;
  approvedBy: string;
  requestText: string;
  choices: ReadinessOptOutChoice[];
}

export const FIDELITY_LAYERS = ["real-end-to-end", "realistic-smoke", "integration", "unit", "static"] as const;
export type FidelityLayer = (typeof FIDELITY_LAYERS)[number];
export const ADVERSARIAL_CATEGORIES = ["happy-path", "boundaries", "malformed-input", "failure-recovery", "regression", "abuse"] as const;
export type AdversarialCategory = (typeof ADVERSARIAL_CATEGORIES)[number];

export interface ApplicabilityAssessment<T extends string> {
  name: T;
  applicable: boolean;
  rationale: string;
}

export interface AcceptanceTest {
  id: string;
  name: string;
  setup: string;
  action: string;
  expectedResult: string;
  fidelityLayer: FidelityLayer;
  linkedRequirement: string;
  requiredEvidence: string;
  categories: AdversarialCategory[];
}

export interface TestException {
  testId: string;
  reason: string;
  substituteVerification: string;
  residualRisk: string;
  approvedBy?: string;
  explicitUserApproval: boolean;
  requirementsRevision: string;
  /** Required for in-development approval; a later commit invalidates it. */
  implementationCommit?: string;
}

export interface TestingStandards {
  fidelity: ApplicabilityAssessment<FidelityLayer>[];
  adversarial: ApplicabilityAssessment<AdversarialCategory>[];
}

export interface Dependency {
  id: string;
  name: string;
  kind: "internal" | "external" | "team" | "service" | "data" | "other";
  status: "available" | "pending" | "at-risk" | "unknown";
  notes?: string;
}

/**
 * Sections that the validator may treat as "may be empty only if explicitly
 * marked not applicable". `applicable: false` requires a reason.
 */
export interface OptionalSection {
  applicable: boolean;
  notApplicableReason?: string;
  notes: string[];
}

export interface RolloutSection extends OptionalSection {
  phases: string[]; // phased delivery, for epic tier
}

export interface RiskReview {
  reviewedAt: string; // ISO-8601
  reviewer: string; // "user" | "interviewer" | a name
  summary: string;
}

export interface RequirementsState {
  schemaVersion: number;
  featureName: string;
  problemStatement: string;
  tier: Tier;

  goals: NamedItem[];
  nonGoals: NamedItem[];
  actors: Actor[];
  userJourneys: UserJourney[];
  functionalRequirements: Requirement[];
  nonFunctionalRequirements: Requirement[];
  constraints: Constraint[];
  assumptions: Assumption[];
  risks: Risk[];
  openQuestions: OpenQuestion[];
  acceptanceCriteria: AcceptanceCriterion[];
  acceptanceTests: AcceptanceTest[];
  testingStandards: TestingStandards;
  testExceptions: TestException[];
  readiness: ReadinessAssessment;
  readinessOptOut?: ReadinessOptOut;
  requirementsRevision: string;
  outOfScope: NamedItem[];
  dependencies: Dependency[];

  rollout: RolloutSection;
  observability: OptionalSection;
  security: OptionalSection;
  operational: OptionalSection;

  riskReviews: RiskReview[];
  handoffNotes: string[];

  // Decisions live in decision-log.json but are merged in here.
  decisions: Decision[];

  // Bookkeeping for deterministic id/sequence generation.
  meta: {
    createdAt: string;
    updatedAt: string;
    decisionSequence: number;
  };
}

export const SCHEMA_VERSION = 2;
